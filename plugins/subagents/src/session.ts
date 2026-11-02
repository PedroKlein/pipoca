import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import {
  type SessionCloud,
  type SessionPlugin,
  type Static,
  Type,
} from "@pipoca/plugins";
import { noticeType } from "@pipoca/protocol";
import { type Agent, loadAgents } from "./agents";
import { fleet, type Run, type Step } from "./fleet";
import {
  finishedKind,
  interrupted,
  interruptedKind,
  manages,
  recordType,
  type RunView,
  runsKey,
  runState,
  type Shape,
  type Started,
} from "./format";
import { prompts } from "./prompts";
import { watchdog } from "./watchdog";

// Subagents as child sessions in the Session's process, on its model runtime
// and logins (ADR 0057).
export const subagents: SessionPlugin = {
  name: "subagents",
  extension: (cloud) => (pi) => {
    extension(cloud, pi);
    watchdog(cloud, pi);
  },
};

const publishMs = 250;

const stepSchema = Type.Object({
  agent: Type.String({ description: "The agent's name" }),
  task: Type.String({
    description: "Everything the agent needs: it doesn't see this conversation",
  }),
});

const parameters = Type.Object({
  agent: Type.Optional(Type.String({ description: "One run: the agent" })),
  task: Type.Optional(Type.String({ description: "One run: its task" })),
  tasks: Type.Optional(
    Type.Array(stepSchema, { description: "Parallel runs, all at once" }),
  ),
  chain: Type.Optional(
    Type.Array(stepSchema, {
      description:
        "Runs one after another, each given the previous one's output",
    }),
  ),
  wait: Type.Optional(
    Type.Boolean({
      description:
        "Wait for the runs to end instead of running them in the background",
    }),
  ),
  action: Type.Optional(
    StringEnum(["agents", "status", "steer", "stop", "resume"], {
      description:
        "Leave out to start runs. agents: list the agents. status, steer, stop or resume: a run by its id, status of every run without one. resume carries on with a run's interrupted agents",
    }),
  ),
  id: Type.Optional(Type.String({ description: "A run's id" })),
  message: Type.Optional(
    Type.String({ description: "steer: what to tell the run's agents" }),
  ),
});

const description = `Starts subagents: Pi sessions with their own context that work on a task and report back.

- One run: agent and task. Parallel runs: tasks. A chain: chain, where each step gets the previous step's output.
- Runs go to the background: the call returns at once, and their output comes back in a later message. Don't poll or wait for it; do other work or end your turn. wait: true blocks until they end instead.
- Built-in agents: scout (read-only recon), worker (makes changes), reviewer (read-only review), delegate (all tools, no extra instructions). action "agents" lists them with any the Profile or project adds.
- A task must say everything the agent needs, since it doesn't see this conversation.
- action "status", "steer" (with message) or "stop" manage a run by its id.
- A run cut off when this session restarted shows as interrupted. action "resume" with its id carries on with it.`;

function extension(cloud: SessionCloud, pi: ExtensionAPI): void {
  let projectAgents: string | undefined;
  let publishing: ReturnType<typeof setTimeout> | undefined;

  const publish = (): void => {
    publishing = undefined;

    cloud.publish(runsKey, runs.runs());
  };

  let closing = false;

  const runs = fleet({
    startChild: async (agent, continueFrom) =>
      cloud.startChild({
        tools: agent.tools,
        ...(agent.model !== undefined && { model: agent.model }),
        ...(agent.thinking !== undefined && { thinking: agent.thinking }),
        ...(agent.prompt !== "" && { systemPrompt: agent.prompt }),
        ...(continueFrom !== undefined && { continueFrom }),
      }),
    changed: () => {
      publishing ??= setTimeout(publish, publishMs);
    },
    recorded: (run) => {
      pi.appendEntry(recordType, run);
    },
  });

  // Wakes the parent with the run's outputs when it ends.
  const report = (run: Run): void => {
    void run.ended.then((ended) => {
      if (closing) {
        return;
      }

      pi.sendMessage(
        {
          customType: noticeType,
          content: outputs(ended),
          display: true,
          details: { plugin: "subagents", kind: finishedKind, data: ended },
        },
        { triggerTurn: true, deliverAs: "followUp" },
      );
    });
  };

  const resume = async (id: string): Promise<string> => {
    const run = runs.resume(id, await agents());
    if (!run) {
      return `Run "${id}" has nothing interrupted to resume.`;
    }

    report(run);

    return `Resumed run ${id} in the background. Its output comes back in a later message when it ends; don't wait or poll for it.`;
  };

  const agents = async (): Promise<readonly Agent[]> =>
    loadAgents([
      join(getAgentDir(), "agents"),
      ...(projectAgents === undefined ? [] : [projectAgents]),
    ]);

  pi.on("session_start", (_event, ctx) => {
    projectAgents = ctx.isProjectTrusted()
      ? join(ctx.cwd, ".pi", "agents")
      : undefined;

    const at = Date.now();

    const kept = recordedRuns(ctx.sessionManager.getEntries()).map((run) =>
      run.endedAt === undefined
        ? { run: interrupted(run, at), cut: true }
        : { run, cut: false },
    );

    const cutOff = kept.flatMap(({ run, cut }) => (cut ? [run] : []));

    runs.restore(kept.map(({ run }) => run));

    for (const run of cutOff) {
      pi.appendEntry(recordType, run);
    }

    if (cutOff.length > 0) {
      pi.sendMessage({
        customType: noticeType,
        content: cutOffText(cutOff),
        display: true,
        details: { plugin: "subagents", kind: interruptedKind, data: cutOff },
      });
    }
  });

  pi.on("session_shutdown", () => {
    closing = true;
    runs.close();
  });

  pi.on("resources_discover", async () => ({
    promptPaths: [await promptFolder()],
  }));

  pi.registerCommand("subagent-stop", {
    description: "Stop a subagent run: /subagent-stop <run id>",
    handler: async (args) => {
      await runs.stop(args.trim());
    },
  });

  pi.registerCommand("subagent-resume", {
    description:
      "Carry on with a subagent run a restart cut off: /subagent-resume <run id>",
    handler: async (args) => {
      await resume(args.trim());
    },
  });

  pi.registerCommand("subagent-steer", {
    description:
      "Tell a running subagent run something: /subagent-steer <run id> <message>",
    handler: async (args) => {
      const [id = "", ...words] = args.trim().split(/\s+/);
      await runs.steer(id, words.join(" "));
    },
  });

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description,
    parameters,
    prepareArguments: withoutEmptyFields,
    execute: async (_toolCallId, params) => {
      if (manages(params)) {
        return text(await manage(params));
      }

      const { shape, steps } = await launch(params, await agents());
      const run = runs.start(shape, steps);

      const started: Started = { runId: run.id };

      if (params.wait === true) {
        return {
          content: [{ type: "text", text: outputs(await run.ended) }],
          details: started,
        };
      }

      report(run);

      return {
        content: [
          {
            type: "text",
            text: `Started run ${run.id} with ${plural(steps.length, "subagent")} in the background. Their output comes back in a later message when the run ends; don't wait or poll for it.`,
          },
        ],
        details: started,
      };
    },
  });

  const manage = async (params: Static<typeof parameters>): Promise<string> => {
    const id = params.id ?? "";

    if (params.action === "agents") {
      return (await agents())
        .map(
          ({ name, description: about, tools }) =>
            `- ${name}: ${about} (tools: ${tools.join(", ")})`,
        )
        .join("\n");
    }

    if (params.action === "steer") {
      return (await runs.steer(id, params.message ?? ""))
        ? "Sent to the run's running agents."
        : `No running agents in run "${id}".`;
    }

    if (params.action === "resume") {
      return resume(id);
    }

    if (params.action === "stop") {
      return (await runs.stop(id))
        ? `Stopped run ${id}.`
        : `Run "${id}" isn't running.`;
    }

    const found = runs
      .runs()
      .filter((run) => params.id === undefined || run.id === id);

    return found.length === 0
      ? "No subagent runs."
      : found.map(summary).join("\n\n");
  };
}

async function launch(
  params: {
    readonly agent?: string;
    readonly task?: string;
    readonly tasks?: readonly { agent: string; task: string }[];
    readonly chain?: readonly { agent: string; task: string }[];
  },
  known: readonly Agent[],
): Promise<{ readonly shape: Shape; readonly steps: readonly Step[] }> {
  const step = ({ agent, task }: { agent: string; task: string }): Step => {
    const found = known.find(({ name }) => name === agent);
    if (!found) {
      throw new Error(
        `No agent named "${agent}". The agents are: ${known.map(({ name }) => name).join(", ")}.`,
      );
    }

    return { agent: found, task };
  };

  if (params.chain !== undefined && params.chain.length > 0) {
    return { shape: "chain", steps: params.chain.map(step) };
  }

  if (params.tasks !== undefined && params.tasks.length > 0) {
    return { shape: "parallel", steps: params.tasks.map(step) };
  }

  if (params.task !== undefined) {
    return {
      shape: "single",
      steps: [step({ agent: params.agent ?? "delegate", task: params.task })],
    };
  }

  return Promise.reject(
    new Error("Give a task, tasks for parallel runs, or chain."),
  );
}

function outputs(run: RunView): string {
  return [
    `Subagent run ${run.id} ended: ${runState(run)}.`,
    ...run.children.map(
      (child, index) =>
        `## ${String(index + 1)}. ${child.agent} (${child.state})\n\n${child.error ?? child.output ?? "(no output)"}`,
    ),
  ].join("\n\n");
}

// The latest record of each run in the transcript, oldest run first.
function recordedRuns(entries: readonly unknown[]): readonly RunView[] {
  const latest = new Map<string, RunView>();

  for (const entry of entries) {
    const { type, customType, data } = entry as {
      readonly type?: string;
      readonly customType?: string;
      readonly data?: RunView;
    };

    if (type === "custom" && customType === recordType && data !== undefined) {
      latest.set(data.id, data);
    }
  }

  return [...latest.values()];
}

function cutOffText(cutOff: readonly RunView[]): string {
  return [
    `The session restarted, which cut off ${plural(cutOff.length, "subagent run")}. Nothing restarts on its own: resume a run with action "resume" and its id, or leave it.`,
    ...cutOff.map((run) =>
      [
        `## Run ${run.id}`,
        ...run.children.map(
          (child) =>
            `- ${child.agent} (${child.state}): ${child.output ?? child.activity.findLast(({ kind }) => kind === "text")?.text ?? "nothing said yet"}`,
        ),
      ].join("\n"),
    ),
  ].join("\n\n");
}

function summary(run: RunView): string {
  return [
    `Run ${run.id}, ${run.shape}: ${runState(run)}`,
    ...run.children.map(
      (child) =>
        `- ${child.agent}: ${child.state}${child.tool === undefined ? "" : `, running ${child.tool}`}, ${plural(child.toolCount, "tool call")}`,
    ),
  ].join("\n");
}

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? "" : "s"}`;
}

function text(value: string): {
  content: { type: "text"; text: string }[];
  details: undefined;
} {
  return { content: [{ type: "text", text: value }], details: undefined };
}

let written: Promise<string> | undefined;

// A compiled binary has no files for the plugin, so the templates are
// written out once per process for Pi to load.
async function promptFolder(): Promise<string> {
  written ??= (async () => {
    const folder = join(
      await mkdtemp(join(tmpdir(), "pipoca-subagents-")),
      "prompts",
    );

    await mkdir(folder);

    for (const [name, body] of Object.entries(prompts)) {
      await writeFile(join(folder, `${name}.md`), body);
    }

    return folder;
  })();

  return written;
}

// Some models fill every field, sending the ones they don't use as "" or null.
function withoutEmptyFields(args: unknown): Static<typeof parameters> {
  if (typeof args !== "object" || args === null) {
    return args as Static<typeof parameters>;
  }

  return Object.fromEntries(
    Object.entries(args).filter(([, value]) => value !== "" && value !== null),
  );
}
