import { expect, test } from "bun:test";
import {
  check,
  definePlugin,
  defineServer,
  type Delivery,
  destination,
  event,
  type ServerContext,
  Type,
} from "@pipoca/plugins";
import { person, type PluginTest, testPlugin, until } from "@pipoca/testing";
import type { RoutineDetail, Run } from "./model";
import { server } from "./server";

const people = [{ id: "ana", name: "Ana", admin: true }];

// Stands in for a plugin that publishes events, takes results and offers a
// check: its destination notes what it is given.
const tracker = definePlugin({
  id: "tracker",
  title: "Tracker",
  description: "Publishes issues and takes results.",
  works: ["personal", "team"],
  events: {
    issue: event({
      title: "Issue",
      fields: Type.Object({
        number: Type.Number(),
        conclusion: Type.String(),
      }),
    }),
  },
  destinations: {
    note: destination({
      title: "A note",
      settings: Type.Object(
        { channel: Type.String({ minLength: 1 }) },
        { additionalProperties: false },
      ),
    }),
  },
  checks: {
    above: check({
      title: "A number above",
      script: "return event.number > settings.over;",
      settings: Type.Object(
        { over: Type.Number() },
        { additionalProperties: false },
      ),
    }),
  },
});

const subagents = definePlugin({
  id: "subagents",
  title: "Subagents",
  description: "Finds agents.",
});

interface Noted {
  readonly settings: { readonly channel: string };
  readonly delivery: Delivery;
}

let tracking: ServerContext<typeof tracker> | undefined;
let noted: Noted[] = [];

const trackerServer = defineServer(tracker, (context) => {
  tracking = context;
  noted = [];

  context.provide.destinations({
    note: async (settings, delivery) => {
      noted.push({ settings, delivery });

      if (settings.channel === "gone") {
        throw new Error("no channel gone");
      }

      return Promise.resolve({
        text: `Noted in ${settings.channel}`,
        url: "https://example.com/n/1",
      });
    },
  });
});

// What the watched address answers, and how often it was asked.
let answer: () => Response = () => new Response("{}");
let fetched: string[] = [];

async function started(): Promise<PluginTest> {
  noted = [];
  fetched = [];

  const t = await testPlugin(server, {
    people,
    plugins: [trackerServer, subagents],
    fetch: (request) => {
      fetched.push(request.url);

      return answer();
    },
  });

  await t.session({ owner: person("ana") });

  return t;
}

function issue(number: number, conclusion = "failure"): void {
  tracking?.events.emit(
    "issue",
    { number, conclusion },
    { to: [person("ana")] },
  );
}

const work = {
  kind: "session",
  prompt: "Look at it.",
  workspace: { kind: "folder", path: "/srv/a" },
};

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

function firstMessageOf(run: Run | undefined): string {
  return tracking?.sessions.get(run?.sessionId ?? "")?.firstMessage ?? "";
}

// How many times a trigger's check ran.
function checksRun(t: PluginTest): number {
  return t.log.filter(({ message }) => message === "routine trigger checked")
    .length;
}

async function endRun(
  t: PluginTest,
  run: Run | undefined,
  result: string,
  summary: string,
): Promise<void> {
  await t.tool(
    "end_run",
    { result, summary },
    { session: await t.attach(run?.sessionId ?? "") },
  );
}

test("a run's result goes to its routine's destinations when it ends, and the run shows what each wrote", async () => {
  await using t = await started();

  await save(t, "triage", {
    title: "Triage",
    when: [{ kind: "event", event: "tracker.issue" }],
    do: work,
    results: [
      { to: "note", with: { channel: "#triage" } },
      { to: "tracker.note", with: { channel: "gone" } },
      { to: "note", with: { channel: "#quiet" }, on: ["nothing"] },
    ],
  });

  issue(7);
  await t.clock.advance("30s");

  const [run] = (await detail(t, "triage")).runs;
  await endRun(t, run, "done", "Labelled it as a bug.");

  const ended = await until(
    async () => (await detail(t, "triage")).runs[0],
    (each) => each?.results?.length === 2,
  );

  expect(ended?.results).toContainEqual({
    destination: "tracker.note",
    state: "sent",
    text: "Noted in #triage",
    url: "https://example.com/n/1",
  });

  expect(ended?.results).toContainEqual({
    destination: "tracker.note",
    state: "failed",
    text: "no channel gone",
  });

  const first = noted.find(({ settings }) => settings.channel === "#triage");

  expect(noted).toHaveLength(2);

  expect(first?.delivery).toMatchObject({
    routine: "Triage",
    outcome: "done",
    summary: "Labelled it as a bug.",
    events: [
      { type: "tracker.issue", fields: { number: 7, conclusion: "failure" } },
    ],
    text: "Triage: Done. Labelled it as a bug.",
  });

  expect(first?.delivery.session.id).toBe(run?.sessionId ?? "");
});

test("the output a run ends with goes to its destinations with the summary", async () => {
  await using t = await started();

  await save(t, "triage", {
    title: "Triage",
    when: [{ kind: "event", event: "tracker.issue" }],
    do: work,
    output: { area: "string" },
    results: [{ to: "note", with: { channel: "#triage" } }],
  });

  issue(7);
  await t.clock.advance("30s");

  const [run] = (await detail(t, "triage")).runs;

  await t.tool(
    "end_run",
    { result: "done", summary: "Labelled it.", output: { area: "billing" } },
    { session: await t.attach(run?.sessionId ?? "") },
  );

  await until(
    () => noted,
    (each) => each.length === 1,
  );

  expect(noted[0]?.delivery).toMatchObject({
    summary: "Labelled it.",
    output: { area: "billing" },
  });
});

test("a dry run's result goes nowhere", async () => {
  await using t = await started();

  await save(t, "triage", {
    title: "Triage",
    when: [{ kind: "webhook" }],
    do: work,
    results: [{ to: "note", with: { channel: "#triage" } }],
  });

  const run = await t
    .as("ana")
    .post<Run>("routines/triage/run", { dryRun: true });

  await endRun(t, run, "done", "Looked.");
  await t.clock.advance("1s");

  expect((await detail(t, "triage")).runs[0]?.results).toBeUndefined();
  expect(noted).toEqual([]);
});

test("saving refuses a destination no plugin offers or settings that don't fit it", async () => {
  await using t = await started();

  const routine = {
    title: "Triage",
    when: [{ kind: "webhook" }],
    do: work,
  };

  expect(
    save(t, "triage", { ...routine, results: [{ to: "slack.channel" }] }),
  ).rejects.toThrow("results.0.to: no plugin that is on offers slack.channel");

  expect(
    save(t, "triage", {
      ...routine,
      results: [{ to: "note", with: { channel: 3 } }],
    }),
  ).rejects.toThrow("results.0.with.channel");

  expect(await t.as("ana").get("destinations")).toMatchObject([
    { type: "tracker.note", title: "A note" },
  ]);
});

test("a trigger that collects runs once per schedule with every event it gathered, and not at all when it gathered none", async () => {
  await using t = await started();

  await save(t, "digest", {
    title: "Digest",
    when: [
      {
        kind: "event",
        event: "tracker.issue",
        collect: { cron: "0 * * * *", timeZone: "UTC" },
      },
    ],
    do: work,
  });

  issue(1);
  issue(2);
  issue(3);
  await t.clock.advance("61m");

  const { runs } = await detail(t, "digest");

  expect(runs).toHaveLength(1);

  const text = firstMessageOf(runs[0]);

  expect(text).toContain('"number": 1');
  expect(text).toContain('"number": 3');

  await endRun(t, runs[0], "done", "-");
  await t.clock.advance("2h");

  expect((await detail(t, "digest")).runs).toHaveLength(1);
});

test("saving refuses a collect schedule that isn't a cron expression", async () => {
  await using t = await started();

  expect(
    save(t, "digest", {
      title: "Digest",
      when: [
        { kind: "event", event: "tracker.issue", collect: { cron: "soon" } },
      ],
      do: work,
    }),
  ).rejects.toThrow();
});

test("a trigger's check sees the event and the earlier firings of its piece of work, and only a true starts a run", async () => {
  await using t = await started();

  await save(t, "twice", {
    title: "Failed twice",
    when: [
      {
        kind: "event",
        event: "tracker.issue",
        check:
          'return event.conclusion === "failure" && earlier.length > 0 && earlier[0].conclusion === "failure";',
      },
    ],
    sameWork: { key: ["number"] },
    do: work,
  });

  const fire = async (number: number, conclusion: string) => {
    const before = checksRun(t);

    issue(number, conclusion);

    await until(
      async () => Promise.resolve(checksRun(t)),
      (n) => n > before,
    );

    await t.clock.advance("31s");
  };

  await fire(5, "failure");

  expect((await detail(t, "twice")).checks?.[0]).toMatchObject({
    passed: false,
  });

  await fire(6, "failure");
  await fire(5, "success");
  await fire(5, "failure");
  expect((await detail(t, "twice")).runs).toEqual([]);

  await fire(5, "failure");

  const { runs, checks: notes } = await detail(t, "twice");

  expect(notes?.[0]).toMatchObject({ trigger: 0, passed: true });
  expect(runs).toHaveLength(1);
  expect(runs[0]?.cause).toBe("event");
});

test("a check that throws, returns no boolean or runs past 50 ms starts nothing and says why", async () => {
  await using t = await started();

  for (const [name, script, why] of [
    ["throws", "throw new Error('boom')", "the check failed: boom"],
    ["number", "return 1", "the check returned 1, not true or false"],
    ["loops", "for (;;) {}", "the check ran past its 50 ms"],
  ] as const) {
    await save(t, name, {
      title: name,
      when: [{ kind: "event", event: "tracker.issue", check: script }],
      do: work,
    });

    issue(1);

    const { checks } = await until(
      async () => detail(t, name),
      (each) => each.checks?.[0] !== undefined,
    );

    expect(checks?.[0]).toMatchObject({ passed: false, error: why });

    await t.clock.advance("31s");
    expect((await detail(t, name)).runs).toEqual([]);
  }
});

test("a trigger can use a check a plugin offers, with settings that fit it", async () => {
  await using t = await started();

  const routine = (settings: object) => ({
    title: "Big ones",
    when: [
      {
        kind: "event",
        event: "tracker.issue",
        check: { use: "above", with: settings },
      },
    ],
    do: work,
  });

  expect(save(t, "big", routine({ over: "ten" }))).rejects.toThrow(
    "when.0: check above: with.over",
  );

  expect(
    save(t, "big", {
      ...routine({}),
      when: [{ kind: "event", event: "tracker.issue", check: { use: "nope" } }],
    }),
  ).rejects.toThrow("check nope: no plugin that is on offers this check");

  await save(t, "big", routine({ over: 10 }));

  issue(11);

  await until(
    async () => detail(t, "big"),
    (each) => each.checks?.[0]?.passed === true,
  );

  await t.clock.advance("31s");

  expect((await detail(t, "big")).runs).toHaveLength(1);

  expect(await t.as("ana").get("checks")).toMatchObject([
    { type: "tracker.above", script: "return event.number > settings.over;" },
  ]);
});

test("a watch fires when the value at its path changes, after a first fetch that only looks", async () => {
  await using t = await started();

  let version = "1.0";

  answer = () =>
    Response.json({ items: [{ version, notes: String(Math.random()) }] });

  await save(t, "release", {
    title: "New release",
    when: [
      {
        kind: "watch",
        url: "https://93.184.216.34/releases",
        every: "15m",
        path: "items.0.version",
      },
    ],
    do: { ...work, prompt: "Read the notes of {{event.value}}." },
  });

  await t.clock.advance("1s");

  expect(fetched).toEqual(["https://93.184.216.34/releases"]);
  expect((await detail(t, "release")).watches).toMatchObject([{ trigger: 0 }]);

  await t.clock.advance("15m");
  await t.clock.advance("1m");

  expect(fetched).toHaveLength(2);
  expect((await detail(t, "release")).runs).toEqual([]);

  version = "1.1";
  await t.clock.advance("15m");
  await t.clock.advance("31s");

  const { runs } = await detail(t, "release");

  expect(runs).toHaveLength(1);

  const text = firstMessageOf(runs[0]);

  expect(text).toContain(
    "Read the notes of <outside_input>1.1</outside_input>.",
  );

  expect(text).toContain('"previous": "1.0"');
});

test("a watch without a path fires when the response changes, and its conditions hold", async () => {
  await using t = await started();

  let body = "all good";
  answer = () => new Response(body);

  await save(t, "status", {
    title: "Status page",
    when: [
      {
        kind: "watch",
        url: "https://93.184.216.34/status",
        every: "5m",
        where: [{ field: "value", isNot: "all good" }],
      },
    ],
    do: work,
  });

  await t.clock.advance("1s");

  body = "down";
  await t.clock.advance("5m");
  await t.clock.advance("31s");
  expect((await detail(t, "status")).runs).toHaveLength(1);

  body = "all good";
  await t.clock.advance("5m");
  await t.clock.advance("31s");
  expect((await detail(t, "status")).runs).toHaveLength(1);
});

test("a watch fetches no private address and says so, and waits at least 5 minutes", async () => {
  await using t = await started();

  expect(
    save(t, "fast", {
      title: "Too fast",
      when: [{ kind: "watch", url: "https://93.184.216.34/", every: "1m" }],
      do: work,
    }),
  ).rejects.toThrow("when.0.every: a watch waits at least 5m between fetches");

  await save(t, "inside", {
    title: "Inside",
    when: [{ kind: "watch", url: "https://127.0.0.1/admin", every: "5m" }],
    do: work,
  });

  await t.clock.advance("1s");

  expect(fetched).toEqual([]);

  expect((await detail(t, "inside")).watches?.[0]?.error).toBe(
    "127.0.0.1 is on a private address, which a watch doesn't fetch",
  );
});

test("a watch of a private host goes through the owner's Environments, and team routines need an admin's leave", async () => {
  await using t = await testPlugin(server, {
    people,
    plugins: [subagents],
    kernelConfig: {
      privateHosts: {
        hosts: [{ host: "status.acme.internal", ca: null, teamWatch: false }],
      },
    },
  });

  const watching = {
    title: "Inside status",
    when: [
      { kind: "watch", url: "https://status.acme.internal/", every: "5m" },
    ],
    do: work,
  };

  const refused = await t
    .as("ana")
    .put("team/routines/inside", watching)
    .catch((error: unknown) => error);

  expect(String(refused)).toContain(
    "status.acme.internal is private. An admin hasn't allowed team routines to watch it",
  );

  await save(t, "inside", watching);
  await t.clock.advance("1s");

  expect((await detail(t, "inside")).watches?.[0]?.error).toBe(
    "status.acme.internal is a private host and no Environment of yours reaches it.",
  );
});
