import { randomUUID } from "node:crypto";
import type {
  AgentSession,
  AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import type { Agent } from "./agents";
import type { Activity, ChildState, ChildView, RunView, Shape } from "./format";

export interface Step {
  readonly agent: Agent;
  readonly task: string;
}

export interface Run {
  readonly id: string;
  // Settles once every child has ended, however it ended.
  readonly ended: Promise<RunView>;
}

export interface Fleet {
  readonly start: (shape: Shape, steps: readonly Step[]) => Run;
  readonly runs: () => readonly RunView[];
  readonly steer: (runId: string, text: string) => Promise<boolean>;
  readonly stop: (runId: string) => Promise<boolean>;
  readonly stopAll: () => void;
}

const activityKept = 30;
const textKept = 2000;

interface Child {
  readonly step: Step;
  task: string;
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
}

// Runs subagents as child sessions, at most `limit` at once in the Session
// (ADR 0057). Every change calls changed, so the caller can publish it.
export function fleet({
  startChild,
  changed,
  limit = 4,
  now = Date.now,
}: {
  readonly startChild: (agent: Agent) => Promise<AgentSession>;
  readonly changed: () => void;
  readonly limit?: number;
  readonly now?: () => number;
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

  // What the child ended as.
  const runChild = async (child: Child): Promise<ChildState> => {
    await slot();

    try {
      if (child.state !== "queued") {
        return child.state;
      }

      child.state = "running";
      child.startedAt = now();
      changed();

      const session = await startChild(child.step.agent);
      child.session = session;
      if (session.model) {
        child.model = `${session.model.provider}/${session.model.id}`;
      }

      const unsubscribe = session.subscribe((event) => {
        follow(child, event);
        changed();
      });

      try {
        // A stop that came while the session was starting.
        if (!stopped(child)) {
          await session.prompt(child.task);
        }
      } finally {
        unsubscribe();
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
      changed();
    }

    return child.state;
  };

  const start = (shape: Shape, steps: readonly Step[]): Run => {
    const run: Running = {
      id: randomUUID(),
      shape,
      startedAt: now(),
      children: steps.map((step) => ({
        step,
        task: step.task,
        state: "queued",
        toolCount: 0,
        activity: [],
      })),
    };

    runs.set(run.id, run);
    changed();

    const ended = (async () => {
      if (shape === "chain") {
        let previous: string | undefined;

        for (const child of run.children) {
          if (child.state !== "queued") {
            continue;
          }

          if (previous !== undefined) {
            child.task = `${child.step.task}\n\nThe previous step's output:\n\n${previous}`;
          }

          if ((await runChild(child)) !== "done") {
            stopQueued(run);
            break;
          }

          previous = child.output ?? "";
        }
      } else {
        await Promise.all(run.children.map(runChild));
      }

      run.endedAt = now();
      changed();

      return view(run);
    })();

    return { id: run.id, ended };
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
    stopAll: () => {
      for (const id of runs.keys()) {
        void stop(id);
      }
    },
  };
}

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
    children: run.children.map((child): ChildView => ({
      agent: child.step.agent.name,
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
    })),
  };
}
