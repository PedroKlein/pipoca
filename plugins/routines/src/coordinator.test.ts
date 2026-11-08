import { expect, test } from "bun:test";
import { server as askServer } from "@pipoca/ask/server";
import {
  definePlugin,
  defineServer,
  event,
  type ServerContext,
  Type,
} from "@pipoca/plugins";
import {
  person,
  type PluginTest,
  type TestSession,
  testPlugin,
  until,
} from "@pipoca/testing";
import type { GroupDetail, RoutineDetail, Run } from "./model";
import { server } from "./server";

const people = [{ id: "ana", name: "Ana", admin: true }];

const tracker = definePlugin({
  id: "tracker",
  title: "Tracker",
  description: "Publishes issues.",
  works: ["personal", "team"],
  events: {
    issue: event({
      title: "Issue",
      fields: Type.Object({ number: Type.Number() }),
    }),
  },
});

const subagents = definePlugin({
  id: "subagents",
  title: "Subagents",
  description: "Finds agents.",
});

let tracking: ServerContext<typeof tracker> | undefined;

const trackerServer = defineServer(tracker, (context) => {
  tracking = context;
});

let hosts = new Map<string, TestSession>();

async function started(): Promise<PluginTest> {
  const t = await testPlugin(server, {
    people,
    plugins: [askServer, trackerServer, subagents],
  });

  hosts = new Map();
  await t.session({ owner: person("ana") });

  return t;
}

const folder = { kind: "folder", path: "/srv/a" };

const planner = {
  title: "Planner",
  coordinator: true,
  when: [{ kind: "event", event: "tracker.issue" }],
  // A coordinator's piece of work is its group, whatever this says.
  sameWork: { key: ["number"], whileRunning: "skip" },
  do: {
    kind: "session",
    agent: "planner",
    prompt: "Plan the epic.",
    workspace: folder,
  },
};

async function withPlanner(
  t: PluginTest,
  limits: object = {},
): Promise<{ readonly run: Run; readonly host: TestSession }> {
  await t.as("ana").put("groups/shop", {
    title: "Shop",
    repositories: ["acme/shop"],
    coordinator: limits,
  });

  await t.as("ana").put("routines/planner?group=shop", planner);

  issue(1);
  await t.clock.advance("30s");

  const [run] = await runs(t);

  return { run: run ?? fail(), host: await host(t, run) };
}

function fail(): never {
  throw new Error("missing");
}

function issue(number: number): void {
  tracking?.events.emit("issue", { number }, { to: [person("ana")] });
}

async function runs(t: PluginTest): Promise<readonly Run[]> {
  return (await t.as("ana").get<RoutineDetail>("routines/planner")).runs;
}

async function runOf(t: PluginTest, id: string): Promise<Run> {
  return (await runs(t)).find((run) => run.id === id) ?? fail();
}

async function host(t: PluginTest, run: Run | undefined): Promise<TestSession> {
  const id = run?.sessionId ?? "";
  const found = hosts.get(id) ?? (await t.attach(id));

  hosts.set(id, found);

  return found;
}

function sessionOf(id: string | null | undefined) {
  return tracking?.sessions.get(id ?? "") ?? fail();
}

async function call(
  t: PluginTest,
  session: TestSession,
  name: string,
  input: object,
): Promise<string> {
  const answer = await t.tool(name, input, { session });

  if (answer.isError) {
    throw new Error(answer.text);
  }

  return answer.text;
}

async function startRun(
  t: PluginTest,
  coordinator: TestSession,
  key: string,
): Promise<Run> {
  const text = await call(t, coordinator, "start_run", {
    agent: "implementer",
    prompt: `Fix ${key}.`,
    key,
  });

  const id = /run (\S+)/.exec(text)?.[1] ?? fail();

  return runOf(t, id);
}

async function failureOf(answer: Promise<unknown>): Promise<string> {
  try {
    await answer;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }

  throw new Error("it didn't fail");
}

function questions() {
  return tracking?.questions ?? fail();
}

test("a coordinator is one per group, and only in a group", async () => {
  await using t = await started();

  expect(await failureOf(t.as("ana").put("routines/planner", planner))).toBe(
    "a coordinator is a group's: put it in one",
  );

  await t.as("ana").put("groups/shop", { title: "Shop" });
  await t.as("ana").put("routines/planner?group=shop", planner);

  expect(
    await failureOf(t.as("ana").put("routines/second?group=shop", planner)),
  ).toBe("the group's coordinator is planner, and a group has one");

  expect(
    await failureOf(
      t.as("ana").put("routines/messages?group=shop", {
        ...planner,
        do: { kind: "message", prompt: "Hi", session: "x" },
      }),
    ),
  ).toBe("a coordinator starts a Session of its own");
});

test("a coordinator keeps one Session that hears every event, goes on between turns without a time limit, and never gets the routines tool", async () => {
  await using t = await started();
  const { run, host: coordinator } = await withPlanner(t);

  expect(run).toMatchObject({ cause: "event", outcome: "running" });

  expect(sessionOf(run.sessionId)).toMatchObject({
    agent: {
      name: "planner",
      keep: [
        "end_run",
        "ask_user",
        "propose",
        "memory",
        "start_run",
        "message_run",
        "list_runs",
        "stop_run",
      ],
    },
  });

  expect(sessionOf(run.sessionId).systemPrompt).toContain(
    'You are the coordinator of the group "Shop"',
  );

  await coordinator.turn([]);
  await t.clock.advance("3h");

  expect(await runOf(t, run.id)).toMatchObject({ outcome: "running" });

  issue(2);
  await t.clock.advance("30s");

  const [told] = await runs(t);

  expect(told).toMatchObject({
    outcome: "ok",
    reason: "sent to the run's Session",
    sessionId: run.sessionId,
  });

  expect(
    coordinator.delivered().some(({ text }) => text.includes('"number": 2')),
  ).toBe(true);

  expect(
    t.tool("routines", { action: "list" }, { session: coordinator }),
  ).rejects.toThrow("isn't offered");

  const other = await t.session({ owner: person("ana") });

  expect(
    t.tool("start_run", { prompt: "x", key: "1" }, { session: other }),
  ).rejects.toThrow("isn't offered");
});

test("a coordinator starts, lists, messages and stops the group's runs, and hears when one waits or ends", async () => {
  await using t = await started();
  const { run, host: coordinator } = await withPlanner(t);

  const child = await startRun(t, coordinator, "acme/shop#1");

  expect(child).toMatchObject({
    cause: "coordinator",
    outcome: "running",
    depth: 1,
  });

  expect(sessionOf(child.sessionId)).toMatchObject({
    agent: { name: "implementer" },
    firstMessage: "Fix acme/shop#1.",
    workspace: { kind: "repositories" },
  });

  expect(sessionOf(child.sessionId).systemPrompt).toContain(
    "The group's coordinator started this run",
  );

  const worker = await host(t, child);

  // Runs it starts can't start runs.
  expect(
    t.tool("start_run", { prompt: "x", key: "2" }, { session: worker }),
  ).rejects.toThrow("isn't offered");

  const listed = JSON.parse(
    await call(t, coordinator, "list_runs", {}),
  ) as unknown[];

  expect(listed).toMatchObject([
    {
      id: child.id,
      routine: "planner",
      key: "acme/shop#1",
      cause: "coordinator",
      outcome: "running",
      agent: "implementer",
    },
  ]);

  expect(
    await call(t, coordinator, "message_run", {
      id: child.id,
      text: "Use the new cart.",
    }),
  ).toBe(`Sent to run ${child.id}.`);

  expect(
    worker.delivered().some(({ text }) => text.includes("Use the new cart.")),
  ).toBe(true);

  // It waits on a person, and the coordinator hears of it.
  await worker.api.raw(`/runner/sessions/${worker.id}/ext/ask/questions`, {
    method: "POST",
    body: JSON.stringify({
      questions: [
        {
          id: "which",
          label: "Which",
          prompt: "Which cart?",
          context: null,
          type: "text",
          placeholder: null,
        },
      ],
      defaults: {},
    }),
  });

  await worker.turn([]);

  await until(
    () => coordinator.delivered(),
    (all) =>
      all.some(({ text }) => text.includes("waits on a person: Which cart?")),
  );

  const [open] = questions().open(child.sessionId ?? "");
  questions().answer(open?.id ?? "", { text: "The new one", by: "Ana" });
  await worker.report([{ type: "status", status: "running" }]);

  await call(t, worker, "end_run", {
    result: "done",
    summary: "Fixed the cart.",
    output: { pr: 12 },
  });

  await until(
    () => coordinator.delivered(),
    (all) =>
      all.some(({ text }) =>
        text.includes(
          `Run ${child.id} (implementer) for acme/shop#1 ended: ok, Fixed the cart.. Its output: {"pr":12}`,
        ),
      ),
  );

  const board = await t.as("ana").get<GroupDetail>("groups/shop");

  expect(
    board.work.find(({ key }) => key === "acme/shop#1")?.runs,
  ).toMatchObject([{ id: child.id, cause: "coordinator", outcome: "ok" }]);

  const second = await startRun(t, coordinator, "acme/shop#2");
  const before = coordinator.delivered().length;

  expect(await call(t, coordinator, "stop_run", { id: second.id })).toBe(
    `Stopped run ${second.id}.`,
  );

  expect(await runOf(t, second.id)).toMatchObject({
    outcome: "stopped",
    reason: "stopped by the group's coordinator",
  });

  expect(sessionOf(second.sessionId).archivedAt).not.toBeNull();
  expect(coordinator.delivered().length).toBe(before);

  expect(
    await failureOf(call(t, coordinator, "stop_run", { id: run.id })),
  ).toBe(`no run ${run.id} in the group`);
});

test("a coordinator has at most atOnce runs going, one per piece of work", async () => {
  await using t = await started();
  const { host: coordinator } = await withPlanner(t, { atOnce: 2 });

  const first = await startRun(t, coordinator, "a");
  await startRun(t, coordinator, "b");

  expect(await failureOf(startRun(t, coordinator, "c"))).toBe(
    "2 runs you started are going, and at most 2 go at once: wait for one to end",
  );

  await call(t, coordinator, "stop_run", { id: first.id });
  await coordinator.turn([]);

  expect(await failureOf(startRun(t, coordinator, "b"))).toContain(
    "is going for b: tell it with message_run",
  );

  expect(await startRun(t, coordinator, "c")).toMatchObject({
    outcome: "running",
  });
});

test("starting more than askAbove runs in one turn asks a person first", async () => {
  await using t = await started();
  const { run, host: coordinator } = await withPlanner(t, { askAbove: 1 });

  await startRun(t, coordinator, "a");

  const asked = await call(t, coordinator, "start_run", {
    agent: "implementer",
    prompt: "Fix b.",
    key: "b",
  });

  expect(asked).toContain("Asked a person first");

  const id = /Run (\S+) starts/.exec(asked)?.[1] ?? fail();

  expect(await runOf(t, id)).toMatchObject({ outcome: "queued" });

  const rejected = /Run (\S+) starts/.exec(
    await call(t, coordinator, "start_run", {
      agent: "implementer",
      prompt: "Fix c.",
      key: "c",
    }),
  )?.[1];

  const [approve, reject] = questions().open(run.sessionId ?? "");

  expect(approve?.questions).toMatchObject([
    { type: "single", prompt: "Start another run of implementer for b?" },
  ]);

  await coordinator.turn([]);

  await until(
    async () => runOf(t, run.id),
    (each) => each.outcome === "waiting",
  );

  questions().answer(approve?.id ?? "", { text: "approve", by: "Ana" });

  await until(
    async () => runOf(t, id),
    (each) => each.outcome === "running" && each.sessionId !== null,
  );

  questions().answer(reject?.id ?? "", { text: "reject", by: "Ana" });

  expect(
    await until(
      async () => runOf(t, rejected ?? ""),
      (each) => each.outcome === "skipped",
    ),
  ).toMatchObject({ reason: "Ana didn't approve starting it" });

  // A new turn starts counting again.
  await coordinator.report([{ type: "status", status: "running" }]);
  await coordinator.turn([]);

  expect(await startRun(t, coordinator, "d")).toMatchObject({
    outcome: "running",
  });
});

test("a coordinator whose context Pi compacted is swapped for a fresh Session that starts from the group's memory and its open runs", async () => {
  await using t = await started();
  const { run, host: coordinator } = await withPlanner(t);

  await coordinator.api.post("memory", { note: "Ship the cart first." });

  const child = await startRun(t, coordinator, "acme/shop#1");

  await coordinator.turn([
    { type: "compaction", summary: "We split the epic in three." },
  ]);

  const swapped = await until(
    async () => runOf(t, run.id),
    (each) => each.sessionId !== run.sessionId,
  );

  expect(swapped.outcome).toBe("running");
  expect(sessionOf(run.sessionId).archivedAt).not.toBeNull();

  const fresh = sessionOf(swapped.sessionId);

  expect(fresh.systemPrompt).toContain(
    'You are the coordinator of the group "Shop"',
  );

  expect(fresh.systemPrompt).toContain("We split the epic in three.");
  expect(fresh.systemPrompt).toContain("Ship the cart first.");

  expect(fresh.systemPrompt).toContain(
    `- ${child.id}: implementer for acme/shop#1, running`,
  );

  const next = await host(t, swapped);

  issue(2);
  await t.clock.advance("30s");

  expect(
    next.delivered().some(({ text }) => text.includes('"number": 2')),
  ).toBe(true);

  // The run it started still reports to it.
  await call(t, await host(t, child), "end_run", {
    result: "done",
    summary: "Fixed.",
  });

  await until(
    () => next.delivered(),
    (all) => all.some(({ text }) => text.includes("ended: ok, Fixed.")),
  );
});
