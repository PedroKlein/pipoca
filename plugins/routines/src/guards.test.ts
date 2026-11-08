import { expect, test } from "bun:test";
import {
  definePlugin,
  defineServer,
  event,
  type Owner,
  type ServerContext,
  Type,
} from "@pipoca/plugins";
import { person, type PluginTest, testPlugin } from "@pipoca/testing";
import { usage } from "@pipoca/usage/plugin";
import type { RoutineDetail, Run } from "./model";
import { server } from "./server";

const people = [{ id: "ana", name: "Ana", admin: true }];

const minute = 60_000;

const authored = {
  host: Type.String(),
  repository: Type.String(),
  number: Type.Number(),
  sender: Type.String(),
  member: Type.Boolean(),
};

// Stands in for the git hosts plugin: its events, by its id.
const gitHosts = definePlugin({
  id: "git-hosts",
  title: "Git hosts",
  description: "Publishes issues and pull requests.",
  works: ["personal", "team"],
  events: {
    issue: event({ title: "Issue", fields: Type.Object(authored) }),
    pull_request: event({
      title: "Pull request",
      fields: Type.Object({
        ...authored,
        action: Type.String(),
        url: Type.String(),
        branch: Type.String(),
      }),
    }),
  },
});

const subagents = definePlugin({
  id: "subagents",
  title: "Subagents",
  description: "Finds agents.",
});

let hosting: ServerContext<typeof gitHosts> | undefined;
let spending: ServerContext<typeof usage> | undefined;

const plugins = [
  defineServer(gitHosts, (context) => {
    hosting = context;
  }),
  defineServer(usage, (context) => {
    spending = context;
  }),
  subagents,
];

async function started(): Promise<PluginTest> {
  return testPlugin(server, { people, plugins });
}

function issue(number: number, member = true): void {
  hosting?.events.emit(
    "issue",
    {
      host: "example.com",
      repository: "o/r",
      number,
      sender: member ? "ana" : "stranger",
      member,
    },
    { to: [person("ana")] },
  );
}

const folder = { kind: "folder", path: "/srv/a" };
const work = { kind: "session", prompt: "Fix it.", workspace: folder };

async function save(
  t: PluginTest,
  name: string,
  routine: object,
): Promise<RoutineDetail> {
  return t.as("ana").put(`routines/${name}`, routine);
}

async function detail(t: PluginTest, name: string): Promise<RoutineDetail> {
  return t.as("ana").get(`routines/${name}`);
}

async function outcomes(t: PluginTest, name: string): Promise<string[]> {
  return (await detail(t, name)).runs.map(({ outcome }) => outcome);
}

async function runNow(t: PluginTest, name: string): Promise<Run> {
  return t.as("ana").post<Run>(`routines/${name}/run`, {});
}

async function environment(t: PluginTest, owner: Owner = person("ana")) {
  return t.session({ owner });
}

function sessionOf(run: Run | undefined) {
  const session = hosting?.sessions.get(run?.sessionId ?? "");

  if (session === undefined) {
    throw new Error("no run Session");
  }

  return session;
}

function fail(t: PluginTest, run: Run | undefined): void {
  const session = sessionOf(run);

  t.emit({
    type: "SessionStateChanged",
    session: { ...session, status: "failed", error: "Pi crashed" },
    previous: "running",
  });
}

async function latest(t: PluginTest, name: string): Promise<Run | undefined> {
  return (await detail(t, name)).runs[0];
}

test("a run past its time limit is failed and its Session stopped; the limit is 2 hours unless set", async () => {
  await using t = await started();
  await environment(t);

  await save(t, "short", {
    title: "Short",
    when: [{ kind: "webhook" }],
    do: work,
    limits: { timeLimit: "30m" },
  });

  await save(t, "usual", {
    title: "Usual",
    when: [{ kind: "webhook" }],
    do: work,
  });

  const short = await runNow(t, "short");
  const usual = await runNow(t, "usual");

  await t.clock.advance("29m");
  expect(await latest(t, "short")).toMatchObject({ outcome: "running" });

  await t.clock.advance("1m");

  expect(await latest(t, "short")).toMatchObject({
    outcome: "failed",
    reason: "ran past its time limit of 30m",
  });

  expect(sessionOf(short).archivedAt).not.toBeNull();

  await t.clock.advance("89m");
  expect(await latest(t, "usual")).toMatchObject({ outcome: "running" });

  await t.clock.advance("1m");

  expect(await latest(t, "usual")).toMatchObject({
    outcome: "failed",
    reason: "ran past its time limit of 2h",
  });

  expect(sessionOf(usual).archivedAt).not.toBeNull();
});

test("a run's time limit counts from when it starts running, not while it is queued", async () => {
  await using t = await started();
  await environment(t);

  await save(t, "one", {
    title: "One at a time",
    when: [{ kind: "webhook" }],
    do: work,
    sameWork: { whileRunning: "queue" },
    limits: { timeLimit: "1h" },
  });

  const first = await runNow(t, "one");
  expect(await runNow(t, "one")).toMatchObject({ outcome: "queued" });

  await t.clock.advance("50m");

  await t.tool(
    "end_run",
    { result: "done", summary: "-" },
    { session: await t.attach(first.sessionId ?? "") },
  );

  await t.clock.advance("59m");
  expect(await outcomes(t, "one")).toEqual(["running", "ok"]);

  await t.clock.advance("1m");
  expect(await outcomes(t, "one")).toEqual(["failed", "ok"]);
});

test("a failed run starts again after 1 and then 10 minutes, and a run with its retries counts as one failure", async () => {
  await using t = await started();
  await environment(t);

  await save(t, "flaky", {
    title: "Flaky",
    when: [{ kind: "webhook" }],
    do: work,
    limits: { retries: 2 },
  });

  fail(t, await runNow(t, "flaky"));
  await t.clock.advance("59s");
  expect(await outcomes(t, "flaky")).toEqual(["failed"]);

  await t.clock.advance("1s");
  const second = await latest(t, "flaky");

  expect(second).toMatchObject({
    outcome: "running",
    attempt: 1,
    cause: "by hand",
  });

  fail(t, second);
  await t.clock.advance("9m");
  expect(await outcomes(t, "flaky")).toEqual(["failed", "failed"]);

  await t.clock.advance("1m");
  const third = await latest(t, "flaky");
  expect(third).toMatchObject({ outcome: "running", attempt: 2 });

  fail(t, third);
  await t.clock.advance("1h");
  expect(await outcomes(t, "flaky")).toEqual(["failed", "failed", "failed"]);

  for (let each = 0; each < 2; each++) {
    fail(t, await runNow(t, "flaky"));
    await t.clock.advance("1m");
    fail(t, await latest(t, "flaky"));
    await t.clock.advance("10m");
    expect((await detail(t, "flaky")).paused).toBeNull();
    fail(t, await latest(t, "flaky"));
  }

  expect((await detail(t, "flaky")).paused).toStartWith(
    "Paused after 3 failed runs in a row.",
  );

  expect(t.emitted("routines.paused")).toMatchObject([
    { fields: { name: "flaky", until: null }, to: [person("ana")] },
  ]);
});

test("a run the agent ends as blocked, or one with no retries set, doesn't start again", async () => {
  await using t = await started();
  await environment(t);

  await save(t, "asks", {
    title: "Asks",
    when: [{ kind: "webhook" }],
    do: work,
    limits: { retries: 2 },
  });

  await save(t, "once", {
    title: "Once",
    when: [{ kind: "webhook" }],
    do: work,
  });

  const asks = await runNow(t, "asks");

  await t.tool(
    "end_run",
    { result: "blocked", summary: "Which branch?" },
    { session: await t.attach(asks.sessionId ?? "") },
  );

  fail(t, await runNow(t, "once"));

  await t.clock.advance("1h");

  expect(await outcomes(t, "asks")).toEqual(["blocked"]);
  expect(await outcomes(t, "once")).toEqual(["failed"]);
});

test("a routine pauses itself after its stopAfter, a date or a time, and stays paused when resumed", async () => {
  await using t = await started();
  await environment(t);

  const soon = new Date(t.clock.now() + 60 * minute).toISOString();

  await save(t, "ends", {
    title: "Ends",
    when: [{ kind: "webhook" }],
    do: work,
    limits: { stopAfter: soon },
  });

  await t.clock.advance("59m");
  expect((await detail(t, "ends")).paused).toBeNull();

  await t.clock.advance("1m");

  expect((await detail(t, "ends")).paused).toBe(
    `Paused itself after ${soon}, the date it stops at.`,
  );

  expect(t.emitted("routines.paused")).toMatchObject([
    { fields: { name: "ends", title: "Ends" } },
  ]);

  await t.as("ana").post("routines/ends/resume");
  expect((await detail(t, "ends")).paused).toStartWith("Paused itself after");

  const yesterday = new Date(t.clock.now() - 2 * 24 * 60 * minute)
    .toISOString()
    .slice(0, 10);

  expect(
    await save(t, "ended", {
      title: "Ended",
      when: [{ kind: "event", event: "git-hosts.issue" }],
      do: work,
      limits: { stopAfter: yesterday },
    }),
  ).toMatchObject({
    paused: `Paused itself after ${yesterday}, the date it stops at.`,
  });

  issue(1);
  await t.clock.advance("1m");
  expect(await outcomes(t, "ended")).toEqual([]);

  expect(
    t.as("ana").put("routines/bad", {
      title: "Bad",
      when: [{ kind: "webhook" }],
      do: work,
      limits: { stopAfter: "next week" },
    }),
  ).rejects.toThrow("limits.stopAfter must be a date");
});

test("a routine's runs spending its daily cap pause it until the next day, and tell its owner", async () => {
  await using t = await started();
  await environment(t);

  await save(t, "spends", {
    title: "Spends",
    when: [{ kind: "event", event: "git-hosts.issue" }],
    sameWork: { key: ["number"] },
    do: work,
    limits: { dailySpend: 20 },
  });

  issue(1);
  issue(2);
  await t.clock.advance("30s");
  const [first, second] = (await detail(t, "spends")).runs;

  spending?.events.emit(
    "spent",
    { sessionId: first?.sessionId ?? "", cost: 12.5 },
    { to: [person("ana")] },
  );

  expect(await detail(t, "spends")).toMatchObject({
    paused: null,
    spentToday: 12.5,
  });

  spending?.events.emit(
    "spent",
    { sessionId: second?.sessionId ?? "", cost: 7.5 },
    { to: [person("ana")] },
  );

  const paused = await detail(t, "spends");

  expect(paused).toMatchObject({
    paused:
      "Paused until tomorrow: it spent 20.00 today, and its daily cap is 20.",
    spentToday: 20,
  });

  expect(t.emitted("routines.paused")).toEqual([
    {
      fields: {
        name: "spends",
        title: "Spends",
        reason: paused.paused,
        until: paused.pausedUntil,
      },
      to: [person("ana")],
    },
  ]);

  issue(3);
  await t.clock.advance("1m");
  expect(await outcomes(t, "spends")).toHaveLength(2);

  const until = Date.parse(paused.pausedUntil ?? "");
  expect(until - t.clock.now()).toBeLessThanOrEqual(24 * 60 * minute);

  await t.clock.advance(until - t.clock.now());

  expect(await detail(t, "spends")).toMatchObject({
    paused: null,
    pausedUntil: null,
    spentToday: 0,
  });

  issue(3);
  await t.clock.advance("30s");
  expect(await outcomes(t, "spends")).toHaveLength(3);
});

test("a routine without a daily cap only counts what it spent", async () => {
  await using t = await started();
  await environment(t);

  await save(t, "free", {
    title: "Free",
    when: [{ kind: "webhook" }],
    do: work,
  });

  const run = await runNow(t, "free");

  spending?.events.emit(
    "spent",
    { sessionId: run.sessionId ?? "", cost: 500 },
    { to: [person("ana")] },
  );

  expect(await detail(t, "free")).toMatchObject({
    paused: null,
    spentToday: 500,
  });
});

// A window that opens at the start of the hour after next, in UTC, and is
// open for an hour.
function laterWindow(t: PluginTest, outside: "wait" | "skip") {
  const opens = new Date(t.clock.now());
  opens.setUTCHours(opens.getUTCHours() + 2, 0, 0, 0);

  const hour = (at: number) =>
    `${String(new Date(at).getUTCHours()).padStart(2, "0")}:00`;

  return {
    opens: opens.getTime(),
    window: {
      days: "*",
      from: hour(opens.getTime()),
      to: hour(opens.getTime() + 60 * minute),
      outside,
      timeZone: "UTC",
    },
  };
}

test("an event outside its trigger's windows waits for the next window, or is dropped", async () => {
  await using t = await started();
  await environment(t);

  const waits = laterWindow(t, "wait");

  await save(t, "waits", {
    title: "Waits",
    when: [
      { kind: "event", event: "git-hosts.issue", windows: [waits.window] },
    ],
    do: work,
  });

  await save(t, "skips", {
    title: "Skips",
    when: [
      {
        kind: "event",
        event: "git-hosts.issue",
        windows: [laterWindow(t, "skip").window],
      },
    ],
    do: work,
  });

  await save(t, "always", {
    title: "Always",
    when: [
      {
        kind: "event",
        event: "git-hosts.issue",
        windows: [{ days: "*", from: "00:00", to: "24:00" }],
      },
    ],
    do: work,
  });

  issue(1);
  await t.clock.advance("30s");

  expect(await outcomes(t, "always")).toEqual(["running"]);

  expect(await detail(t, "skips")).toMatchObject({
    runs: [{ outcome: "skipped", reason: "outside its time windows" }],
  });

  expect(await outcomes(t, "waits")).toEqual([]);

  await t.clock.advance(waits.opens - t.clock.now() - 1000);
  expect(await outcomes(t, "waits")).toEqual([]);

  await t.clock.advance("1s");

  expect(await detail(t, "waits")).toMatchObject({
    runs: [{ cause: "event", outcome: "running" }],
  });

  expect(
    t.as("ana").put("routines/bad", {
      title: "Bad",
      when: [
        {
          kind: "webhook",
          windows: [{ days: "weekdays", from: "09:00", to: "18:00" }],
        },
      ],
      do: work,
    }),
  ).rejects.toThrow("when.0.windows");
});

test("a schedule firing outside its window waits for the window in the schedule's time zone", async () => {
  await using t = await started();
  await environment(t);

  const { opens, window } = laterWindow(t, "wait");
  const { timeZone: _, ...inScheduleZone } = window;

  await save(t, "hourly", {
    title: "Hourly",
    when: [
      {
        kind: "schedule",
        cron: "30 * * * *",
        timeZone: "UTC",
        windows: [inScheduleZone],
      },
    ],
    do: work,
  });

  await t.clock.advance(opens - t.clock.now() - 1000);
  expect(await outcomes(t, "hourly")).toEqual([]);

  await t.clock.advance("1s");

  expect(await detail(t, "hourly")).toMatchObject({
    runs: [{ cause: "schedule", outcome: "running" }],
  });
});

test("an event from a git host fires only for members, unless a condition names member or sender", async () => {
  await using t = await started();
  await environment(t);

  await save(t, "members", {
    title: "Members",
    when: [{ kind: "event", event: "git-hosts.issue" }],
    sameWork: { key: ["number"] },
    do: work,
  });

  await save(t, "anyone", {
    title: "Anyone",
    when: [
      {
        kind: "event",
        event: "git-hosts.issue",
        where: [{ field: "member", oneOf: [true, false] }],
      },
    ],
    sameWork: { key: ["number"] },
    do: work,
  });

  await save(t, "stranger", {
    title: "Stranger",
    when: [
      {
        kind: "event",
        event: "git-hosts.issue",
        where: [{ field: "sender", is: "stranger" }],
      },
    ],
    do: work,
  });

  issue(1, false);
  issue(2, true);
  await t.clock.advance("30s");

  expect(await outcomes(t, "members")).toEqual(["running"]);
  expect(await outcomes(t, "anyone")).toEqual(["running", "running"]);
  expect(await outcomes(t, "stranger")).toEqual(["running"]);
});

test("work with an open pull request goes to the Session that opened it, even after its run ended, until it closes", async () => {
  await using t = await started();
  await environment(t);

  await save(t, "fix", {
    title: "Fix issues",
    when: [{ kind: "event", event: "git-hosts.issue" }],
    sameWork: { key: ["number"], whileRunning: "skip" },
    do: {
      ...work,
      workspace: { kind: "clone", repository: "https://example.com/o/r" },
    },
  });

  issue(7);
  await t.clock.advance("30s");
  const first = await latest(t, "fix");
  const { workspace } = sessionOf(first);
  const branch = "branch" in workspace ? workspace.branch : "";
  expect(branch).not.toBe("");

  const pull = (action: string) => {
    hosting?.events.emit(
      "pull_request",
      {
        host: "example.com",
        repository: "o/r",
        number: 12,
        sender: "bot",
        member: true,
        action,
        url: "https://example.com/o/r/pull/12",
        branch,
      },
      { to: [person("ana")] },
    );
  };

  pull("opened");
  const session = await t.attach(first?.sessionId ?? "");

  await t.tool(
    "end_run",
    { result: "done", summary: "Opened #12." },
    { session },
  );

  issue(7);
  await t.clock.advance("30s");

  expect(await latest(t, "fix")).toMatchObject({
    outcome: "ok",
    reason: "sent to the Session that opened https://example.com/o/r/pull/12",
    sessionId: first?.sessionId,
  });

  expect(session.delivered().at(-1)).toMatchObject({
    turn: true,
    notice: { kind: "routine_events" },
  });

  issue(8);
  await t.clock.advance("30s");

  expect((await latest(t, "fix"))?.sessionId).not.toBe(
    first?.sessionId ?? null,
  );

  pull("closed");
  issue(7);
  await t.clock.advance("30s");

  const again = await latest(t, "fix");
  expect(again).toMatchObject({ outcome: "running" });
  expect(again?.sessionId).not.toBe(first?.sessionId ?? null);
});
