import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  action,
  definePlugin,
  defineServer,
  event,
  type ServerContext,
  type Session,
  Type,
} from "@pipoca/plugins";
import {
  person,
  type PluginTest,
  type TestSession,
  testPlugin,
  testSession,
  until,
} from "@pipoca/testing";
import type { Proposal, RoutineDetail, Run } from "./model";
import { server } from "./server";
import { session as sessionPart } from "./session";

const people = [
  { id: "ana", name: "Ana", admin: true },
  { id: "bo", name: "Bo" },
];

// Stands in for a plugin that publishes events and writes outside: its
// actions note what they are given, and its tool posts.
const tracker = definePlugin({
  id: "tracker",
  title: "Tracker",
  description: "Publishes issues and writes on them.",
  works: ["personal", "team"],
  events: {
    issue: event({
      title: "Issue",
      fields: Type.Object({ number: Type.Number(), title: Type.String() }),
    }),
  },
  actions: {
    comment: action({
      title: "Comment",
      input: Type.Object(
        { number: Type.Number(), body: Type.String() },
        { additionalProperties: false },
      ),
    }),
    pullRequest: action({
      title: "Open a pull request",
      input: Type.Object({ title: Type.String() }),
      commits: true,
    }),
  },
});

const subagents = definePlugin({
  id: "subagents",
  title: "Subagents",
  description: "Finds agents.",
});

interface Written {
  readonly kind: string;
  readonly input: unknown;
  readonly session: Session;
  readonly commits?: string;
}

let tracking: ServerContext<typeof tracker> | undefined;
let written: Written[] = [];

const trackerServer = defineServer(tracker, (context) => {
  tracking = context;
  written = [];

  context.tools.define({
    name: "tracker_post",
    description: "Posts outside.",
    params: Type.Object({}),
    annotations: { openWorld: true },
    run: () => "posted",
  });

  context.provide.actions({
    comment: async (input, { session }) => {
      written.push({ kind: "comment", input, session });

      return Promise.resolve({
        text: `Commented on #${String(input.number)}`,
        url: `https://example.com/o/r/issues/${String(input.number)}#c1`,
      });
    },
    pullRequest: async (input, { session, commits }) => {
      written.push({
        kind: "pullRequest",
        input,
        session,
        ...(commits && { commits: Buffer.from(commits).toString("utf8") }),
      });

      return Promise.resolve({
        text: "Opened #12",
        url: "https://example.com/o/r/pull/12",
      });
    },
  });
});

async function started(): Promise<PluginTest> {
  const t = await testPlugin(server, {
    people,
    plugins: [trackerServer, subagents],
  });

  await t.session({ owner: person("ana") });

  return t;
}

function issue(number: number): void {
  tracking?.events.emit(
    "issue",
    { number, title: `Issue ${String(number)}` },
    { to: [person("ana")] },
  );
}

const work = {
  kind: "session",
  prompt: "Triage it.",
  workspace: { kind: "folder", path: "/srv/a" },
};

const onIssues = [{ kind: "event", event: "tracker.issue" }];

async function save(
  t: PluginTest,
  name: string,
  routine: object,
): Promise<RoutineDetail> {
  return t.as("ana").put(`routines/${name}`, routine);
}

async function latest(t: PluginTest, name: string): Promise<Run | undefined> {
  return (await t.as("ana").get<RoutineDetail>(`routines/${name}`)).runs[0];
}

async function fired(t: PluginTest, name: string, number = 7): Promise<Run> {
  issue(number);
  await t.clock.advance("30s");

  const run = await latest(t, name);

  if (run?.sessionId === undefined || run.sessionId === null) {
    throw new Error("the event started no run");
  }

  return run;
}

function sessionOf(run: Run | undefined): Session {
  const session = tracking?.sessions.get(run?.sessionId ?? "");

  if (session === undefined) {
    throw new Error("no run Session");
  }

  return session;
}

// Why the call failed, or "" when it didn't.
async function failureOf(call: Promise<unknown>): Promise<string> {
  return call.then(
    () => "",
    (error: unknown) =>
      error instanceof Error ? error.message : String(error),
  );
}

// The run's turn ended, and what it proposed has been dealt with.
async function turnEnds(
  t: PluginTest,
  name: string,
  session: TestSession,
): Promise<readonly Proposal[]> {
  await session.turn([]);

  return until(
    async () => (await latest(t, name))?.proposals ?? [],
    (proposals) => proposals.every(({ state }) => state !== "proposed"),
  );
}

async function propose(
  session: TestSession,
  name: string,
  input: unknown,
  commits?: string,
): Promise<Proposal> {
  return session.api.post<Proposal>("proposals", {
    action: name,
    input,
    ...(commits !== undefined && { commits }),
  });
}

test("a run fired by outside input proposes, and one fired by hand writes, unless the routine says otherwise", async () => {
  await using t = await started();

  await save(t, "triage", {
    title: "Triage",
    when: [...onIssues, { kind: "webhook" }],
    do: work,
    actions: { comment: 3 },
  });

  const byEvent = await fired(t, "triage");

  expect(byEvent).toMatchObject({ proposes: true, proposals: [] });
  expect(sessionOf(byEvent).proposes).toBe(true);
  expect(sessionOf(byEvent).systemPrompt).toContain("comment (at most 3)");

  await t.tool(
    "end_run",
    { result: "done", summary: "-" },
    { session: await t.attach(byEvent.sessionId ?? "") },
  );

  const byHand = await t.as("ana").post<Run>("routines/triage/run", {});

  expect(byHand.proposes).toBeUndefined();
  expect(sessionOf(byHand).proposes).toBe(false);

  await save(t, "always", {
    title: "Always",
    when: [{ kind: "webhook" }],
    do: work,
    proposes: "always",
  });

  const always = await t.as("ana").post<Run>("routines/always/run", {});
  expect(sessionOf(always).proposes).toBe(true);

  const direct = await save(t, "direct", {
    title: "Direct",
    when: onIssues,
    do: work,
    proposes: "never",
  });

  // Saved, it ran once on issue 7, which is outside input too.
  expect(direct.runs).toMatchObject([{ cause: "test" }]);
  expect(sessionOf(direct.runs[0]).proposes).toBe(false);
});

test("a Session that proposes gets no tool that posts, and its Session part learns what it may propose", async () => {
  await using t = await started();

  await save(t, "triage", {
    title: "Triage",
    when: onIssues,
    do: work,
    actions: { comment: { max: 2, approve: true } },
  });

  const run = await t.attach((await fired(t, "triage")).sessionId ?? "");

  expect(await failureOf(t.tool("tracker_post", {}, { session: run }))).toMatch(
    "tracker_post isn't offered in this Session",
  );

  const own = await t.session({ owner: person("ana") });

  expect(await t.tool("tracker_post", {}, { session: own })).toMatchObject({
    isError: false,
    text: "posted",
  });

  expect(await run.api.get("run")).toMatchObject({
    dryRun: false,
    actions: [
      {
        name: "comment",
        max: 2,
        approve: true,
        action: { type: "tracker.comment", title: "Comment" },
      },
    ],
  });

  expect(await failureOf(own.api.get("run"))).toMatch(/proposes/);
});

test("proposals are applied as the run's Session once its turn ends, within the routine's maximums", async () => {
  await using t = await started();

  await save(t, "triage", {
    title: "Triage",
    when: onIssues,
    do: work,
    actions: { "tracker.comment": 2 },
  });

  const run = await fired(t, "triage");
  const session = await t.attach(run.sessionId ?? "");

  expect(
    await propose(session, "tracker.comment", {
      number: 7,
      body: "Looking.",
    }),
  ).toMatchObject({ state: "proposed", action: "tracker.comment" });

  await propose(session, "tracker.comment", { number: 7, body: "Done." });

  expect(
    await propose(session, "tracker.comment", {
      number: 7,
      body: "Once more.",
    }),
  ).toMatchObject({
    state: "refused",
    result: "the routine allows tracker.comment at most 2 times a run",
  });

  expect(await propose(session, "pullRequest", { title: "Fix" })).toMatchObject(
    { state: "refused" },
  );

  expect(written).toEqual([]);

  await turnEnds(t, "triage", session);

  expect(written.map(({ input }) => input)).toEqual([
    { number: 7, body: "Looking." },
    { number: 7, body: "Done." },
  ]);

  expect(written[0]?.session.id).toBe(run.sessionId ?? "");

  expect((await latest(t, "triage"))?.proposals).toMatchObject([
    {
      state: "applied",
      result: "Commented on #7",
      url: "https://example.com/o/r/issues/7#c1",
    },
    { state: "applied" },
    { state: "refused" },
    { state: "refused" },
  ]);
});

test("a proposal that doesn't fit the action's schema fails and the others still apply", async () => {
  await using t = await started();

  await save(t, "triage", {
    title: "Triage",
    when: onIssues,
    do: work,
    actions: { comment: 3 },
  });

  const session = await t.attach((await fired(t, "triage")).sessionId ?? "");

  await propose(session, "comment", { number: "seven" });
  await propose(session, "comment", { number: 7, body: "Hi." });
  await turnEnds(t, "triage", session);

  expect((await latest(t, "triage"))?.proposals).toMatchObject([
    {
      state: "failed",
      result: "the input must have required properties body",
    },
    { state: "applied" },
  ]);
});

test("an action marked approve waits for a person, who approves or rejects it on the routine's page", async () => {
  await using t = await started();

  await save(t, "triage", {
    title: "Triage",
    when: onIssues,
    do: work,
    actions: { comment: { max: 2, approve: true } },
  });

  const session = await t.attach((await fired(t, "triage")).sessionId ?? "");

  await propose(session, "comment", { number: 7, body: "Yes?" });
  await propose(session, "comment", { number: 7, body: "No?" });
  await turnEnds(t, "triage", session);

  const [yes, no] = (await latest(t, "triage"))?.proposals ?? [];

  expect([yes?.state, no?.state]).toEqual(["waiting", "waiting"]);
  expect(written).toEqual([]);

  await t
    .as("bo")
    .post(`routines/triage/proposals/${yes?.id ?? ""}/approve`)
    .catch(() => undefined);

  expect(written).toEqual([]);

  await t.as("ana").post(`routines/triage/proposals/${yes?.id ?? ""}/approve`);
  await t.as("ana").post(`routines/triage/proposals/${no?.id ?? ""}/reject`);

  expect(written.map(({ input }) => input)).toEqual([
    { number: 7, body: "Yes?" },
  ]);

  expect((await latest(t, "triage"))?.proposals).toMatchObject([
    { state: "applied" },
    { state: "rejected" },
  ]);

  expect(
    await failureOf(
      t.as("ana").post(`routines/triage/proposals/${no?.id ?? ""}/approve`),
    ),
  ).toMatch(/waits for approval/);
});

test("a dry run's proposals are shown and never applied, from Run now or the routines tool", async () => {
  await using t = await started();

  await save(t, "triage", {
    title: "Triage",
    when: [{ kind: "webhook" }],
    do: work,
    actions: { comment: 3 },
  });

  const run = await t
    .as("ana")
    .post<Run>("routines/triage/run", { dryRun: true });

  expect(run).toMatchObject({ dryRun: true, proposes: true });
  expect(sessionOf(run).proposes).toBe(true);

  const session = await t.attach(run.sessionId ?? "");

  expect(await session.api.get("run")).toMatchObject({ dryRun: true });

  await propose(session, "comment", { number: 7, body: "Hi." });
  await turnEnds(t, "triage", session);

  expect(written).toEqual([]);

  expect((await latest(t, "triage"))?.proposals).toMatchObject([
    { state: "shown", input: { number: 7, body: "Hi." } },
  ]);
});

test("a routine that names an action no plugin offers isn't saved", async () => {
  await using t = await started();

  expect(
    await failureOf(
      save(t, "triage", {
        title: "Triage",
        when: onIssues,
        do: work,
        actions: { deploy: 1 },
      }),
    ),
  ).toMatch("actions.deploy: no plugin that is on offers this action");
});

test("replay fires a past run's events again at the routine as it is now", async () => {
  await using t = await started();

  await save(t, "triage", {
    title: "Triage",
    when: onIssues,
    do: work,
  });

  const first = await fired(t, "triage", 9);

  await save(t, "triage", {
    title: "Triage",
    when: onIssues,
    do: { ...work, prompt: "Triage it again." },
    actions: { comment: 1 },
  });

  const replayed = await t
    .as("ana")
    .post<Run>(`routines/triage/runs/${first.id}/replay`, { dryRun: true });

  expect(replayed).toMatchObject({
    cause: "replay",
    dryRun: true,
    outcome: "running",
  });

  expect(sessionOf(replayed).firstMessage).toContain("Triage it again.");
  expect(sessionOf(replayed).firstMessage).toContain('"number": 9');
});

test("saving a new event routine runs it once on the newest event that matches, as a dry run when it has actions", async () => {
  await using t = await started();

  issue(3);
  issue(4);
  await t.clock.advance("1h");

  const saved = await save(t, "triage", {
    title: "Triage",
    when: onIssues,
    do: work,
    actions: { comment: 1 },
  });

  expect(saved.runs).toMatchObject([
    { cause: "test", dryRun: true, outcome: "running" },
  ]);

  expect(sessionOf(saved.runs[0]).firstMessage).toContain('"number": 4');

  const again = await save(t, "triage", {
    title: "Triage",
    when: onIssues,
    do: work,
  });

  expect(again.runs).toHaveLength(1);

  await t.clock.advance("8d");

  expect(
    (await save(t, "late", { title: "Late", when: onIssues, do: work })).runs,
  ).toEqual([]);
});

test("the propose tool sends a pull request with the commits on the workspace branch since it started", async () => {
  await using t = await started();

  await save(t, "fix", {
    title: "Fix",
    when: onIssues,
    sameWork: { key: ["number"] },
    do: work,
    actions: { pullRequest: 1, "tracker.comment": 1 },
  });

  const run = await fired(t, "fix");
  const host = await t.attach(run.sessionId ?? "");
  const repo = mkdtempSync(join(tmpdir(), "routines-checkout-"));

  const git = (...args: string[]): string =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();

  git("init", "--quiet", "--initial-branch=main");

  git(
    "-c",
    "user.name=A",
    "-c",
    "user.email=a@b",
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    "start",
  );

  const base = git("rev-parse", "HEAD");

  git("checkout", "--quiet", "-b", "pipoca/run");

  const part = await testSession(sessionPart, {
    request: host.api.raw,
    checkouts: [{ path: repo, base }],
  });

  expect(
    await part.tool("propose", {
      action: "pullRequest",
      input: { title: "Fix" },
    }),
  ).toMatchObject({
    isError: true,
    text: "there are no commits on the branch to push; commit your work first",
  });

  writeFileSync(join(repo, "fix.txt"), "fixed\n");
  git("add", "fix.txt");

  git(
    "-c",
    "user.name=A",
    "-c",
    "user.email=a@b",
    "commit",
    "--quiet",
    "-m",
    "Fix",
  );

  expect(
    await part.tool("propose", {
      action: "pullRequest",
      input: { title: "Fix" },
    }),
  ).toMatchObject({
    isError: false,
    text: "Proposed Open a pull request. Pipoca applies it once this turn ends.",
  });

  expect(
    await part.tool("propose", {
      action: "tracker.comment",
      input: { number: 1, body: "a" },
    }),
  ).toMatchObject({ isError: false });

  expect(
    await part.tool("propose", {
      action: "tracker.comment",
      input: { number: 1, body: "b" },
    }),
  ).toMatchObject({
    isError: true,
    text: "Refused: the routine allows tracker.comment at most 1 time a run",
  });

  await turnEnds(t, "fix", host);

  const bundle =
    written.find(({ kind }) => kind === "pullRequest")?.commits ?? "";

  expect(bundle.startsWith("# v2 git bundle\n")).toBe(true);
  expect(bundle).toContain(`-${base}`);
  expect(bundle).toContain(`${git("rev-parse", "HEAD")} refs/heads/pipoca/run`);

  expect(
    await propose(host, "pullRequest", { title: "Fix, without commits" }),
  ).toMatchObject({
    state: "refused",
    result: "pullRequest needs the commits on the workspace branch",
  });

  // Proposed again, it updates the pull request the run opened.
  expect(
    await part.tool("propose", {
      action: "pullRequest",
      input: { title: "Fix, again" },
    }),
  ).toMatchObject({ isError: false });

  await turnEnds(t, "fix", host);

  expect(written.map(({ kind }) => kind)).toEqual([
    "pullRequest",
    "comment",
    "pullRequest",
  ]);

  await t.tool("end_run", { result: "done", summary: "-" }, { session: host });

  issue(7);
  await t.clock.advance("30s");

  expect(await latest(t, "fix")).toMatchObject({
    reason: "sent to the Session that opened https://example.com/o/r/pull/12",
    sessionId: run.sessionId,
  });

  const own = await t.attach((await t.session({ owner: person("ana") })).id);
  const plain = await testSession(sessionPart, { request: own.api.raw });

  expect(await failureOf(plain.tool("propose", {}))).toMatch(
    "has no tool propose",
  );
});
