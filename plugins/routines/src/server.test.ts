import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  definePlugin,
  defineServer,
  event,
  type Owner,
  type ServerContext,
  Type,
} from "@pipoca/plugins";
import {
  person,
  type PluginTest,
  type TestPluginOptions,
  testPlugin,
  until,
} from "@pipoca/testing";
import type { routines } from "../plugin";
import type { RoutineDetail, RoutineView, Run } from "./model";
import type { Routine } from "./routine";
import { server } from "./server";

const people = [
  { id: "ana", name: "Ana", admin: true },
  { id: "bo", name: "Bo" },
];

const minute = 60_000;

// A plugin that publishes the events routines hear, as git hosts do.
const tracker = definePlugin({
  id: "tracker",
  title: "Tracker",
  description: "Publishes issues.",
  works: ["personal", "team"],
  events: {
    issue: event({
      title: "An issue",
      fields: Type.Object({
        host: Type.String(),
        repository: Type.String(),
        number: Type.Number(),
        label: Type.String(),
        labels: Type.Array(Type.String()),
        paths: Type.Array(Type.String()),
        title: Type.String(),
      }),
    }),
  },
});

// Routines need subagents on, which find the agents runs start as.
const subagents = definePlugin({
  id: "subagents",
  title: "Subagents",
  description: "Finds agents.",
});

let tracking: ServerContext<typeof tracker> | undefined;

const trackerServer = defineServer(tracker, (context) => {
  tracking = context;
});

function issue(
  number: number,
  to: readonly Owner[],
  label = "pipoca",
  more: Partial<{ labels: string[]; paths: string[]; title: string }> = {},
): void {
  tracking?.events.emit(
    "issue",
    {
      host: "example.com",
      repository: "o/r",
      number,
      label,
      labels: [label],
      paths: [],
      title: "An issue",
      ...more,
    },
    { to },
  );
}

async function started(
  o: TestPluginOptions<typeof routines> = {},
): Promise<PluginTest> {
  return testPlugin(server, {
    people,
    plugins: [trackerServer, subagents],
    ...o,
  });
}

const inAnHour = (t: PluginTest): string =>
  new Date(t.clock.now() + 60 * minute).toISOString();

function folder(path = "/srv/a"): { kind: "folder"; path: string } {
  return { kind: "folder", path };
}

async function save(
  t: PluginTest,
  name: string,
  routine: object,
  as = "ana",
  prefix = "",
): Promise<RoutineDetail> {
  return t.as(as).put(`${prefix}routines/${name}`, routine);
}

async function detail(
  t: PluginTest,
  name: string,
  prefix = "",
): Promise<RoutineDetail> {
  return t.as("ana").get(`${prefix}routines/${name}`);
}

async function runs(
  t: PluginTest,
  name: string,
  prefix = "",
): Promise<readonly Run[]> {
  return (await detail(t, name, prefix)).runs;
}

// Runs need an Environment of their owner's to start in.
async function environment(t: PluginTest, owner: Owner = person("ana")) {
  return t.session({ owner, ...(owner === "team" && { startedBy: "ana" }) });
}

test("a scheduled routine fires at its time, also when the server restarted before it", async () => {
  await using t = await started();
  await environment(t);

  await save(t, "nightly", {
    title: "Nightly",
    when: [{ kind: "once", at: inAnHour(t) }],
    do: { kind: "session", prompt: "Check the build.", workspace: folder() },
  });

  const [listed] = await t.as("ana").get<RoutineView[]>("routines");
  expect(listed?.nextAt).toBe(inAnHour(t));

  await t.restart();
  await t.clock.advance("59m");
  expect(await runs(t, "nightly")).toEqual([]);

  await t.clock.advance("1m");
  const [run] = await runs(t, "nightly");

  expect(run).toMatchObject({ cause: "schedule", outcome: "running" });
  expect(run?.sessionId).toBeString();
  expect((await detail(t, "nightly")).nextAt).toBeNull();
});

test("a run by hand starts a Session that ends with end_run, which no other Session gets", async () => {
  await using t = await started();
  const own = await environment(t);

  await save(t, "tidy", {
    title: "Tidy",
    when: [{ kind: "webhook" }],
    do: { kind: "session", prompt: "Tidy up.", workspace: folder() },
  });

  const run = await t.as("ana").post<Run>("routines/tidy/run", {});
  expect(run).toMatchObject({ cause: "by hand", outcome: "running" });

  const session = await t.attach(run.sessionId ?? "");

  expect(
    t.tool("end_run", { result: "done", summary: "x" }, { session: own }),
  ).rejects.toThrow("isn't offered");

  expect(
    await t.tool(
      "end_run",
      { result: "done", summary: " three new issues " },
      { session },
    ),
  ).toEqual({ text: "Noted. End your turn.", isError: false });

  expect(await runs(t, "tidy")).toMatchObject([
    { outcome: "ok", reason: "three new issues" },
  ]);

  expect(
    await t.tool("end_run", { result: "done", summary: "again" }, { session }),
  ).toEqual({
    text: "this Session isn't a routine run that is going",
    isError: true,
  });
});

test("a run whose turn ends without end_run is stopped, and three that can't start pause the routine", async () => {
  await using t = await started();
  await environment(t);

  await save(t, "tidy", {
    title: "Tidy",
    when: [{ kind: "webhook" }],
    do: { kind: "session", prompt: "Tidy up.", workspace: folder() },
  });

  const run = await t.as("ana").post<Run>("routines/tidy/run", {});
  const session = tracking?.sessions.get(run.sessionId ?? "");

  if (session === undefined) {
    throw new Error("no run Session");
  }

  t.emit({ type: "TurnEnded", session });

  expect(await runs(t, "tidy")).toMatchObject([
    { outcome: "stopped", reason: "the turn ended without end_run" },
  ]);

  await save(t, "tidy", {
    title: "Tidy",
    when: [{ kind: "webhook" }],
    do: {
      kind: "session",
      prompt: "Tidy up.",
      workspace: folder(),
      environment: "gone",
    },
  });

  for (let each = 0; each < 3; each++) {
    expect(await t.as("ana").post<Run>("routines/tidy/run", {})).toMatchObject({
      outcome: "blocked",
    });
  }

  expect((await detail(t, "tidy")).paused).toStartWith(
    "Paused after 3 failed runs in a row.",
  );
});

test("a run the agent ends as blocked doesn't count towards pausing the routine", async () => {
  await using t = await started();
  await environment(t);

  await save(t, "tidy", {
    title: "Tidy",
    when: [{ kind: "webhook" }],
    do: { kind: "session", prompt: "Tidy up.", workspace: folder() },
  });

  for (let each = 0; each < 3; each++) {
    const run = await t.as("ana").post<Run>("routines/tidy/run", {});
    const session = await t.attach(run.sessionId ?? "");

    await t.tool(
      "end_run",
      { result: "blocked", summary: "Which branch?" },
      { session },
    );
  }

  expect((await runs(t, "tidy")).map(({ outcome }) => outcome)).toEqual([
    "blocked",
    "blocked",
    "blocked",
  ]);

  expect((await detail(t, "tidy")).paused).toBeNull();
});

test("a run whose Session dies five times without progress parks the routine", async () => {
  await using t = await started();
  await environment(t);

  await save(t, "nightly", {
    title: "Nightly",
    when: [{ kind: "webhook" }],
    do: { kind: "session", prompt: "Check the build.", workspace: folder() },
  });

  const run = await t.as("ana").post<Run>("routines/nightly/run", {});

  // Its host takes the Session in a new attempt, which ends the first, so
  // it has died before Pi does anything.
  const session = await t.attach(run.sessionId ?? "");

  const dies = (times: number): void => {
    const died = tracking?.sessions.get(run.sessionId ?? "");

    for (let each = 0; died !== undefined && each < times; each++) {
      t.emit({
        type: "SessionStateChanged",
        session: { ...died, status: "interrupted" },
        previous: "running",
      });
    }
  };

  const pi = (content: unknown): object => ({
    type: "message",
    message: { role: "assistant", content },
  });

  await session.transcript([pi([{ type: "text", text: "On it." }])]);
  dies(2);

  await session.transcript([
    pi([{ type: "toolCall", id: "t1", name: "bash", arguments: {} }]),
    {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "t1",
        toolName: "bash",
        content: [{ type: "text", text: "ok" }],
      },
    },
  ]);

  dies(4);
  const going = await detail(t, "nightly");
  dies(1);

  expect(going).toMatchObject({ paused: null, runs: [{ outcome: "running" }] });

  expect(await detail(t, "nightly")).toMatchObject({
    paused: "Parked after a run's Session died 5 times without progress.",
    runs: [
      {
        outcome: "failed",
        reason: "the run's Session died 5 times without progress",
      },
    ],
  });

  expect(
    tracking?.sessions.get(run.sessionId ?? "")?.archivedAt,
  ).not.toBeNull();
});

test("a run keeps the progress of its earlier turns when a new turn starts", async () => {
  await using t = await started();
  await environment(t);

  await save(t, "nightly", {
    title: "Nightly",
    when: [{ kind: "webhook" }],
    do: { kind: "session", prompt: "Check the build.", workspace: folder() },
  });

  const run = await t.as("ana").post<Run>("routines/nightly/run", {});
  const session = await t.attach(run.sessionId ?? "");

  const dies = (times: number): void => {
    const died = tracking?.sessions.get(run.sessionId ?? "");

    for (let each = 0; died !== undefined && each < times; each++) {
      t.emit({
        type: "SessionStateChanged",
        session: { ...died, status: "interrupted" },
        previous: "running",
      });
    }
  };

  const bash = (id: string): object[] => [
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id, name: "bash", arguments: {} }],
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: id,
        toolName: "bash",
        content: [{ type: "text", text: "ok" }],
      },
    },
  ];

  await session.transcript([...bash("t1"), ...bash("t2"), ...bash("t3")]);
  dies(1);

  await session.transcript([
    { type: "custom_message", customType: "pipoca-notice", content: "Again." },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Looking again." }],
      },
    },
  ]);

  dies(4);

  expect(await detail(t, "nightly")).toMatchObject({
    paused: null,
    runs: [{ outcome: "running" }],
  });
});

test("a firing while the last run goes is skipped, or queued once when the routine says", async () => {
  await using t = await started();
  await environment(t);

  for (const [name, overlap] of [
    ["skips", "skip"],
    ["queues", "queue"],
  ] as const) {
    await save(t, name, {
      title: name,
      when: [{ kind: "webhook" }],
      do: { kind: "session", prompt: "Tidy up.", workspace: folder() },
      sameWork: { whileRunning: overlap },
    });
  }

  expect(await t.as("ana").post<Run>("routines/skips/run", {})).toMatchObject({
    outcome: "running",
  });

  expect(await t.as("ana").post<Run>("routines/skips/run", {})).toMatchObject({
    outcome: "skipped",
    reason: "the same work has a run going",
  });

  await t.as("ana").post("routines/queues/run", {});

  expect(await t.as("ana").post<Run>("routines/queues/run", {})).toMatchObject({
    outcome: "queued",
  });

  expect(await t.as("ana").post<Run>("routines/queues/run", {})).toMatchObject({
    outcome: "skipped",
  });

  const [, , going] = await runs(t, "queues");
  const session = await t.attach(going?.sessionId ?? "");
  await t.tool("end_run", { result: "done", summary: "Tidied." }, { session });

  expect((await runs(t, "queues")).map(({ outcome }) => outcome)).toEqual([
    "skipped",
    "running",
    "ok",
  ]);
});

test("a run ends when its Session is archived or stopped, so the next firing runs", async () => {
  await using t = await started();
  await environment(t);

  await save(t, "nightly", {
    title: "Nightly",
    when: [{ kind: "webhook" }],
    do: { kind: "session", prompt: "Check the build.", workspace: folder() },
  });

  const first = await t.as("ana").post<Run>("routines/nightly/run", {});
  await (await t.attach(first.sessionId ?? "")).archive();

  const second = await t.as("ana").post<Run>("routines/nightly/run", {});
  expect(second).toMatchObject({ outcome: "running" });

  const session = tracking?.sessions.get(second.sessionId ?? "");

  if (session === undefined) {
    throw new Error("no run Session");
  }

  t.emit({
    type: "SessionStateChanged",
    session: { ...session, status: "stopped" },
    previous: session.status,
  });

  expect(await t.as("ana").post<Run>("routines/nightly/run", {})).toMatchObject(
    {
      outcome: "running",
    },
  );

  expect((await runs(t, "nightly")).map(({ outcome }) => outcome)).toEqual([
    "running",
    "stopped",
    "stopped",
  ]);
});

test("firings missed while time jumped ahead become one catch-up run", async () => {
  await using t = await started();
  await environment(t);

  await save(t, "hourly", {
    title: "Hourly",
    when: [{ kind: "schedule", cron: "0 * * * *", timeZone: "UTC" }],
    do: { kind: "session", prompt: "Look.", workspace: folder() },
  });

  await t.clock.advance("5h");

  expect(await runs(t, "hourly")).toMatchObject([{ cause: "schedule" }]);

  expect(Date.parse((await detail(t, "hourly")).nextAt ?? "")).toBeGreaterThan(
    t.clock.now(),
  );
});

test("a run acts as the technical user its routine names", async () => {
  await using t = await started();
  await environment(t);

  await save(t, "tidy", {
    title: "Tidy",
    when: [{ kind: "webhook" }],
    do: {
      kind: "session",
      prompt: "Tidy up.",
      workspace: folder(),
      as: "pipoca-bot",
    },
  });

  const run = await t.as("ana").post<Run>("routines/tidy/run", {});

  expect(tracking?.sessions.get(run.sessionId ?? "")?.actsAs).toEqual({
    plugin: "git-hosts",
    name: "pipoca-bot",
  });
});

test("keeps the team's routines apart from a person's, stored as owned by no one", async () => {
  await using t = await started();

  const routine = {
    title: "Nightly",
    when: [{ kind: "schedule", cron: "0 3 * * *", timeZone: "UTC" }],
    do: { kind: "session", prompt: "Check the build.", workspace: folder() },
  };

  await save(t, "nightly", routine);
  await save(t, "weekly", { ...routine, title: "Weekly" }, "bo", "team/");

  expect(
    (await t.as("ana").get<RoutineView[]>("routines")).map(({ name }) => name),
  ).toEqual(["nightly"]);

  expect(
    (await t.as("bo").get<RoutineView[]>("routines")).map(({ name }) => name),
  ).toEqual([]);

  expect(
    (await t.as("ana").get<RoutineView[]>("team/routines")).map(
      ({ name }) => name,
    ),
  ).toEqual(["weekly"]);

  expect(
    t.store.all("select owner_user_id, name from routines_state order by name"),
  ).toEqual([
    { owner_user_id: "ana", name: "nightly" },
    { owner_user_id: null, name: "weekly" },
  ]);

  const refused = await t.as("ana").raw("team/routines/ping", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "Ping",
      when: [{ kind: "webhook" }],
      do: { kind: "message", prompt: "Ping.", session: "s1" },
    }),
  });

  expect(refused.status).toBe(400);
});

test("a routine's file that doesn't fit names the field", async () => {
  await using t = await started();

  const bad = await t.as("ana").raw("routines/nightly", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "", when: [], do: {} }),
  });

  expect(bad.status).toBe(422);
  expect(await t.as("ana").get("routines")).toEqual([]);
});

test("an event reaches the routines of the owners it names, batched by key", async () => {
  await using t = await started();
  await environment(t);
  const team = await environment(t, "team");

  const routine = {
    title: "Fix issues",
    when: [
      {
        kind: "event",
        event: "tracker.issue",
        where: [{ field: "label", is: "pipoca" }],
      },
    ],
    do: { kind: "session", prompt: "Fix the issue.", workspace: folder() },
    sameWork: { key: ["repository", "number"] },
  };

  await save(t, "fix", routine);
  const { profileId } = tracking?.sessions.get(team.id) ?? {};

  await save(
    t,
    "fix",
    { ...routine, do: { ...routine.do, profile: profileId } },
    "ana",
    "team/",
  );

  issue(1, [person("bo")]);
  issue(1, [person("ana")], "other");
  await t.clock.advance("1m");
  expect(await runs(t, "fix")).toEqual([]);

  issue(7, [person("ana"), "team"]);
  await t.clock.advance("10s");
  issue(7, [person("ana")]);
  await t.clock.advance("29s");
  expect(await runs(t, "fix")).toEqual([]);

  await t.clock.advance("1s");
  const [run] = await runs(t, "fix");
  expect(run).toMatchObject({ cause: "event", outcome: "running" });
  expect(await runs(t, "fix", "team/")).toMatchObject([{ outcome: "running" }]);

  const session = await t.attach(run?.sessionId ?? "");

  issue(7, [person("ana")]);
  await t.clock.advance("30s");

  expect(session.delivered().at(-1)).toMatchObject({
    turn: true,
    notice: { kind: "routine_events", data: { count: 1 } },
  });

  expect((await runs(t, "fix"))[0]).toMatchObject({
    outcome: "ok",
    reason: "sent to the run's Session",
    sessionId: run?.sessionId,
  });
});

test("keyed runs past maxRunning wait their turn", async () => {
  await using t = await started();
  await environment(t);

  await save(t, "fix", {
    title: "Fix issues",
    when: [{ kind: "event", event: "tracker.issue" }],
    do: { kind: "session", prompt: "Fix the issue.", workspace: folder() },
    sameWork: { key: ["number"] },
    limits: { maxRunning: 1 },
  });

  issue(1, [person("ana")]);
  issue(2, [person("ana")]);
  await t.clock.advance("30s");

  const [second, first] = await runs(t, "fix");
  expect([first?.outcome, second?.outcome]).toEqual(["running", "queued"]);

  const session = await t.attach(first?.sessionId ?? "");
  await t.tool("end_run", { result: "nothing", summary: "-" }, { session });

  expect((await runs(t, "fix")).map(({ outcome }) => outcome)).toEqual([
    "running",
    "nothing",
  ]);
});

test("a key that keeps getting events still gets through after five minutes", async () => {
  await using t = await started();
  await environment(t);

  await save(t, "fix", {
    title: "Fix issues",
    when: [{ kind: "event", event: "tracker.issue" }],
    do: { kind: "session", prompt: "Fix the issue.", workspace: folder() },
    sameWork: { key: ["number"] },
  });

  for (let each = 0; each < 14; each++) {
    issue(1, [person("ana")]);
    await t.clock.advance("20s");
  }

  expect(await runs(t, "fix")).toEqual([]);

  await t.clock.advance("20s");
  expect(await runs(t, "fix")).toMatchObject([{ outcome: "running" }]);
});

test("a webhook's signed delivery starts a run", async () => {
  await using t = await started();
  await environment(t);

  const { webhook } = await save(t, "hook", {
    title: "On a hook",
    when: [{ kind: "webhook" }],
    do: { kind: "session", prompt: "Look at it.", workspace: folder() },
  });

  const path = (webhook?.path ?? "").replace("/api/ext/routines/", "");
  const secret = webhook?.secret ?? "";
  const body = JSON.stringify({ hello: "world" });

  expect((await t.public().webhook(path, body, "wrong")).status).toBe(401);
  expect((await t.public().webhook(path, body, secret)).status).toBe(202);

  await t.clock.advance("30s");

  expect(await runs(t, "hook")).toMatchObject([
    { cause: "event", outcome: "running" },
  ]);
});

test("a routine that messages a Session reaches only its owner's", async () => {
  await using t = await started();
  const own = await environment(t);
  const bos = await environment(t, person("bo"));

  for (const [name, target] of [
    ["mine", own.id],
    ["theirs", bos.id],
  ] as const) {
    await save(t, name, {
      title: name,
      when: [{ kind: "webhook" }],
      do: { kind: "message", prompt: "Look again.", session: target },
    });
  }

  expect(await t.as("ana").post<Run>("routines/mine/run", {})).toMatchObject({
    outcome: "ok",
  });

  await until(() => own.delivered().length > 0);

  expect(own.delivered()).toMatchObject([
    { text: "Look again.", notice: { kind: "routine" } },
  ]);

  expect(await runs(t, "mine")).toMatchObject([{ outcome: "ok" }]);
  await t.as("ana").post("routines/theirs/run", {});
  expect(await runs(t, "theirs")).toMatchObject([{ outcome: "blocked" }]);
});

test("a routine messages team work only its owner steers", async () => {
  await using t = await started();

  const watched = await t.session({
    owner: "team",
    startedBy: "bo",
    access: { kind: "view" },
  });

  await save(t, "nudge", {
    title: "Nudge",
    when: [{ kind: "webhook" }],
    do: { kind: "message", prompt: "Do as Ana says.", session: watched.id },
  });

  await t.as("ana").post("routines/nudge/run", {});

  expect(await runs(t, "nudge")).toMatchObject([{ outcome: "blocked" }]);
  expect(watched.delivered()).toEqual([]);
});

test("a Session makes a routine only once its person allows it, and it runs once as a test", async () => {
  await using t = await started();
  const session = await environment(t);

  const routine = {
    title: "Summarise new issues",
    when: [
      { kind: "schedule", cron: "0 8 * * 1-5", timeZone: "Europe/Berlin" },
    ],
    do: { kind: "session", prompt: "Summarise them.", workspace: folder() },
  };

  const create = {
    action: "create",
    name: "daily-issues",
    routine,
    summary: "Every weekday at 08:00 Berlin time, summarise new issues.",
  };

  expect(await t.tool("routines", create, { session, answer: "deny" })).toEqual(
    { text: "The person said no.", isError: true },
  );

  expect(await t.as("ana").get("routines")).toEqual([]);

  const made = await t.tool("routines", create, { session, answer: "allow" });

  expect(made.text).toContain("ran it once as a test");
  expect(await runs(t, "daily-issues")).toMatchObject([{ cause: "by hand" }]);

  const listed = await t.tool("routines", { action: "list" }, { session });
  expect(JSON.parse(listed.text)).toMatchObject([{ name: "daily-issues" }]);

  const [run] = await runs(t, "daily-issues");
  const inRun = await t.attach(run?.sessionId ?? "");

  expect(
    t.tool("routines", { action: "list" }, { session: inRun }),
  ).rejects.toThrow("isn't offered");
});

test("a team Session isn't offered the routines tool, but wakes itself up", async () => {
  await using t = await started();
  const team = await environment(t, "team");

  expect(
    t.tool("routines", { action: "list" }, { session: team }),
  ).rejects.toThrow("isn't offered");

  expect(
    (
      await t.tool(
        "schedule_wakeup",
        { delay_minutes: 5, reason: "Later", message: "Look again." },
        { session: team },
      )
    ).isError,
  ).toBe(false);
});

test("a wake-up comes back as a notice at its time, after a restart too", async () => {
  await using t = await started();
  const session = await environment(t);

  const scheduled = await t.tool(
    "schedule_wakeup",
    {
      delay_minutes: 30,
      reason: "Check CI",
      message: "See whether CI passed.",
    },
    { session },
  );

  expect(scheduled.isError).toBe(false);

  const [pending] = await t
    .as("ana")
    .get<{ id: string; reason: string }[]>("wakeups", { session: session.id });

  expect(pending?.reason).toBe("Check CI");
  expect(await t.as("bo").get("wakeups", { session: session.id })).toEqual([]);

  await t.restart();
  await t.clock.advance("30m");
  await until(() => session.delivered().length > 0);

  expect(session.delivered()).toEqual([
    {
      text: "Wake-up you scheduled: Check CI\n\nSee whether CI passed.",
      turn: true,
      notice: {
        kind: "wakeup",
        plugin: "routines",
        data: { reason: "Check CI" },
      },
    },
  ]);

  expect(await t.as("ana").get("wakeups", { session: session.id })).toEqual([]);
});

test("a wake-up keeps to its limits: 1 minute to the configured days, 10 pending", async () => {
  await using t = await started({ config: { wakeUpDays: 2 } });
  const session = await environment(t);

  const wake = async (input: object) =>
    t.tool(
      "schedule_wakeup",
      { reason: "Later", message: "Look again.", ...input },
      { session },
    );

  expect(await wake({ delay_minutes: 0.5 })).toEqual({
    text: "a wake-up must be 1 minute to 2 days ahead",
    isError: true,
  });

  expect((await wake({ delay_minutes: 3 * 24 * 60 })).isError).toBe(true);
  expect((await wake({ at: "tomorrow" })).isError).toBe(true);

  for (let each = 0; each < 10; each++) {
    expect((await wake({ delay_minutes: 5 + each })).isError).toBe(false);
  }

  expect((await wake({ delay_minutes: 60 })).text).toContain(
    "already has 10 pending wake-ups",
  );

  const listed = await t.tool(
    "schedule_wakeup",
    { action: "list" },
    { session },
  );

  const id = listed.text.split(":")[0] ?? "";

  expect(
    await t.tool("schedule_wakeup", { action: "cancel", id }, { session }),
  ).toEqual({ text: `Cancelled wake-up ${id}.`, isError: false });

  const [first] = await t
    .as("ana")
    .get<{ id: string }[]>("wakeups", { session: session.id });

  expect(
    (await t.as("bo").raw(`wakeups/${first?.id ?? ""}`, { method: "DELETE" }))
      .status,
  ).toBe(404);

  expect(
    (await t.as("ana").raw(`wakeups/${first?.id ?? ""}`, { method: "DELETE" }))
      .status,
  ).toBe(200);

  await session.archive();

  expect(await t.as("ana").get("wakeups", { session: session.id })).toEqual([]);
});

test("a Session wakes up at most 48 times a day", async () => {
  await using t = await started();
  const session = await environment(t);

  for (let each = 0; each < 48; each++) {
    await t.tool(
      "schedule_wakeup",
      { delay_minutes: 1, reason: "Again", message: "Again." },
      { session },
    );

    await t.clock.advance("1m");
  }

  expect(
    (
      await t.tool(
        "schedule_wakeup",
        { delay_minutes: 1, reason: "Again", message: "Again." },
        { session },
      )
    ).text,
  ).toBe("this Session woke up 48 times in the last day, the most it may");
});

function sessionOf(run: Run | undefined) {
  const session = tracking?.sessions.get(run?.sessionId ?? "");

  if (session === undefined) {
    throw new Error("no run Session");
  }

  return session;
}

async function finish(t: PluginTest, run: Run | undefined): Promise<void> {
  const session = await t.attach(run?.sessionId ?? "");
  await t.tool("end_run", { result: "done", summary: "Done." }, { session });
}

test("reads a routine file in the first shape as the new one, and saving writes the new shape", async () => {
  await using t = await started();
  await environment(t);

  const dir = join(dirname(tracking?.config.dir ?? ""), "routines", "ana");
  mkdirSync(dir, { recursive: true });

  writeFileSync(
    join(dir, "fix.json"),
    JSON.stringify({
      title: "Fix issues",
      triggers: [
        { event: "tracker.issue", filter: { label: "pipoca", number: [7, 8] } },
        { webhook: true },
      ],
      run: { prompt: "Fix it.", workspace: folder() },
      key: ["number"],
      maxRunning: 2,
    }),
  );

  await t.restart();

  const routine: Routine = {
    title: "Fix issues",
    when: [
      {
        kind: "event",
        event: "tracker.issue",
        where: [
          { field: "label", is: "pipoca" },
          { field: "number", oneOf: [7, 8] },
        ],
      },
      { kind: "webhook" },
    ],
    sameWork: { key: ["number"] },
    do: { kind: "session", prompt: "Fix it.", workspace: folder() },
    limits: { maxRunning: 2 },
  };

  expect((await detail(t, "fix")).routine).toEqual(routine);

  issue(9, [person("ana")]);
  issue(7, [person("ana")]);
  await t.clock.advance("30s");
  expect(await runs(t, "fix")).toMatchObject([{ outcome: "running" }]);

  await save(t, "fix", routine);

  expect(JSON.parse(readFileSync(join(dir, "fix.json"), "utf8"))).toEqual(
    routine,
  );
});

test("refuses a routine whose event, fields or inputs don't exist", async () => {
  await using t = await started();

  const on = (where: object[], prompt = "Fix it.") => ({
    title: "Fix issues",
    when: [{ kind: "event", event: "tracker.issue", where }],
    do: { kind: "session", prompt, workspace: folder() },
  });

  expect(
    save(t, "fix", {
      ...on([]),
      when: [{ kind: "event", event: "tracker.nope" }],
    }),
  ).rejects.toThrow("when.0: no event tracker.nope");

  expect(save(t, "fix", on([{ field: "lable", is: "x" }]))).rejects.toThrow(
    "when.0.where.0: the event has no field lable",
  );

  expect(
    save(t, "fix", on([{ field: "number", is: "seven" }])),
  ).rejects.toThrow('number holds a number, not "seven"');

  expect(
    save(t, "fix", on([{ field: "number", startsWith: "1" }])),
  ).rejects.toThrow("number isn't text");

  expect(save(t, "fix", on([], "Fix {{inputs.focus}}."))).rejects.toThrow(
    "{{inputs.focus}}: no input focus",
  );

  expect(await t.as("ana").get("routines")).toEqual([]);

  await save(t, "fix", on([{ field: "labels", contains: "bug" }]));
  expect(await t.as("ana").get("routines")).toMatchObject([{ name: "fix" }]);
});

test("conditions hold on an event's fields, a list's when one of its items does", async () => {
  await using t = await started();
  await environment(t);

  const conditions = {
    "is-not": { field: "label", isNot: "wontfix" },
    "one-of": { field: "number", oneOf: [1, 2] },
    contains: { field: "labels", contains: "bug" },
    "starts-with": { field: "title", startsWith: "[docs]" },
    matches: { field: "paths", matches: "docs/**" },
  };

  for (const [name, where] of Object.entries(conditions)) {
    await save(t, name, {
      title: name,
      when: [{ kind: "event", event: "tracker.issue", where: [where] }],
      do: { kind: "session", prompt: "Look.", workspace: folder() },
    });
  }

  const ran = async () =>
    Object.fromEntries(
      await Promise.all(
        Object.keys(conditions).map(async (name) => [
          name,
          (await runs(t, name)).length,
        ]),
      ),
    ) as Record<string, number>;

  issue(1, [person("ana")], "wontfix", { paths: ["src/a.ts"] });
  await t.clock.advance("30s");

  expect(await ran()).toEqual({
    "is-not": 0,
    "one-of": 1,
    contains: 0,
    "starts-with": 0,
    matches: 0,
  });

  issue(5, [person("ana")], "bug", {
    labels: ["p1", "bug"],
    paths: ["src/a.ts", "docs/guide/a.md"],
    title: "[docs] A typo",
  });

  await t.clock.advance("30s");

  expect(await ran()).toEqual({
    "is-not": 1,
    "one-of": 1,
    contains: 1,
    "starts-with": 1,
    matches: 1,
  });
});

test("inputs come from Run now, a webhook's body and a trigger's inputs, and event text is marked as outside input", async () => {
  await using t = await started();
  await environment(t);

  const { webhook } = await save(t, "look", {
    title: "Look",
    when: [
      { kind: "webhook" },
      {
        kind: "event",
        event: "tracker.issue",
        inputs: { focus: "issue {{event.number}}" },
      },
    ],
    inputs: {
      focus: { type: "string", default: "everything" },
      depth: { type: "number", default: 1 },
      mode: { type: "oneOf", values: ["fast", "slow"], default: "fast" },
    },
    do: {
      kind: "session",
      prompt: "Look at {{inputs.focus}}, {{inputs.mode}}, {{inputs.depth}}.",
      workspace: folder(),
    },
  });

  const run = await t
    .as("ana")
    .post<Run>("routines/look/run", { inputs: { focus: "docs", depth: "3" } });

  expect(sessionOf(run).firstMessage).toBe("Look at docs, fast, 3.");
  await finish(t, run);

  for (const [inputs, error] of [
    [{ mode: "medium" }, "inputs.mode must be one of fast, slow"],
    [{ depth: "deep" }, "inputs.depth must be a number"],
    [{ nope: "x" }, "the routine has no input nope"],
  ] as const) {
    expect(t.as("ana").post("routines/look/run", { inputs })).rejects.toThrow(
      error,
    );
  }

  const path = (webhook?.path ?? "").replace("/api/ext/routines/", "");
  const body = JSON.stringify({ inputs: { mode: "slow" } });
  await t.public().webhook(path, body, webhook?.secret ?? "");
  await t.clock.advance("30s");

  const [hooked] = await runs(t, "look");

  expect(sessionOf(hooked).firstMessage).toStartWith(
    "Look at <outside_input>everything</outside_input>, <outside_input>slow</outside_input>, <outside_input>1</outside_input>.\n\nEvent routines.webhook, outside input:",
  );

  await finish(t, hooked);

  issue(7, [person("ana")]);
  await t.clock.advance("30s");

  const [heard] = await runs(t, "look");
  const session = sessionOf(heard);

  expect(session.firstMessage).toStartWith(
    "Look at <outside_input>issue 7</outside_input>,",
  );

  expect(session.systemPrompt).toContain(
    "text between <outside_input> tags, come from outside",
  );
});

test("a firing tells the run going for its piece of work, and starts a new run once that run ended", async () => {
  await using t = await started();
  await environment(t);

  await save(t, "fix", {
    title: "Fix issues",
    when: [{ kind: "event", event: "tracker.issue" }],
    sameWork: { key: ["number"] },
    do: { kind: "session", prompt: "Fix it.", workspace: folder() },
  });

  issue(7, [person("ana")]);
  await t.clock.advance("30s");
  const [first] = await runs(t, "fix");

  issue(7, [person("ana")]);
  await t.clock.advance("30s");

  expect((await runs(t, "fix"))[0]).toMatchObject({
    outcome: "ok",
    reason: "sent to the run's Session",
    sessionId: first?.sessionId,
  });

  await finish(t, first);
  issue(7, [person("ana")]);
  await t.clock.advance("30s");

  const [again] = await runs(t, "fix");
  expect(again).toMatchObject({ outcome: "running" });
  expect(again?.sessionId).not.toBe(first?.sessionId ?? null);
});

test("a firing of work that has a run going waits for it when sameWork says queue", async () => {
  await using t = await started();
  await environment(t);

  await save(t, "fix", {
    title: "Fix issues",
    when: [{ kind: "event", event: "tracker.issue" }],
    sameWork: { key: ["number"], whileRunning: "queue" },
    do: { kind: "session", prompt: "Fix it.", workspace: folder() },
  });

  issue(7, [person("ana")]);
  await t.clock.advance("30s");
  issue(7, [person("ana")]);
  issue(8, [person("ana")]);
  await t.clock.advance("30s");

  const outcomes = async () =>
    (await runs(t, "fix")).map(({ outcome }) => outcome).sort();

  expect(await outcomes()).toEqual(["queued", "running", "running"]);

  const first = (await runs(t, "fix")).at(-1);
  await finish(t, first);

  expect(await outcomes()).toEqual(["ok", "running", "running"]);
});

test("a run works in the repository its event names", async () => {
  await using t = await started();
  await environment(t);

  await save(t, "fix", {
    title: "Fix issues",
    when: [{ kind: "event", event: "tracker.issue" }],
    do: {
      kind: "session",
      prompt: "Fix it.",
      workspace: { kind: "event-repository" },
    },
  });

  issue(7, [person("ana")]);
  await t.clock.advance("30s");

  const [run] = await runs(t, "fix");

  expect(sessionOf(run).workspace).toMatchObject({
    kind: "clone",
    repository: "https://example.com/o/r",
  });

  await finish(t, run);
  await t.as("ana").post("routines/fix/run", {});

  expect((await runs(t, "fix"))[0]).toMatchObject({
    outcome: "blocked",
    reason: "the event names no repository",
  });
});

test("a scheduled trigger fills the inputs it names", async () => {
  await using t = await started();
  await environment(t);

  await save(t, "nightly", {
    title: "Nightly",
    when: [
      { kind: "once", at: inAnHour(t), inputs: { focus: "the build" } },
      { kind: "webhook" },
    ],
    inputs: { focus: { type: "string", required: true } },
    do: {
      kind: "session",
      prompt: "Check {{inputs.focus}}.",
      workspace: folder(),
    },
  });

  expect(t.as("ana").post("routines/nightly/run", {})).rejects.toThrow(
    "inputs.focus is required",
  );

  await t.clock.advance("1h");
  const [run] = await runs(t, "nightly");

  expect(sessionOf(run).firstMessage).toBe("Check the build.");
});

test("a run starts as the agent its routine names, keeping the tools a run needs", async () => {
  await using t = await started();
  await environment(t);

  await save(t, "fix", {
    title: "Fix",
    when: [{ kind: "webhook" }],
    do: {
      kind: "session",
      agent: "implementer",
      prompt: "Fix it.",
      workspace: folder(),
    },
  });

  const run = await t.as("ana").post<Run>("routines/fix/run", {});

  expect(tracking?.sessions.get(run.sessionId ?? "")).toMatchObject({
    agent: { name: "implementer", keep: ["end_run", "ask_user", "propose"] },
    firstMessage: "Fix it.",
  });
});

test("a trigger's agent or workflow takes the place of the routine's, and a workflow starts at once with the inputs as its args", async () => {
  await using t = await started();
  await environment(t);

  const labelled = (label: string, start: object) => ({
    kind: "event",
    event: "tracker.issue",
    where: [{ field: "label", is: label }],
    inputs: { focus: "{{event.title}}" },
    ...start,
  });

  await save(t, "triage", {
    title: "Triage",
    when: [
      labelled("docs", { agent: "write-docs" }),
      labelled("bug", { workflow: "fix-bug" }),
      labelled("other", {}),
    ],
    inputs: { focus: { type: "string", default: "" } },
    sameWork: { key: ["number"] },
    do: {
      kind: "session",
      agent: "triager",
      prompt: "Look at it.",
      workspace: folder(),
    },
  });

  issue(1, [person("ana")], "docs");
  issue(2, [person("ana")], "bug", { title: "Crash  on save" });
  issue(3, [person("ana")], "other");
  await t.clock.advance("30s");

  const begun = (await runs(t, "triage")).map(({ sessionId }) =>
    tracking?.sessions.get(sessionId ?? ""),
  );

  const startedFor = (number: number) =>
    begun.find((session) =>
      (session?.firstMessage ?? "").includes(`"number": ${String(number)}`),
    );

  expect(startedFor(1)?.agent?.name).toBe("write-docs");
  expect(startedFor(3)?.agent?.name).toBe("triager");

  const workflow = begun.find((session) => session?.agent === null);

  expect(workflow?.firstMessage).toBe(
    '/workflow fix-bug {"focus":"Crash  on save"}',
  );

  expect(workflow?.systemPrompt).toContain("started the workflow fix-bug");
});

test("a run starts an agent or a workflow, and only a workflow's needs no prompt", async () => {
  await using t = await started();

  const put = async (routine: object) =>
    (
      await t.as("ana").raw("routines/x", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(routine),
      })
    ).status;

  const routine = (work: object, trigger: object = {}) => ({
    title: "X",
    when: [{ kind: "webhook", ...trigger }],
    do: { kind: "session", workspace: folder(), ...work },
  });

  expect(await put(routine({ workflow: "release" }))).toBe(200);

  expect(await put(routine({ agent: "a", workflow: "b", prompt: "Go." }))).toBe(
    400,
  );

  expect(
    await put(routine({ prompt: "Go." }, { agent: "a", workflow: "b" })),
  ).toBe(400);

  expect(await put(routine({ workflow: "release" }, { agent: "a" }))).toBe(400);
  expect(await put(routine({ agent: "a" }))).toBe(400);
  expect(await put(routine({ agent: "has space", prompt: "Go." }))).toBe(422);
});
