import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AssistantMessage,
  fauxAssistantMessage,
  type FauxResponseFactory,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Command, LiveEvent } from "@pipoca/protocol";
import { session as subagentsPart } from "@pipoca/subagents/session";
import { hostSession, type SessionStream } from "./index";

// What the plugin publishes about its runs, as far as these tests read it.
interface RunView {
  readonly id: string;
  readonly endedAt?: number;
  readonly output?: string;
  readonly children: readonly {
    readonly key?: string;
    readonly state: string;
    readonly output?: string;
  }[];
}

let root: string;
const agentDirBefore = process.env["PI_CODING_AGENT_DIR"];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "subagents-"));
  process.env["PI_CODING_AGENT_DIR"] = join(root, "agent");
});

afterEach(async () => {
  process.env["PI_CODING_AGENT_DIR"] = agentDirBefore;
  await rm(root, { recursive: true, force: true });
});

interface Seen {
  readonly system: string;
  readonly task: string;
  // What it was told last, such as to carry on after a restart.
  readonly last: string;
  readonly tools: readonly string[];
}

// One faux model for the parent and its children, as they share the
// Session's runtime. A child answers with its task's first line; the parent
// follows its script, then says "ok".
// A parent's reply, or one made from what the parent's model was given.
type Reply = AssistantMessage | ((saw: string) => AssistantMessage);

async function hosted(
  parent: readonly Reply[],
  {
    cwd = root,
    watchdog = [],
  }: {
    readonly cwd?: string;
    // What the watchdog answers, review by review; [] once these run out.
    readonly watchdog?: readonly string[];
  } = {},
): Promise<{
  readonly send: (text: string) => void;
  readonly lines: string[];
  readonly events: LiveEvent[];
  readonly children: Seen[];
  readonly offered: unknown[];
  // What the parent's model was last given, as text.
  readonly parentSaw: () => string;
  readonly waitFor: (predicate: () => boolean) => Promise<void>;
  readonly stop: () => Promise<void>;
}> {
  const faux = fauxProvider();
  const script = [...parent];
  const reviews = [...watchdog];
  const children: Seen[] = [];
  const offered: unknown[] = [];
  let parentSaw = "";

  const answer: FauxResponseFactory = async (context, options) => {
    const system = context.messages.flatMap((m) =>
      m.role === "system" ? [m] : [],
    );

    const tools = system.flatMap(({ toolsAdded = [] }) =>
      toolsAdded.map(({ name }) => name),
    );

    if (!tools.includes("subagent")) {
      const said = (
        message: (typeof context.messages)[number] | undefined,
      ): string => {
        if (message?.role !== "user") {
          return "";
        }

        return typeof message.content === "string"
          ? message.content
          : message.content
              .flatMap((p) => (p.type === "text" ? [p.text] : []))
              .join("");
      };

      const task = said(context.messages.find((m) => m.role === "user"));
      const last = said(context.messages.findLast((m) => m.role === "user"));

      children.push({
        system: JSON.stringify(
          system.map(({ content, sections }) => [content, sections]),
        ),
        task,
        last,
        tools,
      });

      if (children.at(-1)?.system.includes("You are a watchdog") === true) {
        return fauxAssistantMessage([fauxText(reviews.shift() ?? "[]")]);
      }

      // Runs until it is stopped, the first time it is told.
      if (task === "hang" || last === "hang once") {
        return new Promise((resolve) => {
          options?.signal?.addEventListener("abort", () => {
            resolve(fauxAssistantMessage([], { stopReason: "aborted" }));
          });
        });
      }

      return fauxAssistantMessage([
        fauxText(`did: ${task.split("\n")[0] ?? ""}`),
      ]);
    }

    parentSaw = JSON.stringify(
      context.messages.filter((m) => m.role !== "system"),
    );

    offered.push(
      ...system.flatMap(({ toolsAdded = [] }) =>
        toolsAdded.flatMap(({ name, parameters }) =>
          name === "subagent" ? [parameters] : [],
        ),
      ),
    );

    const next = script.shift() ?? fauxAssistantMessage([fauxText("ok")]);

    return typeof next === "function" ? next(parentSaw) : next;
  };

  faux.setResponses(Array.from({ length: 50 }, () => answer));

  const runtime = await ModelRuntime.create({
    authPath: join(root, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  });

  runtime.registerNativeProvider(faux.provider);

  const lines: string[] = [];
  const events: LiveEvent[] = [];
  let listener: ((command: Command) => void) | undefined;

  const stream: SessionStream = {
    uploadTranscript: async (start, batch) => {
      lines.splice(start, batch.length, ...batch);

      return Promise.resolve(lines.length);
    },
    publish: async (batch) => {
      events.push(...batch);

      return Promise.resolve();
    },
    commands: (l) => {
      listener = l;

      return () => {
        listener = undefined;
      };
    },
    terminal: () => {
      throw new Error("no terminals here");
    },
    preview: () => {
      throw new Error("no previews here");
    },
    tools: async () => Promise.resolve([]),
    callTool: async () => Promise.resolve(),
    toolQuestion: async () => Promise.resolve(undefined),
    answerTrust: async () => Promise.resolve(),
    pluginRequest: async () => Promise.resolve(Response.json({})),
  };

  const session = await hostSession(
    {
      cwd,
      agentDir: join(root, "agent"),
      authPath: join(root, "auth.json"),
      modelsPath: join(root, "models.json"),
      sessionDir: join(root, "sessions"),
      extensionPaths: [],
      models: { runtime, model: faux.getModel() },
      parts: [subagentsPart],
    },
    stream,
    () => undefined,
    () => undefined,
  );

  return {
    send: (text) => listener?.({ actor: "user:local", type: "message", text }),
    lines,
    events,
    children,
    offered,
    parentSaw: () => parentSaw,
    waitFor: async (predicate) => {
      while (!predicate()) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
    stop: session.stop,
  };
}

function call(args: Parameters<typeof fauxToolCall>[1]): AssistantMessage {
  return fauxAssistantMessage([fauxToolCall("subagent", args)], {
    stopReason: "toolUse",
  });
}

function toolResults(lines: readonly string[]): string[] {
  return lines.flatMap((line) => {
    const { message } = JSON.parse(line) as {
      message?: { role: string; content: { type: string; text?: string }[] };
    };

    return message?.role === "toolResult"
      ? message.content.flatMap((p) => p.text ?? [])
      : [];
  });
}

function latestRuns(events: readonly LiveEvent[]): readonly RunView[] {
  const published = events.findLast(
    (e) => e.type === "plugin" && e.plugin === "subagents" && e.key === "runs",
  );

  return published?.type === "plugin" ? (published.data as RunView[]) : [];
}

test("runs a subagent in the background and brings its output back to the parent", async () => {
  const session = await hosted([
    call({ agent: "scout", task: "find the parser" }),
  ]);

  session.send("look around");

  await session.waitFor(() =>
    session.lines.some((line) => line.includes('"kind":"finished"')),
  );

  await session.waitFor(
    () => latestRuns(session.events)[0]?.endedAt !== undefined,
  );

  await session.stop();

  expect(toolResults(session.lines).join()).toContain("in the background");

  const notice = session.lines.find((line) =>
    line.includes('"kind":"finished"'),
  );

  expect(notice).toContain("did: find the parser");

  const [run] = latestRuns(session.events);

  expect(run?.children).toMatchObject([
    { agent: "scout", state: "done", output: "did: find the parser" },
  ]);

  expect(session.children[0]?.tools).toEqual([
    "read",
    "grep",
    "find",
    "ls",
    "bash",
  ]);
});

test("starts a run when the model also fills in a management action", async () => {
  const session = await hosted([
    call({
      agent: "scout",
      task: "find the parser",
      action: "status",
      wait: true,
    }),
  ]);

  session.send("look around");
  await session.waitFor(() => toolResults(session.lines).length > 0);
  await session.stop();

  expect(toolResults(session.lines).join()).toContain("did: find the parser");
});

test("starts a run when the model sends the fields it doesn't use as empty", async () => {
  const session = await hosted([
    call({
      agent: "scout",
      task: "find the parser",
      action: "",
      id: "",
      message: "",
      wait: true,
    }),
  ]);

  session.send("look around");
  await session.waitFor(() => toolResults(session.lines).length > 0);
  await session.stop();

  expect(toolResults(session.lines).join()).toContain("did: find the parser");
});

test("offers its action to the model as a plain string enum", async () => {
  const session = await hosted([]);

  session.send("hi");
  await session.waitFor(() => session.offered.length > 0);
  await session.stop();

  expect(session.offered[0]).toMatchObject({
    properties: {
      action: {
        type: "string",
        enum: ["agents", "status", "steer", "stop", "resume", "mission"],
      },
    },
  });
});

test("waits for parallel runs and returns every output", async () => {
  const session = await hosted([
    call({
      tasks: [
        { agent: "reviewer", task: "review the api" },
        { agent: "reviewer", task: "review the tests" },
      ],
      wait: true,
    }),
  ]);

  session.send("review");
  await session.waitFor(() => toolResults(session.lines).length > 0);
  await session.stop();

  const [result] = toolResults(session.lines);
  expect(result).toContain("did: review the api");
  expect(result).toContain("did: review the tests");
});

test("gives each step of a chain the previous step's output", async () => {
  const session = await hosted([
    call({
      chain: [
        { agent: "scout", task: "find the bug" },
        { agent: "worker", task: "fix it" },
      ],
      wait: true,
    }),
  ]);

  session.send("fix the bug");
  await session.waitFor(() => toolResults(session.lines).length > 0);
  await session.stop();

  expect(session.children[1]?.task).toContain("fix it");
  expect(session.children[1]?.task).toContain("did: find the bug");
});

test("uses an agent from the Profile's agents folder", async () => {
  await mkdir(join(root, "agent", "agents"), { recursive: true });

  await writeFile(
    join(root, "agent", "agents", "linter.md"),
    `---
name: linter
description: Checks style
tools: read, grep
---
Only report lint problems.
`,
  );

  const session = await hosted([
    call({ agent: "linter", task: "lint src", wait: true }),
  ]);

  session.send("lint");
  await session.waitFor(() => toolResults(session.lines).length > 0);
  await session.stop();

  expect(session.children[0]?.tools).toEqual(["read", "grep"]);
  expect(session.children[0]?.system).toContain("Only report lint problems.");
});

test("names the agents there are when asked for one that doesn't exist", async () => {
  const session = await hosted([call({ agent: "nobody", task: "anything" })]);

  session.send("go");
  await session.waitFor(() => toolResults(session.lines).length > 0);
  await session.stop();

  expect(toolResults(session.lines)[0]).toContain(
    "scout, worker, reviewer, delegate",
  );
});

test("stops a run from its command, as the web's Stop button does", async () => {
  const session = await hosted([call({ agent: "delegate", task: "hang" })]);

  session.send("start something long");

  await session.waitFor(
    () => latestRuns(session.events)[0]?.children[0]?.state === "running",
  );

  const id = latestRuns(session.events)[0]?.id ?? "";
  session.send(`/subagent-stop ${id}`);

  await session.waitFor(
    () => latestRuns(session.events)[0]?.endedAt !== undefined,
  );

  await session.stop();

  expect(latestRuns(session.events)[0]?.children[0]?.state).toBe("stopped");
});

test("marks a run a restart cut off as interrupted, and resumes it from its child's session", async () => {
  const before = await hosted([call({ agent: "delegate", task: "hang once" })]);

  before.send("start something long");

  await before.waitFor(
    () => latestRuns(before.events)[0]?.children[0]?.state === "running",
  );

  const id = latestRuns(before.events)[0]?.id ?? "";

  await before.stop();

  const after = await hosted([]);

  await after.waitFor(
    () => latestRuns(after.events)[0]?.children[0]?.state === "interrupted",
  );

  after.send(`/subagent-resume ${id}`);

  await after.waitFor(
    () => latestRuns(after.events)[0]?.children[0]?.state === "done",
  );

  await after.stop();

  expect(latestRuns(after.events)[0]).toMatchObject({
    id,
    children: [{ state: "done", output: "did: hang once" }],
  });

  expect(after.children.at(-1)).toMatchObject({
    task: "hang once",
    last: expect.stringContaining("Carry on with your task") as unknown,
  });
});

// A git repository, and a Profile that turns the watchdog on.
async function watched(): Promise<string> {
  const repo = join(root, "repo");

  await mkdir(repo);
  execFileSync("git", ["init", "--quiet"], { cwd: repo });
  await mkdir(join(root, "agent"), { recursive: true });

  await writeFile(
    join(root, "agent", "settings.json"),
    JSON.stringify({ subagents: { watchdog: { enabled: true } } }),
  );

  return repo;
}

function edit(path: string, content: string): AssistantMessage {
  return fauxAssistantMessage([fauxToolCall("write", { path, content })], {
    stopReason: "toolUse",
  });
}

function watchdogNotices(lines: readonly string[]): {
  readonly content: string;
  readonly details: { readonly data: { readonly stuck?: boolean } };
}[] {
  return lines.flatMap((line) => {
    const entry = JSON.parse(line) as {
      type?: string;
      content: string;
      details?: { kind?: string; data: { stuck?: boolean } };
    };

    return entry.type === "custom_message" && entry.details?.kind === "watchdog"
      ? [{ content: entry.content, details: entry.details }]
      : [];
  });
}

function watchdogReviews(children: readonly Seen[]): Seen[] {
  return children.filter(({ system }) => system.includes("You are a watchdog"));
}

const finding = (importance: string, summary: string): string =>
  JSON.stringify([{ importance, summary, evidence: "e", action: "a" }]);

test("the watchdog sends a turn's high findings to the agent and keeps the rest for the person", async () => {
  const repo = await watched();

  const session = await hosted(
    [edit("a.txt", "one"), fauxAssistantMessage([fauxText("done")])],
    {
      cwd: repo,
      watchdog: [
        JSON.stringify([
          {
            importance: "high",
            summary: "a.txt breaks the build",
            evidence: "e",
            action: "a",
          },
          { importance: "low", summary: "a.txt could be named better" },
        ]),
      ],
    },
  );

  session.send("write a.txt");

  await session.waitFor(() => session.parentSaw().includes("breaks the build"));
  await session.stop();

  const [review] = watchdogReviews(session.children);
  expect(review?.task).toContain("write a.txt");
  expect(review?.task).toContain("+one");
  expect(review?.tools).toEqual(["read", "grep", "find", "ls"]);

  expect(watchdogNotices(session.lines)[0]?.content).toContain(
    "could be named better",
  );

  expect(session.parentSaw()).not.toContain("could be named better");
});

test("the watchdog doesn't review a turn that changed nothing", async () => {
  const repo = await watched();
  const session = await hosted([], { cwd: repo });

  session.send("hi");
  await session.waitFor(() => session.parentSaw() !== "");
  await session.stop();

  expect(watchdogReviews(session.children)).toEqual([]);
});

test("the watchdog stops sending the same high finding after three turns in a row", async () => {
  const repo = await watched();
  const done = fauxAssistantMessage([fauxText("done")]);

  const session = await hosted(
    [
      edit("a.txt", "1"),
      done,
      edit("a.txt", "2"),
      done,
      edit("a.txt", "3"),
      done,
      edit("a.txt", "4"),
      done,
    ],
    {
      cwd: repo,
      watchdog: Array.from({ length: 4 }, () =>
        finding("high", "a.txt is wrong"),
      ),
    },
  );

  session.send("write a.txt");

  await session.waitFor(() =>
    watchdogNotices(session.lines).some(
      ({ details }) => details.data.stuck === true,
    ),
  );

  await session.stop();

  expect(watchdogReviews(session.children)).toHaveLength(3);

  expect(
    watchdogNotices(session.lines).map(({ details }) => details.data.stuck),
  ).toEqual([undefined, undefined, true]);
});

function workflowCall(
  script: string,
  args: Parameters<typeof fauxToolCall>[1],
): AssistantMessage {
  return fauxAssistantMessage(
    [
      fauxText(`Here it is:\n\n\`\`\`js workflow\n${script}\n\`\`\``),
      fauxToolCall("subagent", { workflow: "inline", ...args }),
    ],
    { stopReason: "toolUse" },
  );
}

test("runs an inline workflow that combines runs, and returns what it returns", async () => {
  const session = await hosted([
    workflowCall(
      `const found = await runs.run({ agent: "scout", task: "find " + args.topic });
const [first, second] = await runs.all([
  { agent: "reviewer", task: found },
  { agent: "reviewer", task: "again" },
]);
console.log("reviewed");
return [found, first, second, typeof fetch, typeof require].join("|");`,
      { args: { topic: "the parser" }, wait: true },
    ),
  ]);

  session.send("go");
  await session.waitFor(() => toolResults(session.lines).length > 0);

  await session.waitFor(
    () => latestRuns(session.events)[0]?.endedAt !== undefined,
  );

  await session.stop();

  expect(toolResults(session.lines)[0]).toContain(
    "reviewed\ndid: find the parser|did: did: find the parser|did: again|undefined|undefined",
  );

  expect(latestRuns(session.events)[0]).toMatchObject({
    children: [
      { key: "scout-1", state: "done" },
      { key: "reviewer-1", state: "done" },
      { key: "reviewer-2", state: "done" },
    ],
  });
});

test("runs a workflow saved in the Profile by name", async () => {
  await mkdir(join(root, "agent", "workflows"), { recursive: true });

  await writeFile(
    join(root, "agent", "workflows", "twice.js"),
    `const outputs = [];
for (const round of [1, 2]) {
  outputs.push(await runs.run({ key: "round " + round, agent: "worker", task: args.task + " " + round }));
}
return outputs.join(", ");`,
  );

  const session = await hosted([
    call({ workflow: "twice", args: { task: "polish" }, wait: true }),
  ]);

  session.send("go");
  await session.waitFor(() => toolResults(session.lines).length > 0);
  await session.stop();

  expect(toolResults(session.lines)[0]).toContain(
    "did: polish 1, did: polish 2",
  );
});

test("fails a workflow whose step fails, with the step's key", async () => {
  const session = await hosted([
    workflowCall(
      `await runs.run({ key: "look", agent: "nobody", task: "x" });`,
      {
        wait: true,
      },
    ),
  ]);

  session.send("go");
  await session.waitFor(() => toolResults(session.lines).length > 0);
  await session.stop();

  expect(toolResults(session.lines)[0]).toContain('No agent named "nobody"');
});

test("resumes a workflow a restart cut off without running its finished steps again", async () => {
  const before = await hosted([
    workflowCall(
      `const a = await runs.run({ key: "first", agent: "delegate", task: "first" });
const b = await runs.run({ key: "second", agent: "delegate", task: "hang once" });
return a + " then " + b;`,
      {},
    ),
  ]);

  before.send("go");

  await before.waitFor(
    () => latestRuns(before.events)[0]?.children[1]?.state === "running",
  );

  const id = latestRuns(before.events)[0]?.id ?? "";

  await before.stop();

  const after = await hosted([]);

  await after.waitFor(
    () => latestRuns(after.events)[0]?.children[1]?.state === "interrupted",
  );

  after.send(`/subagent-resume ${id}`);

  await after.waitFor(
    () =>
      latestRuns(after.events)[0]?.endedAt !== undefined &&
      latestRuns(after.events)[0]?.children[1]?.state === "done",
  );

  await after.stop();

  expect(latestRuns(after.events)[0]).toMatchObject({
    output: "did: first then did: hang once",
  });

  expect(after.children.map(({ task }) => task)).toEqual(["hang once"]);
});

function missionsOf(events: readonly LiveEvent[]): {
  readonly data: readonly {
    readonly id: string;
    readonly runIds: readonly string[];
    readonly state?: unknown;
    readonly decisions: readonly { readonly answer?: string }[];
  }[];
  readonly waiting?: boolean;
} {
  const published = events.findLast(
    (e) =>
      e.type === "plugin" && e.plugin === "subagents" && e.key === "missions",
  );

  return published?.type === "plugin"
    ? {
        data: published.data as ReturnType<typeof missionsOf>["data"],
        ...(published.waiting !== undefined && { waiting: published.waiting }),
      }
    : { data: [] };
}

const createdMission = (saw: string): string =>
  /Created mission (\w+)/.exec(saw)?.[1] ?? "";

test("a mission's decision waits on the person, and their answer comes back to the agent", async () => {
  const session = await hosted([
    call({
      action: "mission",
      mission: { title: "Ship login", objective: "Login works on Safari" },
    }),
    (saw) =>
      call({
        agent: "scout",
        task: "find the login form",
        missionId: createdMission(saw),
        wait: true,
      }),
    (saw) =>
      call({
        action: "mission",
        missionId: createdMission(saw),
        mission: {
          decision: { question: "Use OAuth?", options: ["yes", "no"] },
        },
      }),
  ]);

  session.send("ship login");

  await session.waitFor(() => missionsOf(session.events).waiting === true);

  const [mission] = missionsOf(session.events).data;
  session.send(`/mission-decide ${mission?.id ?? ""} 1 yes`);

  await session.waitFor(() => session.parentSaw().includes("Answer: yes"));
  await session.waitFor(() => missionsOf(session.events).waiting !== true);
  await session.stop();

  expect(missionsOf(session.events).data[0]).toMatchObject({
    runIds: [expect.any(String) as unknown],
    decisions: [{ answer: "yes" }],
  });
});

test("a workflow started for a mission reads and changes its state, which outlasts a restart", async () => {
  const before = await hosted([
    call({
      action: "mission",
      mission: { title: "Count", objective: "Count the rounds" },
    }),
    (saw) =>
      fauxAssistantMessage(
        [
          fauxText(
            '```js workflow\nstate.rounds = (state.rounds ?? 0) + 1;\nawait runs.run({ agent: "scout", task: "look" });\nreturn state.rounds;\n```',
          ),
          fauxToolCall("subagent", {
            workflow: "inline",
            missionId: createdMission(saw),
            wait: true,
          }),
        ],
        { stopReason: "toolUse" },
      ),
  ]);

  before.send("count");

  await before.waitFor(() =>
    toolResults(before.lines).some((r) => r.includes("Workflow output")),
  );

  await before.stop();

  const after = await hosted([]);

  await after.waitFor(() => missionsOf(after.events).data.length > 0);
  await after.stop();

  expect(missionsOf(after.events).data[0]?.state).toEqual({ rounds: 1 });
});
