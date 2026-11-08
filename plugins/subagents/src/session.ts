import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ExtensionAPI,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import {
  defineSession,
  type SessionContext,
  type Static,
  StringEnum,
  Type,
} from "@pipoca/plugins";
import { noticeType } from "@pipoca/protocol";
import { subagents } from "../plugin";
import { type Agent, loadAgents } from "./agents";
import { fleet, type Run, type Step } from "./fleet";
import {
  decidedKind,
  finishedKind,
  workflowFailedKind,
  interrupted,
  interruptedKind,
  manages,
  missionRecordType,
  missionsKey,
  type MissionView,
  openDecisions,
  recordType,
  type RunView,
  runsKey,
  runState,
  type Shape,
  type Started,
  type Workflow,
} from "./format";
import { type MissionChange, missions } from "./missions";
import { namedAgent } from "./named";
import { prompts } from "./prompts";
import { watchdog } from "./watchdog";

// Subagents as child sessions in the Session's process, on its model runtime
// and logins (ADR 0057).
export const session = defineSession(subagents, (s) => {
  s.extension((pi) => {
    extension(s, pi);
    watchdog(s, pi);
  });

  s.provide.agent(async (name) =>
    namedAgent(
      name,
      join(getAgentDir(), "agents"),
      s.checkouts.map(({ path }) => path),
    ),
  );
});

const publishMs = 250;

// A child gets the tools its agent names, so a Session that can't change
// files, such as the assistant's coordinator, gets no subagents (ADR 0052).
const fileTools = ["bash", "edit", "write"];

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
  workflow: Type.Optional(
    Type.String({
      description:
        'A workflow: a saved one by name, or "inline" for the ```js workflow block written in this same reply',
    }),
  ),
  args: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description: "workflow: the args its script reads",
    }),
  ),
  missionId: Type.Optional(
    Type.String({
      description:
        "Starts the runs for this mission, or names the mission action mission changes",
    }),
  ),
  mission: Type.Optional(
    Type.Object(
      {
        title: Type.Optional(Type.String()),
        objective: Type.Optional(Type.String()),
        decision: Type.Optional(
          Type.Object({
            question: Type.String(),
            options: Type.Optional(Type.Array(Type.String())),
          }),
        ),
        receipt: Type.Optional(
          Type.Object({
            label: Type.String(),
            url: Type.String({ description: "A link, such as a pull request" }),
          }),
        ),
        close: Type.Optional(
          Type.String({ description: "Closes the mission with this summary" }),
        ),
      },
      { description: "action mission: what to set or add" },
    ),
  ),
  action: Type.Optional(
    StringEnum(["agents", "status", "steer", "stop", "resume", "mission"], {
      description:
        "Leave out to start runs. agents: list the agents. status, steer, stop or resume: a run by its id, status of every run and mission without one. resume carries on with a run's interrupted agents. mission: create a mission, or change the one missionId names",
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
- A run cut off when this session restarted shows as interrupted. action "resume" with its id carries on with it.
- A workflow is a JavaScript script for flows that are more than one chain or batch, such as a review loop. Write it in a \`\`\`js workflow block in your reply and call with workflow: "inline", or run a saved one by name with args. It runs in a sandbox with no files, shell or network, as the body of an async function that sees:
  - await runs.run({ agent, task, key? }): one run's output. It throws when the run doesn't end done.
  - await runs.all([{ agent, task, key? }, ...]): runs at once, their outputs in order.
  - await runs.steer(key, message), args, and console.log.
  Its return value and logs are its output. A key names a step; when the workflow is resumed after a restart, a step that already ended done gives back its output.
- A mission tracks an objective you work toward over many runs, such as a feature that ends in a pull request. action "mission" with mission.title and mission.objective creates one; with missionId it adds a decision (a question for the person, with options), a receipt (a link to what it produced), or closes it with a summary. Start runs with missionId to attach them. A workflow started with missionId reads and changes the mission's JSON state as \`state\`. The person's answer to a decision comes back in a later message; don't wait or poll for it.`;

function extension(s: SessionContext, pi: ExtensionAPI): void {
  let projectAgents: string | undefined;
  let publishing: (() => void) | undefined;

  const publish = async (): Promise<void> => {
    publishing = undefined;

    s.publish(runsKey, runs.runs());

    return Promise.resolve();
  };

  const publishMissions = (): void => {
    const all = goals.list();

    s.publish(missionsKey, all, {
      waiting: openDecisions(all).length > 0,
    });
  };

  const goals = missions({
    recorded: (mission) => {
      pi.appendEntry(missionRecordType, mission);
      publishMissions();
    },
    now: s.clock.now,
  });

  // A mission's state as a workflow of it reads and changes it.
  const stateOf = (missionId: string | undefined) =>
    missionId === undefined || goals.get(missionId) === undefined
      ? undefined
      : {
          initial: goals.get(missionId)?.state,
          keep: (state: unknown) => {
            goals.keep(missionId, state);
          },
        };

  const missionOfRun = (runId: string): string | undefined =>
    goals.list().find(({ runIds }) => runIds.includes(runId))?.id;

  let closing = false;

  const runs = fleet({
    startChild: async (agent, continueFrom) =>
      s.startChild({
        tools: agent.tools,
        ...(agent.mcp !== undefined && { mcp: agent.mcp }),
        ...(agent.skills !== undefined && { skills: agent.skills }),
        ...(agent.model !== undefined && { model: agent.model }),
        ...(agent.thinking !== undefined && { thinking: agent.thinking }),
        ...(agent.prompt !== "" && { systemPrompt: agent.prompt }),
        ...(continueFrom !== undefined && { continueFrom }),
      }),
    changed: () => {
      publishing ??= s.timer.after(publishMs, publish);
    },
    recorded: (run) => {
      pi.appendEntry(recordType, run);
    },
    now: s.clock.now,
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
    const run = runs.resume(id, await agents(), stateOf(missionOfRun(id)));
    if (!run) {
      return `Run "${id}" has nothing interrupted to resume.`;
    }

    report(run);

    return `Resumed run ${id} in the background. Its output comes back in a later message when it ends; don't wait or poll for it.`;
  };

  const workflowFolders = (): readonly string[] => [
    join(getAgentDir(), "workflows"),
    ...(projectAgents === undefined
      ? []
      : [join(projectAgents, "..", "workflows")]),
  ];

  const startWorkflow = async (
    workflow: Workflow,
    missionId?: string,
  ): Promise<Run> =>
    runs.startWorkflow(workflow, await agents(), stateOf(missionId));

  const agents = async (): Promise<readonly Agent[]> =>
    loadAgents([
      join(getAgentDir(), "agents"),
      ...(projectAgents === undefined ? [] : [projectAgents]),
    ]);

  const readOnly = (): boolean =>
    !fileTools.every((name) => pi.getActiveTools().includes(name));

  pi.on("session_start", (_event, ctx) => {
    if (readOnly()) {
      pi.setActiveTools(
        pi.getActiveTools().filter((name) => name !== "subagent"),
      );
    }

    projectAgents = ctx.isProjectTrusted()
      ? join(ctx.cwd, ".pi", "agents")
      : undefined;

    goals.restore(
      latest(
        ctx.sessionManager.getEntries(),
        missionRecordType,
      ) as readonly MissionView[],
    );

    if (goals.list().length > 0) {
      publishMissions();
    }

    const at = s.clock.now();

    const recorded = latest(
      ctx.sessionManager.getEntries(),
      recordType,
    ) as readonly RunView[];

    const kept = recorded.map((run) =>
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

  pi.registerCommand("workflow", {
    description:
      "Run a saved subagent workflow: /workflow <name> [args as JSON]",
    handler: async (args) => {
      const [, name = "", json = ""] =
        /^(\S*)\s*([\s\S]*)$/.exec(args.trim()) ?? [];

      try {
        const workflow = await savedWorkflow(
          workflowFolders(),
          name,
          json === "" ? undefined : (JSON.parse(json) as unknown),
        );

        report(await startWorkflow(workflow));
      } catch (error) {
        // Whoever started it, such as a routine's run, hears why.
        pi.sendMessage(
          {
            customType: noticeType,
            content: `The workflow ${name} didn't start: ${error instanceof Error ? error.message : String(error)}`,
            display: true,
            details: { plugin: "subagents", kind: workflowFailedKind },
          },
          { triggerTurn: true, deliverAs: "followUp" },
        );
      }
    },
  });

  pi.registerCommand("mission-decide", {
    description:
      "Answer a mission's decision: /mission-decide <mission id> <decision id> <answer>",
    // Pi takes only async handlers, and deciding needs no waiting.
    // eslint-disable-next-line @typescript-eslint/require-await
    handler: async (args) => {
      const [id = "", decisionId = "", ...words] = args.trim().split(/\s+/);
      const decided = goals.decide(id, decisionId, words.join(" "));

      if (!decided) {
        return;
      }

      const { mission, decision } = decided;

      pi.sendMessage(
        {
          customType: noticeType,
          content: `The person decided, for mission ${mission.id} (${mission.title}): ${decision.question}\n\nAnswer: ${decision.answer ?? ""}`,
          display: true,
          details: {
            plugin: "subagents",
            kind: decidedKind,
            data: { mission: mission.id, decision },
          },
        },
        { triggerTurn: true, deliverAs: "followUp" },
      );
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
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      if (readOnly()) {
        throw new Error(
          "This Session can't change files, so it can't start subagents.",
        );
      }

      if (manages(params)) {
        return text(await manage(params));
      }

      const { missionId } = params;

      const goal = missionId === undefined ? undefined : goals.get(missionId);

      if (
        missionId !== undefined &&
        (goal === undefined || goal.closedAt !== undefined)
      ) {
        throw new Error(`No open mission "${missionId}".`);
      }

      let run: Run;
      let size: number;

      if (params.workflow !== undefined) {
        const workflow =
          params.workflow === "inline"
            ? inlineWorkflow(ctx.sessionManager.getBranch(), params.args)
            : await savedWorkflow(
                workflowFolders(),
                params.workflow,
                params.args,
              );

        run = await startWorkflow(workflow, missionId);
        size = 0;
      } else {
        const { shape, steps } = await launch(params, await agents());

        run = runs.start(shape, steps);
        size = steps.length;
      }

      if (missionId !== undefined) {
        goals.attach(missionId, run.id);
      }

      if (params.wait === true) {
        const ended = await run.ended;

        return {
          content: [{ type: "text", text: outputs(ended) }],
          details: { runId: run.id, run: ended } satisfies Started,
        };
      }

      const view = runs.runs().find(({ id }) => id === run.id);
      const started: Started = { runId: run.id, ...(view && { run: view }) };

      report(run);

      return {
        content: [
          {
            type: "text",
            text: `Started run ${run.id}${size === 0 ? ", a workflow," : ` with ${plural(size, "subagent")}`} in the background. Its output comes back in a later message when the run ends; don't wait or poll for it.`,
          },
        ],
        details: started,
      };
    },
  });

  const manage = async (params: Static<typeof parameters>): Promise<string> => {
    const id = params.id ?? "";

    if (params.action === "agents") {
      const saved = await workflowNames(workflowFolders());

      return [
        ...(await agents()).map(
          ({ name, description: about, tools, mcp = [], skills = [] }) =>
            `- ${name}: ${about} (tools: ${[...tools, ...mcp.map((server) => `mcp ${server}`), ...skills.map((skill) => `skill ${skill}`)].join(", ")})`,
        ),
        ...(saved.length === 0 ? [] : [`Saved workflows: ${saved.join(", ")}`]),
      ].join("\n");
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

    if (params.action === "mission") {
      return mission(params.missionId, params.mission ?? {});
    }

    const found = runs
      .runs()
      .filter((run) => params.id === undefined || run.id === id);

    const open = goals.list().filter(({ closedAt }) => closedAt === undefined);

    return [
      ...(params.id === undefined ? open.map(missionSummary) : []),
      ...(found.length === 0 ? ["No subagent runs."] : found.map(summary)),
    ].join("\n\n");
  };

  const mission = (
    missionId: string | undefined,
    change: MissionChange,
  ): string => {
    if (missionId === undefined) {
      if (change.title === undefined || change.objective === undefined) {
        return "A new mission needs mission.title and mission.objective.";
      }

      const created = goals.create(change.title, change.objective);

      return `Created mission ${created.id}. Start its runs with missionId "${created.id}".`;
    }

    const changed = goals.update(missionId, change);

    return changed === undefined
      ? `No open mission "${missionId}".`
      : missionSummary(changed);
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
    ...(run.workflow === undefined
      ? []
      : [
          `## Workflow output\n\n${run.error === undefined ? "" : `Failed: ${run.error}\n\n`}${run.output ?? "(no output)"}`,
        ]),
    ...run.children.map(
      (child, index) =>
        `## ${String(index + 1)}. ${child.agent} (${child.state})\n\n${child.error ?? child.output ?? "(no output)"}`,
    ),
  ].join("\n\n");
}

// The latest record of each run or mission in the transcript, oldest first.
function latest(
  entries: readonly unknown[],
  recorded: string,
): readonly unknown[] {
  const found = new Map<string, unknown>();

  for (const entry of entries) {
    const { type, customType, data } = entry as {
      readonly type?: string;
      readonly customType?: string;
      readonly data?: { readonly id: string };
    };

    if (type === "custom" && customType === recorded && data !== undefined) {
      found.set(data.id, data);
    }
  }

  return [...found.values()];
}

function missionSummary(mission: MissionView): string {
  return [
    `Mission ${mission.id}: ${mission.title}${mission.closedAt === undefined ? "" : " (closed)"}`,
    mission.objective,
    ...mission.decisions.map(
      ({ id, question, answer }) =>
        `- Decision ${id}: ${question} ${answer === undefined ? "(waiting on the person)" : `Answer: ${answer}`}`,
    ),
    ...mission.receipts.map(({ label, url }) => `- Receipt: ${label} ${url}`),
    `Runs: ${mission.runIds.length === 0 ? "none" : mission.runIds.join(", ")}`,
    ...(mission.state === undefined
      ? []
      : [`State: ${JSON.stringify(mission.state)}`]),
  ].join("\n");
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

const inlineBlock = /```js workflow\n([\s\S]*?)```/;

// The ```js workflow block of the reply that called the tool.
function inlineWorkflow(
  branch: readonly { readonly type: string; readonly message?: unknown }[],
  args: unknown,
): Workflow {
  const reply = branch.findLast(
    ({ type, message }) =>
      type === "message" &&
      (message as { readonly role?: string } | undefined)?.role === "assistant",
  )?.message as
    | { readonly content?: readonly { type: string; text?: string }[] }
    | undefined;

  const said = (reply?.content ?? [])
    .flatMap(({ type, text: part }) =>
      type === "text" && part !== undefined ? [part] : [],
    )
    .join("\n");

  const script = inlineBlock.exec(said)?.[1];
  if (script === undefined) {
    throw new Error(
      'workflow "inline" needs a ```js workflow block in the same reply.',
    );
  }

  return { script, ...(args !== undefined && { args }) };
}

// Later folders win, as for agents.
async function workflowNames(
  folders: readonly string[],
): Promise<readonly string[]> {
  const names = new Set<string>();

  for (const folder of folders) {
    for (const file of await readdir(folder).catch(() => [])) {
      if (file.endsWith(".js")) {
        names.add(file.slice(0, -".js".length));
      }
    }
  }

  return [...names].sort();
}

async function savedWorkflow(
  folders: readonly string[],
  name: string,
  args: unknown,
): Promise<Workflow> {
  const folderless = /^[\w-][\w.-]*$/.test(name);

  for (const folder of folderless ? [...folders].reverse() : []) {
    const script = await readFile(join(folder, `${name}.js`), "utf8").catch(
      () => undefined,
    );

    if (script !== undefined) {
      return { name, script, ...(args !== undefined && { args }) };
    }
  }

  const known = await workflowNames(folders);

  throw new Error(
    `No workflow named "${name}". ${known.length === 0 ? "There are no saved workflows." : `The saved workflows are: ${known.join(", ")}.`}`,
  );
}
