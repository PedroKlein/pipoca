import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { server as askServer } from "@pipoca/ask/server";
import {
  action,
  definePlugin,
  defineServer,
  event,
  type PostedQuestion,
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
import type { Proposal, RoutineDetail, Run } from "./model";
import { server } from "./server";

const people = [
  { id: "ana", name: "Ana", admin: true },
  { id: "bo", name: "Bo" },
];

// Stands in for a plugin that publishes issues, comments on them, and posts
// a question back on the issue it came from.
const tracker = definePlugin({
  id: "tracker",
  title: "Tracker",
  description: "Publishes issues and writes on them.",
  works: ["personal", "team"],
  events: {
    issue: event({
      title: "Issue",
      fields: Type.Object({ number: Type.Number() }),
    }),
  },
  actions: {
    comment: action({
      title: "Comment",
      input: Type.Object({ number: Type.Number(), body: Type.String() }),
    }),
  },
});

const subagents = definePlugin({
  id: "subagents",
  title: "Subagents",
  description: "Finds agents.",
});

let tracking: ServerContext<typeof tracker> | undefined;
let posted: PostedQuestion[] = [];
let written: unknown[] = [];

const trackerServer = defineServer(tracker, (context) => {
  tracking = context;
  posted = [];
  written = [];

  context.provide.replies({
    post: async (question) => {
      posted.push(question);

      return Promise.resolve(true);
    },
  });

  context.provide.actions({
    comment: async (input) => {
      written.push(input);

      return Promise.resolve({ text: `Commented on #${String(input.number)}` });
    },
  });
});

async function started(): Promise<PluginTest> {
  const t = await testPlugin(server, {
    people,
    plugins: [askServer, trackerServer, subagents],
  });

  await t.session({ owner: person("ana") });
  const team = await t.session({ owner: "team", startedBy: "ana" });
  teamProfile = tracking?.sessions.get(team.id)?.profileId;

  return t;
}

// What the team's runs start with.
let teamProfile: string | undefined;

function teamRoutine(): object {
  return {
    title: "Team",
    when: [{ kind: "webhook" }],
    do: { ...work, profile: teamProfile },
  };
}

function questions() {
  if (tracking === undefined) {
    throw new Error("the tracker didn't start");
  }

  return tracking.questions;
}

const work = {
  kind: "session",
  prompt: "Triage it.",
  workspace: { kind: "folder", path: "/srv/a" },
};

const onIssues = [{ kind: "event", event: "tracker.issue" }];

async function detail(
  t: PluginTest,
  name: string,
  as = "ana",
  prefix = "",
): Promise<RoutineDetail> {
  return t.as(as).get<RoutineDetail>(`${prefix}routines/${name}`);
}

async function latest(t: PluginTest, name: string, prefix = "") {
  return (await detail(t, name, "ana", prefix)).runs[0];
}

async function fired(t: PluginTest, name: string, number = 7): Promise<Run> {
  tracking?.events.emit("issue", { number }, { to: [person("ana")] });
  await t.clock.advance("30s");

  const run = await latest(t, name);

  if (run?.sessionId === undefined || run.sessionId === null) {
    throw new Error("the event started no run");
  }

  return run;
}

// Pi in the run's Session asks, as ask_user does.
async function asks(
  host: TestSession,
  question: object,
): Promise<{ readonly wait: string }> {
  const asked = await host.api.raw(
    `/runner/sessions/${host.id}/ext/ask/questions`,
    {
      method: "POST",
      body: JSON.stringify({ questions: [question], defaults: {} }),
    },
  );

  return (await asked.json()) as { readonly wait: string };
}

const which = {
  id: "label",
  label: "Label",
  prompt: "Which label fits?",
  context: null,
  type: "text",
  placeholder: null,
};

async function outcomeOf(t: PluginTest, name: string, prefix = "") {
  return (await latest(t, name, prefix))?.outcome;
}

test("a run that asks waits for the answer, not counting the time limit, and the answer resumes it", async () => {
  await using t = await started();

  await t.as("ana").put("routines/triage", {
    title: "Triage",
    when: onIssues,
    do: work,
    limits: { timeLimit: "1h" },
  });

  const run = await fired(t, "triage");
  const host = await t.attach(run.sessionId ?? "");

  // It waits past the turn, so ask_user ends the turn.
  expect(await asks(host, which)).toMatchObject({ wait: "message" });

  await host.turn([]);

  await until(
    async () => outcomeOf(t, "triage"),
    (o) => o === "waiting",
  );

  const [open] = questions().open(run.sessionId ?? "");

  expect(await latest(t, "triage")).toMatchObject({
    outcome: "waiting",
    questions: [{ id: open?.id, prompts: ["Which label fits?"] }],
    askedFor: ["Ana"],
  });

  // It goes back where the work came from.
  expect(posted).toMatchObject([
    { id: open?.id, origin: { event: "tracker.issue", fields: { number: 7 } } },
  ]);

  // Waiting doesn't count towards its time limit.
  await t.clock.advance("3h");
  expect(await outcomeOf(t, "triage")).toBe("waiting");

  expect(questions().answer(open?.id ?? "", { text: "bug", by: "Ana" })).toBe(
    true,
  );

  await until(
    () => host.delivered(),
    (all) => all.some(({ text }) => text.includes("from Ana:\n\nbug")),
  );

  await host.report([{ type: "status", status: "running" }]);

  await until(
    async () => outcomeOf(t, "triage"),
    (o) => o === "running",
  );

  await t.clock.advance("50m");
  expect(await outcomeOf(t, "triage")).toBe("running");

  await t.clock.advance("15m");

  expect(await latest(t, "triage")).toMatchObject({
    outcome: "failed",
    reason: "ran past its time limit of 1h",
  });
});

test("a run's question waits 24 hours unless the routine says, then takes its default", async () => {
  await using t = await started();

  await t.as("ana").put("routines/triage", {
    title: "Triage",
    when: onIssues,
    do: work,
  });

  const first = await fired(t, "triage");
  const host = await t.attach(first.sessionId ?? "");
  await asks(host, which);
  await host.turn([]);

  const [open] = questions().open(first.sessionId ?? "");

  expect(open?.closesAt).toBe(
    new Date(t.clock.now() + 24 * 3_600_000).toISOString(),
  );

  await t.clock.advance("24h");

  await until(
    () => host.delivered(),
    (all) => all.some(({ text }) => text.includes("timed out")),
  );

  expect(questions().open(first.sessionId ?? "")).toEqual([]);

  await t.as("ana").put("routines/quick", {
    title: "Quick",
    when: [{ kind: "webhook" }],
    do: work,
    questions: { timeout: "2h" },
  });

  const quick = await t.as("ana").post<Run>("routines/quick/run", {});
  await asks(await t.attach(quick.sessionId ?? ""), which);

  expect(questions().open(quick.sessionId ?? "")[0]?.closesAt).toBe(
    new Date(t.clock.now() + 2 * 3_600_000).toISOString(),
  );
});

test("an action that needs approval makes the run wait on an approve or reject question, and the answer applies it", async () => {
  await using t = await started();

  await t.as("ana").put("routines/triage", {
    title: "Triage",
    when: onIssues,
    do: work,
    actions: { comment: { max: 2, approve: true } },
  });

  const run = await fired(t, "triage");
  const host = await t.attach(run.sessionId ?? "");

  await host.api.post("proposals", {
    action: "comment",
    input: { number: 7, body: "A duplicate of #2." },
  });

  const ended = await t.tool(
    "end_run",
    { result: "done", summary: "Asked to comment." },
    { session: host },
  );

  expect(ended.text).toContain("the run ends once a person approved");

  await host.turn([]);

  await until(
    async () => outcomeOf(t, "triage"),
    (o) => o === "waiting",
  );

  const [open] = questions().open(run.sessionId ?? "");

  expect(open?.questions).toMatchObject([
    {
      type: "single",
      prompt: "Approve: Comment?",
      options: [{ value: "approve" }, { value: "reject" }],
    },
  ]);

  expect(open?.questions[0]?.context).toContain('"body": "A duplicate of #2."');
  expect(posted).toMatchObject([{ id: open?.id }]);

  questions().answer(open?.id ?? "", { text: "Approve", by: "Ana" });

  const proposals = await until(
    async () => (await latest(t, "triage"))?.proposals ?? [],
    (all) => all.every(({ state }) => state !== "waiting"),
  );

  expect(proposals).toMatchObject([
    { state: "applied", result: "Commented on #7" },
  ]);

  expect(written).toEqual([{ number: 7, body: "A duplicate of #2." }]);

  await host.turn([]);

  await until(
    async () => outcomeOf(t, "triage"),
    (o) => o === "ok",
  );

  expect((await latest(t, "triage"))?.reason).toBe("Asked to comment.");

  // Nobody answers the next one in time, so it is refused.
  const next = await fired(t, "triage", 8);
  const again = await t.attach(next.sessionId ?? "");

  await again.api.post("proposals", {
    action: "comment",
    input: { number: 8, body: "Spam?" },
  });

  await again.turn([]);
  await t.clock.advance("24h");

  const refused = await until(
    async () => (await latest(t, "triage"))?.proposals ?? [],
    (all: readonly Proposal[]) => all.every(({ state }) => state !== "waiting"),
  );

  expect(refused).toMatchObject([
    { state: "rejected", result: "nobody approved it in time" },
  ]);
});

// The team runs a routine by hand, and its run asks.
async function askedFor(t: PluginTest, name: string): Promise<unknown> {
  const run = await t.as("ana").post<Run>(`team/routines/${name}/run`, {});
  const host = await t.attach(run.sessionId ?? "");

  await asks(host, which);
  await host.turn([]);

  const waiting = await until(
    async () => latest(t, name, "team/"),
    (each) => each?.outcome === "waiting",
  );

  await t.tool("end_run", { result: "done", summary: "-" }, { session: host });

  return waiting?.askedFor;
}

test("a team routine's questions are for the person or on-call list it names, or else whoever made it", async () => {
  await using t = await started();
  const team = teamRoutine();

  await t.as("ana").put("team/routines/named", {
    ...team,
    questions: { ask: { person: "Bo" } },
  });

  expect(await askedFor(t, "named")).toEqual(["Bo"]);

  await t.as("bo").put("team/routines/made", team);
  expect(await askedFor(t, "made")).toEqual(["Bo"]);

  const folder = join(dirname(tracking?.config.dir ?? ""), "routines", "team");
  mkdirSync(folder, { recursive: true });

  writeFileSync(
    join(folder, "onCall.json"),
    JSON.stringify({ triage: ["ana", "bo"] }),
  );

  await t.as("ana").put("team/routines/rota", {
    ...team,
    questions: { ask: { onCall: "triage" } },
  });

  const thisWeek = await askedFor(t, "rota");
  await t.clock.advance("7d");
  const nextWeek = await askedFor(t, "rota");

  expect([thisWeek, nextWeek]).toContainEqual(["Ana"]);
  expect([thisWeek, nextWeek]).toContainEqual(["Bo"]);
});

test("a team routine's editors alone change or remove it, and its page says who made and changed it", async () => {
  await using t = await started();
  const team = teamRoutine();

  await t.as("ana").put("team/routines/guarded", { ...team, editors: ["Bo"] });

  const refused = await t.as("ana").raw("team/routines/guarded", {
    method: "PUT",
    body: JSON.stringify({ ...team, title: "Mine" }),
  });

  expect(refused.status).toBe(403);

  await t.as("bo").put("team/routines/guarded", {
    ...team,
    title: "Ours",
    editors: ["Bo"],
  });

  const removed = await t
    .as("ana")
    .raw("team/routines/guarded", { method: "DELETE" });

  expect(removed.status).toBe(403);

  expect(await detail(t, "guarded", "ana", "team/")).toMatchObject({
    title: "Ours",
    createdBy: "Ana",
    changedBy: "Bo",
    history: [
      { by: "Bo", change: "changed" },
      { by: "Ana", change: "created" },
    ],
  });
});
