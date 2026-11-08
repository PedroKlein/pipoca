import { randomUUID } from "node:crypto";
import type {
  AgentSession,
  AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import type { Agent } from "./agents";
import {
  type Activity,
  type ChildState,
  type ChildView,
  cutOffWorkflow,
  type RunView,
  type Shape,
  type Workflow,
} from "./format";
import { runWorkflow, type WorkflowHost, type WorkflowStep } from "./workflow";

export interface Step {
  readonly agent: Agent;
  readonly task: string;
}

export interface Run {
  readonly id: string;
  // Settles once every child has ended, however it ended.
  readonly ended: Promise<RunView>;
}

interface Fleet {
  readonly start: (shape: Shape, steps: readonly Step[]) => Run;
  readonly startWorkflow: (
    workflow: Workflow,
    agents: readonly Agent[],
    state?: WorkflowHost["state"],
  ) => Run;
  // Carries on with a run's interrupted children, or undefined when it has
  // none (ADR 0058).
  readonly resume: (
    runId: string,
    agents: readonly Agent[],
    state?: WorkflowHost["state"],
  ) => Run | undefined;
  // Takes back the runs a restart left, already marked as it left them.
  readonly restore: (runs: readonly RunView[]) => void;
  readonly runs: () => readonly RunView[];
  readonly steer: (runId: string, text: string) => Promise<boolean>;
  readonly stop: (runId: string) => Promise<boolean>;
  // Leaves every run as it is, without recording more of it, so the next
  // start of the Session finds what was cut off.
  readonly close: () => void;
}

const activityKept = 30;
const textKept = 2000;

interface Child {
  readonly key?: string;
  readonly agentName: string;
  agent?: Agent;
  task: string;
  // Whether the task already has what it needs, such as a chain's previous
  // output.
  prepared: boolean;
  // Set while a resumed child carries on from its session file.
  continueFrom?: string;
  sessionFile?: string;
  state: ChildState;
  model?: string;
  startedAt?: number;
  endedAt?: number;
  tool?: string;
  toolCount: number;
  activity: Activity[];
  output?: string;
  error?: string;
  session?: AgentSession;
}

interface Running {
  readonly id: string;
  readonly shape: Shape;
  readonly startedAt: number;
  endedAt?: number;
  readonly children: Child[];
  readonly workflow?: Workflow;
  output?: string;
  error?: string;
  stopped?: boolean;
}

// Runs subagents as child sessions, at most `limit` at once in the Session
// (ADR 0057). Every change calls changed, so the caller can publish it.
export function fleet({
  startChild,
  changed,
  recorded,
  limit = 4,
  now,
}: {
  readonly startChild: (
    agent: Agent,
    continueFrom?: string,
  ) => Promise<AgentSession>;
  readonly changed: () => void;
  // Called when a run or one of its children starts or ends, to keep it.
  readonly recorded: (run: RunView) => void;
  readonly limit?: number;
  readonly now: () => number;
}): Fleet {
  const runs = new Map<string, Running>();
  const waiting: (() => void)[] = [];
  let busy = 0;

  const slot = async (): Promise<void> => {
    if (busy < limit) {
      busy += 1;

      return;
    }

    await new Promise<void>((resolve) => {
      waiting.push(resolve);
    });
  };

  const release = (): void => {
    const next = waiting.shift();
    if (next) {
      next();
    } else {
      busy -= 1;
    }
  };

  let closing = false;

  const record = (run: Running): void => {
    if (!closing) {
      recorded(view(run));
    }
  };

  // What the child ended as.
  const runChild = async (run: Running, child: Child): Promise<ChildState> => {
    await slot();

    try {
      if (child.state !== "queued") {
        return child.state;
      }

      if (child.agent === undefined) {
        child.state = "failed";
        child.error = `The agent ${child.agentName} no longer exists.`;

        return child.state;
      }

      child.state = "running";
      child.startedAt = now();
      changed();

      const session = await startChild(child.agent, child.continueFrom);
      const carriesOn = session.messages.length > 0;

      delete child.continueFrom;
      child.session = session;
      if (session.sessionFile !== undefined) {
        child.sessionFile = session.sessionFile;
      }

      if (session.model) {
        child.model = `${session.model.provider}/${session.model.id}`;
      }

      record(run);

      const unsubscribe = session.subscribe((event) => {
        follow(child, event);
        changed();
      });

      try {
        // A stop that came while the session was starting.
        if (!stopped(child)) {
          await session.prompt(carriesOn ? carryOn : child.task);
        }
      } finally {
        unsubscribe();

        // Extensions a child loaded close what they opened, such as an MCP
        // server's process.
        await session.extensionRunner
          .emit({ type: "session_shutdown", reason: "quit" })
          .catch(() => undefined);

        session.dispose();
      }

      finish(child, session);
    } catch (error) {
      if (child.state === "running") {
        child.state = "failed";
        child.error = error instanceof Error ? error.message : String(error);
      }
    } finally {
      delete child.session;
      delete child.tool;
      if (child.startedAt !== undefined) {
        child.endedAt ??= now();
      }

      release();
      record(run);
      changed();
    }

    return child.state;
  };

  // Runs a workflow's script from the start. A step whose key already ended
  // done gives its output again instead of running again.
  const script = async (
    run: Running,
    workflow: Workflow,
    agents: readonly Agent[],
    state: WorkflowHost["state"],
  ): Promise<void> => {
    const calls = new Map<string, number>();

    const keyOf = ({ key, agent }: WorkflowStep): string => {
      if (key !== undefined) {
        return key;
      }

      const count = (calls.get(agent) ?? 0) + 1;
      calls.set(agent, count);

      return `${agent}-${String(count)}`;
    };

    const step = async (asked: WorkflowStep): Promise<string> => {
      const key = keyOf(asked);
      let child = run.children.find((c) => c.key === key);

      if (child?.state === "done") {
        return child.output ?? "";
      }

      if (child?.state !== "queued") {
        const agent = agents.find(({ name }) => name === asked.agent);
        if (!agent) {
          throw new Error(
            `No agent named "${asked.agent}". The agents are: ${agents.map(({ name }) => name).join(", ")}.`,
          );
        }

        const fresh: Child = {
          key,
          agentName: agent.name,
          agent,
          task: asked.task,
          prepared: true,
          state: "queued",
          toolCount: 0,
          activity: [],
        };

        if (child === undefined) {
          run.children.push(fresh);
        } else {
          run.children.splice(run.children.indexOf(child), 1, fresh);
        }

        child = fresh;
        changed();
      }

      const ended = await runChild(run, child);
      if (ended !== "done") {
        throw new Error(
          `${key} ended ${ended}${child.error === undefined ? "" : `: ${child.error}`}`,
        );
      }

      return child.output ?? "";
    };

    const result = await runWorkflow(workflow.script, workflow.args, {
      run: step,
      steer: async (key, message) => {
        const { session } =
          run.children.find((c) => c.key === key && c.state === "running") ??
          {};

        await session?.steer(message);

        return session !== undefined;
      },
      stopped: () => run.stopped === true || closing,
      ...(state !== undefined && { state }),
    });

    if (closing) {
      return;
    }

    run.output = result.output;
    if (result.error !== undefined) {
      run.error = run.stopped === true ? "Stopped." : result.error;
    }
  };

  // Runs the run's queued children, in order for a chain.
  const drive = async (
    run: Running,
    agents: readonly Agent[] = [],
    state?: WorkflowHost["state"],
  ): Promise<RunView> => {
    if (run.workflow !== undefined) {
      await script(run, run.workflow, agents, state);
    } else if (run.shape === "chain") {
      let previous: string | undefined;

      for (const child of run.children) {
        if (child.state === "done") {
          previous = child.output ?? "";
          continue;
        }

        if (child.state !== "queued") {
          continue;
        }

        if (!child.prepared && previous !== undefined) {
          child.task = `${child.task}\n\nThe previous step's output:\n\n${previous}`;
        }

        child.prepared = true;

        if ((await runChild(run, child)) !== "done") {
          stopQueued(run);
          break;
        }

        previous = child.output ?? "";
      }
    } else {
      await Promise.all(
        run.children.map(async (child) => runChild(run, child)),
      );
    }

    run.endedAt = now();
    record(run);
    changed();

    return view(run);
  };

  const start = (shape: Shape, steps: readonly Step[]): Run => {
    const run: Running = {
      id: randomUUID(),
      shape,
      startedAt: now(),
      children: steps.map((step) => ({
        agentName: step.agent.name,
        agent: step.agent,
        task: step.task,
        prepared: shape !== "chain",
        state: "queued",
        toolCount: 0,
        activity: [],
      })),
    };

    runs.set(run.id, run);
    record(run);
    changed();

    return { id: run.id, ended: drive(run) };
  };

  const startWorkflow = (
    workflow: Workflow,
    agents: readonly Agent[],
    state?: WorkflowHost["state"],
  ): Run => {
    const run: Running = {
      id: randomUUID(),
      shape: "workflow",
      startedAt: now(),
      children: [],
      workflow,
    };

    runs.set(run.id, run);
    record(run);
    changed();

    return { id: run.id, ended: drive(run, agents, state) };
  };

  const resume = (
    runId: string,
    agents: readonly Agent[],
    missionState?: WorkflowHost["state"],
  ): Run | undefined => {
    const run = runs.get(runId);

    const cutOff = (run?.children ?? []).filter(
      ({ state }) => state === "interrupted",
    );

    if (
      run?.endedAt === undefined ||
      (cutOff.length === 0 && !cutOffWorkflow(view(run)))
    ) {
      return undefined;
    }

    for (const child of cutOff) {
      const agent = agents.find(({ name }) => name === child.agentName);
      const said = child.activity.findLast(({ kind }) => kind === "text");

      child.state = "queued";
      if (agent) {
        child.agent = agent;
      } else {
        delete child.agent;
      }

      if (child.sessionFile !== undefined) {
        child.continueFrom = child.sessionFile;
      }

      if (said !== undefined) {
        child.task = `${child.task}\n\nAn earlier attempt at this was cut off. What it had said so far:\n\n${said.text}`;
      }

      delete child.endedAt;
      delete child.error;
    }

    delete run.endedAt;
    record(run);
    changed();

    return { id: run.id, ended: drive(run, agents, missionState) };
  };

  const restore = (restored: readonly RunView[]): void => {
    for (const run of restored) {
      runs.set(run.id, {
        id: run.id,
        shape: run.shape,
        startedAt: run.startedAt,
        ...(run.endedAt !== undefined && { endedAt: run.endedAt }),
        ...(run.workflow !== undefined && { workflow: run.workflow }),
        ...(run.output !== undefined && { output: run.output }),
        ...(run.error !== undefined && { error: run.error }),
        children: run.children.map(({ agent, activity, ...child }): Child => ({
          ...child,
          agentName: agent,
          prepared: child.startedAt !== undefined || run.shape !== "chain",
          activity: [...activity],
        })),
      });
    }

    changed();
  };

  const stopQueued = (run: Running): void => {
    for (const child of run.children) {
      if (child.state === "queued") {
        child.state = "stopped";
      }
    }
  };

  const stop = async (runId: string): Promise<boolean> => {
    const run = runs.get(runId);
    if (!run || run.endedAt !== undefined) {
      return false;
    }

    run.stopped = true;
    stopQueued(run);

    const running = run.children.filter(({ state }) => state === "running");
    for (const child of running) {
      child.state = "stopped";
    }

    changed();

    await Promise.all(running.map(async ({ session }) => session?.abort()));

    return true;
  };

  return {
    start,
    startWorkflow,
    resume,
    restore,
    runs: () => [...runs.values()].map(view),
    // Reaches every child of the run that is running now.
    steer: async (runId, text) => {
      const running = (runs.get(runId)?.children ?? []).filter(
        (child) => child.state === "running" && child.session !== undefined,
      );

      await Promise.all(
        running.map(async ({ session }) => session?.steer(text)),
      );

      return running.length > 0;
    },
    stop,
    close: () => {
      closing = true;

      for (const run of runs.values()) {
        for (const { session } of run.children) {
          void session?.abort();
        }
      }
    },
  };
}

// What a resumed child is told when its session carries on from its file.
const carryOn =
  "You were cut off when the session you run in restarted. Carry on with your task from where you left off.";

// Read through a call: a stop changes the state while a child awaits.
function stopped(child: Child): boolean {
  return child.state === "stopped";
}

function follow(child: Child, event: AgentSessionEvent): void {
  if (event.type === "tool_execution_start") {
    child.tool = event.toolName;
    child.toolCount += 1;
    note(child, { kind: "tool", text: toolLine(event.toolName, event.args) });
  }

  if (event.type === "tool_execution_end") {
    delete child.tool;

    if (event.isError) {
      note(child, {
        kind: "tool",
        text: `${event.toolName} failed`,
        failed: true,
      });
    }
  }

  if (event.type === "message_end" && event.message.role === "assistant") {
    const text = textOf(event.message);
    if (text !== "") {
      note(child, { kind: "text", text });
    }
  }
}

function finish(child: Child, session: AgentSession): void {
  const reply = session.messages.findLast(
    (message) => message.role === "assistant",
  );

  if (child.state !== "running") {
    return;
  }

  if (reply?.role === "assistant" && reply.stopReason === "error") {
    child.state = "failed";
    child.error = reply.errorMessage ?? "the model answered with an error";

    return;
  }

  child.state =
    reply?.role === "assistant" && reply.stopReason === "aborted"
      ? "stopped"
      : "done";

  child.output = reply?.role === "assistant" ? textOf(reply) : "";
}

function note(child: Child, activity: Activity): void {
  child.activity.push({ ...activity, text: activity.text.slice(0, textKept) });
  child.activity.splice(0, Math.max(0, child.activity.length - activityKept));
}

function textOf(message: {
  readonly content: readonly {
    readonly type: string;
    readonly text?: string;
  }[];
}): string {
  return message.content
    .flatMap((part) =>
      part.type === "text" && part.text !== undefined ? [part.text] : [],
    )
    .join("")
    .trim();
}

function toolLine(name: string, args: unknown): string {
  const fields =
    typeof args === "object" && args !== null
      ? (args as Readonly<Record<string, unknown>>)
      : {};

  const first = ["path", "command", "pattern"]
    .map((key) => fields[key])
    .find((value) => typeof value === "string");

  return typeof first === "string"
    ? `${name} ${first.split("\n")[0] ?? ""}`
    : name;
}

function view(run: Running): RunView {
  return {
    id: run.id,
    shape: run.shape,
    startedAt: run.startedAt,
    ...(run.endedAt !== undefined && { endedAt: run.endedAt }),
    ...(run.workflow !== undefined && { workflow: run.workflow }),
    ...(run.output !== undefined && { output: run.output }),
    ...(run.error !== undefined && { error: run.error }),
    children: run.children.map((child): ChildView => ({
      ...(child.key !== undefined && { key: child.key }),
      agent: child.agentName,
      task: child.task,
      state: child.state,
      ...(child.model !== undefined && { model: child.model }),
      ...(child.startedAt !== undefined && { startedAt: child.startedAt }),
      ...(child.endedAt !== undefined && { endedAt: child.endedAt }),
      ...(child.tool !== undefined && { tool: child.tool }),
      toolCount: child.toolCount,
      activity: [...child.activity],
      ...(child.output !== undefined && { output: child.output }),
      ...(child.error !== undefined && { error: child.error }),
      ...(child.sessionFile !== undefined && {
        sessionFile: child.sessionFile,
      }),
    })),
  };
}
