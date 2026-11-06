import { expect, test } from "bun:test";
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
        repository: Type.String(),
        number: Type.Number(),
        label: Type.String(),
      }),
    }),
  },
});

let tracking: ServerContext<typeof tracker> | undefined;

const trackerServer = defineServer(tracker, (context) => {
  tracking = context;
});

function issue(number: number, to: readonly Owner[], label = "pipoca"): void {
  tracking?.events.emit("issue", { repository: "o/r", number, label }, { to });
}

async function started(
  o: TestPluginOptions<typeof routines> = {},
): Promise<PluginTest> {
  return testPlugin(server, { people, plugins: [trackerServer], ...o });
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
    triggers: [{ at: inAnHour(t) }],
    run: { prompt: "Check the build.", workspace: folder() },
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
    triggers: [{ webhook: true }],
    run: { prompt: "Tidy up.", workspace: folder() },
  });

  const run = await t.as("ana").post<Run>("routines/tidy/run");
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
    triggers: [{ webhook: true }],
    run: { prompt: "Tidy up.", workspace: folder() },
  });

  const run = await t.as("ana").post<Run>("routines/tidy/run");
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
    triggers: [{ webhook: true }],
    run: { prompt: "Tidy up.", workspace: folder(), environment: "gone" },
  });

  for (let each = 0; each < 3; each++) {
    expect(await t.as("ana").post<Run>("routines/tidy/run")).toMatchObject({
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
    triggers: [{ webhook: true }],
    run: { prompt: "Tidy up.", workspace: folder() },
  });

  for (let each = 0; each < 3; each++) {
    const run = await t.as("ana").post<Run>("routines/tidy/run");
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
    triggers: [{ webhook: true }],
    run: { prompt: "Check the build.", workspace: folder() },
  });

  const run = await t.as("ana").post<Run>("routines/nightly/run");

  // Its host takes the Session in a new attempt, which ends the first, so
  // it has died before Pi says anything.
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

  await session.transcript([
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "On it." }],
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

test("a firing while the last run goes is skipped, or queued once when the routine says", async () => {
  await using t = await started();
  await environment(t);

  for (const [name, overlap] of [
    ["skips", "skip"],
    ["queues", "queue"],
  ] as const) {
    await save(t, name, {
      title: name,
      triggers: [{ webhook: true }],
      run: { prompt: "Tidy up.", workspace: folder() },
      overlap,
    });
  }

  expect(await t.as("ana").post<Run>("routines/skips/run")).toMatchObject({
    outcome: "running",
  });

  expect(await t.as("ana").post<Run>("routines/skips/run")).toMatchObject({
    outcome: "skipped",
    reason: "the last run was still going",
  });

  await t.as("ana").post("routines/queues/run");

  expect(await t.as("ana").post<Run>("routines/queues/run")).toMatchObject({
    outcome: "queued",
  });

  expect(await t.as("ana").post<Run>("routines/queues/run")).toMatchObject({
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
    triggers: [{ webhook: true }],
    run: { prompt: "Check the build.", workspace: folder() },
  });

  const first = await t.as("ana").post<Run>("routines/nightly/run");
  await (await t.attach(first.sessionId ?? "")).archive();

  const second = await t.as("ana").post<Run>("routines/nightly/run");
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

  expect(await t.as("ana").post<Run>("routines/nightly/run")).toMatchObject({
    outcome: "running",
  });

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
    triggers: [{ cron: "0 * * * *", timeZone: "UTC" }],
    run: { prompt: "Look.", workspace: folder() },
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
    triggers: [{ webhook: true }],
    run: { prompt: "Tidy up.", workspace: folder(), as: "pipoca-bot" },
  });

  const run = await t.as("ana").post<Run>("routines/tidy/run");

  expect(tracking?.sessions.get(run.sessionId ?? "")?.actsAs).toEqual({
    plugin: "git-hosts",
    name: "pipoca-bot",
  });
});

test("keeps the team's routines apart from a person's, stored as owned by no one", async () => {
  await using t = await started();

  const routine = {
    title: "Nightly",
    triggers: [{ cron: "0 3 * * *", timeZone: "UTC" }],
    run: { prompt: "Check the build.", workspace: folder() },
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

  const refused = await t.as("ana").raw("PUT", "team/routines/ping", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "Ping",
      triggers: [{ webhook: true }],
      run: { prompt: "Ping.", session: "s1" },
    }),
  });

  expect(refused.status).toBe(400);
});

test("a routine's file that doesn't fit names the field", async () => {
  await using t = await started();

  const bad = await t.as("ana").raw("PUT", "routines/nightly", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "", triggers: [], run: {} }),
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
    triggers: [{ event: "tracker.issue", filter: { label: "pipoca" } }],
    run: { prompt: "Fix the issue.", workspace: folder() },
    key: ["repository", "number"],
  };

  await save(t, "fix", routine);
  const { profileId } = tracking?.sessions.get(team.id) ?? {};

  await save(
    t,
    "fix",
    { ...routine, run: { ...routine.run, profile: profileId } },
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
    reason: "sent to the key's Session",
    sessionId: run?.sessionId,
  });
});

test("keyed runs past maxRunning wait their turn", async () => {
  await using t = await started();
  await environment(t);

  await save(t, "fix", {
    title: "Fix issues",
    triggers: [{ event: "tracker.issue" }],
    run: { prompt: "Fix the issue.", workspace: folder() },
    key: ["number"],
    maxRunning: 1,
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
    triggers: [{ event: "tracker.issue" }],
    run: { prompt: "Fix the issue.", workspace: folder() },
    key: ["number"],
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
    triggers: [{ webhook: true }],
    run: { prompt: "Look at it.", workspace: folder() },
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
      triggers: [{ webhook: true }],
      run: { prompt: "Look again.", session: target },
    });
  }

  expect(await t.as("ana").post<Run>("routines/mine/run")).toMatchObject({
    outcome: "ok",
  });

  await until(() => own.delivered().length > 0);

  expect(own.delivered()).toMatchObject([
    { text: "Look again.", notice: { kind: "routine" } },
  ]);

  expect(await runs(t, "mine")).toMatchObject([{ outcome: "ok" }]);
  await t.as("ana").post("routines/theirs/run");
  expect(await runs(t, "theirs")).toMatchObject([{ outcome: "blocked" }]);
});

test("a Session makes a routine only once its person allows it, and it runs once as a test", async () => {
  await using t = await started();
  const session = await environment(t);

  const routine = {
    title: "Summarise new issues",
    triggers: [{ cron: "0 8 * * 1-5", timeZone: "Europe/Berlin" }],
    run: { prompt: "Summarise them.", workspace: folder() },
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
    (await t.as("bo").raw("DELETE", `wakeups/${first?.id ?? ""}`)).status,
  ).toBe(404);

  expect(
    (await t.as("ana").raw("DELETE", `wakeups/${first?.id ?? ""}`)).status,
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
