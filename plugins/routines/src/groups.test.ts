import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
  testPlugin,
  testSession,
} from "@pipoca/testing";
import { usage } from "@pipoca/usage/plugin";
import type {
  GroupDetail,
  GroupView,
  Imported,
  RoutineDetail,
  Run,
} from "./model";
import { server } from "./server";
import { session as sessionPart } from "./session";

const people = [
  { id: "ana", name: "Ana", admin: true },
  { id: "bo", name: "Bo" },
];

// Stands in for the git hosts plugin: its issues, by its id.
const gitHosts = definePlugin({
  id: "git-hosts",
  title: "Git hosts",
  description: "Publishes issues.",
  works: ["personal", "team"],
  events: {
    issue: event({
      title: "Issue",
      fields: Type.Object({
        host: Type.String(),
        repository: Type.String(),
        number: Type.Number(),
        member: Type.Boolean(),
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
  const t = await testPlugin(server, { people, plugins });

  await t.session({ owner: person("ana") });

  return t;
}

function issue(repository: string, number = 1, host = "github.com"): void {
  hosting?.events.emit(
    "issue",
    { host, repository, number, member: true },
    { to: [person("ana")] },
  );
}

const work = {
  kind: "session",
  prompt: "Fix it.",
  workspace: { kind: "folder", path: "/srv/a" },
};

const shop = {
  title: "Shop",
  repositories: ["acme/shop", "https://github.com/acme/api.git"],
};

async function board(t: PluginTest, name: string): Promise<GroupDetail> {
  return t.as("ana").get<GroupDetail>(`groups/${name}`);
}

async function detail(t: PluginTest, name: string): Promise<RoutineDetail> {
  return t.as("ana").get<RoutineDetail>(`routines/${name}`);
}

function sessionOf(run: Run | undefined) {
  const session = hosting?.sessions.get(run?.sessionId ?? "");

  if (session === undefined) {
    throw new Error("no run Session");
  }

  return session;
}

function configDir(): string {
  return join(dirname(hosting?.config.dir ?? ""), "routines");
}

async function failureOf(answer: Promise<unknown>): Promise<string> {
  try {
    await answer;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }

  throw new Error("it didn't fail");
}

test("a group is a folder under its owner's with its group.json and its routines, and a routine moves in and out of it", async () => {
  await using t = await started();

  await t.as("ana").put("groups/shop", shop);

  await t.as("ana").put("routines/fix?group=shop", {
    title: "Fix",
    when: [{ kind: "webhook" }],
    do: work,
  });

  await t.as("ana").put("routines/daily", {
    title: "Daily",
    when: [{ kind: "webhook" }],
    do: work,
  });

  const dir = join(configDir(), "ana");

  expect(existsSync(join(dir, "shop", "group.json"))).toBe(true);
  expect(existsSync(join(dir, "shop", "fix.json"))).toBe(true);
  expect(existsSync(join(dir, "daily.json"))).toBe(true);

  expect(await t.as("ana").get<GroupView[]>("groups")).toMatchObject([
    { name: "shop", title: "Shop", paused: null },
  ]);

  expect((await board(t, "shop")).routines.map(({ name }) => name)).toEqual([
    "fix",
  ]);

  expect(await detail(t, "fix")).toMatchObject({ group: "shop" });

  // Saved again without saying where, it stays in its group.
  await t.as("ana").put("routines/fix", {
    title: "Fix it",
    when: [{ kind: "webhook" }],
    do: work,
  });

  expect(existsSync(join(dir, "shop", "fix.json"))).toBe(true);

  await t.as("ana").put("routines/fix?group=", {
    title: "Fix it",
    when: [{ kind: "webhook" }],
    do: work,
  });

  expect(existsSync(join(dir, "shop", "fix.json"))).toBe(false);
  expect(existsSync(join(dir, "fix.json"))).toBe(true);
  expect((await board(t, "shop")).routines).toEqual([]);

  await t.as("ana").delete("groups/shop");
  expect(existsSync(join(dir, "shop"))).toBe(false);
});

test("a team routine joins only the team's groups, and a group with routines isn't removed", async () => {
  await using t = await started();
  await t.session({ owner: "team", startedBy: "ana" });

  await t.as("ana").put("groups/mine", { title: "Mine" });

  const team = { title: "Team", when: [{ kind: "webhook" }], do: work };

  expect(
    await failureOf(t.as("ana").put("team/routines/fix?group=mine", team)),
  ).toBe("no group mine");

  await t.as("ana").put("team/groups/ours", { title: "Ours" });
  await t.as("ana").put("team/routines/fix?group=ours", team);

  expect(existsSync(join(configDir(), "team", "ours", "fix.json"))).toBe(true);
  expect(await t.as("ana").get<GroupView[]>("groups")).toHaveLength(1);

  expect(await failureOf(t.as("ana").delete("team/groups/ours"))).toBe(
    "the group still has routines: move or delete them first",
  );
});

test("group.json is checked when saved, coordinator limits included", async () => {
  await using t = await started();

  expect(
    await failureOf(
      t.as("ana").put("groups/bad", { title: "Bad", repositories: ["shop"] }),
    ),
  ).toContain("isn't owner/name, host/owner/name or an https address");

  expect(
    await failureOf(
      t.as("ana").put("groups/bad", {
        title: "Bad",
        coordinator: { atOnce: 0 },
      }),
    ),
  ).toContain("coordinator.atOnce");

  await t.as("ana").put("groups/good", {
    title: "Good",
    coordinator: { atOnce: 5, askAbove: 3 },
  });

  expect((await board(t, "good")).group).toMatchObject({
    coordinator: { atOnce: 5, askAbove: 3 },
  });
});

test("a group's defaults and limits fill what its routines leave out", async () => {
  await using t = await started();
  const { id: environment } = await t.environment({ owner: person("ana") });

  await t.as("ana").put("groups/shop", {
    ...shop,
    defaults: { environment, as: "shop-bot" },
    limits: { timeLimit: "1h" },
  });

  await t.as("ana").put("routines/fix?group=shop", {
    title: "Fix",
    when: [{ kind: "webhook" }],
    do: work,
  });

  // The file keeps only what the routine says.
  expect((await detail(t, "fix")).routine as unknown).toEqual({
    title: "Fix",
    when: [{ kind: "webhook" }],
    do: work,
  });

  const run = await t.as("ana").post<Run>("routines/fix/run", {});

  expect(sessionOf(run)).toMatchObject({
    environmentId: environment,
    actsAs: { plugin: "git-hosts", name: "shop-bot" },
  });

  await t.clock.advance("61m");

  expect((await detail(t, "fix")).runs[0]).toMatchObject({
    outcome: "failed",
    reason: "ran past its time limit of 1h",
  });
});

test("a condition can hold for the group's repositories, and a run's workspace can be all of them", async () => {
  await using t = await started();

  await t.as("ana").put("groups/shop", shop);

  await t.as("ana").put("routines/fix?group=shop", {
    title: "Fix",
    when: [
      {
        kind: "event",
        event: "git-hosts.issue",
        where: [{ field: "repository", inGroup: true }],
      },
    ],
    sameWork: { key: ["repository", "number"] },
    do: { ...work, workspace: { kind: "group" } },
  });

  issue("acme/other");
  issue("Acme/Shop", 2);
  issue("acme/api", 3, "example.com");
  await t.clock.advance("30s");

  const { runs } = await detail(t, "fix");

  expect(runs).toHaveLength(1);

  expect(sessionOf(runs[0]).workspace).toMatchObject({
    kind: "repositories",
    repositories: [
      { repository: "https://github.com/acme/shop" },
      { repository: "https://github.com/acme/api" },
    ],
  });
});

test("a routine that names its group's repositories needs a group that has some", async () => {
  await using t = await started();

  const routine = {
    title: "Fix",
    when: [{ kind: "webhook" }],
    do: { ...work, workspace: { kind: "group" } },
  };

  expect(await failureOf(t.as("ana").put("routines/fix", routine))).toBe(
    "the routine names its group's repositories, but it is in no group",
  );

  await t.as("ana").put("groups/empty", { title: "Empty" });

  expect(
    await failureOf(t.as("ana").put("routines/fix?group=empty", routine)),
  ).toBe("the routine names its group's repositories, but its group has none");
});

test("a group's daily budget pauses all its routines until the next day, and its board shows cost and success per routine", async () => {
  await using t = await started();

  await t.as("ana").put("groups/shop", { ...shop, budget: { dailySpend: 10 } });

  for (const name of ["fix", "docs"]) {
    await t.as("ana").put(`routines/${name}?group=shop`, {
      title: name,
      when: [{ kind: "schedule", cron: "0 * * * *", timeZone: "UTC" }],
      do: work,
    });
  }

  const fix = await t.as("ana").post<Run>("routines/fix/run", {});
  const docs = await t.as("ana").post<Run>("routines/docs/run", {});

  await t.tool(
    "end_run",
    { result: "done", summary: "Fixed" },
    { session: await t.attach(fix.sessionId ?? "") },
  );

  spending?.events.emit(
    "spent",
    { sessionId: fix.sessionId ?? "", cost: 6 },
    { to: [person("ana")] },
  );

  expect((await board(t, "shop")).paused).toBeNull();

  spending?.events.emit(
    "spent",
    { sessionId: docs.sessionId ?? "", cost: 4 },
    { to: [person("ana")] },
  );

  const paused = await board(t, "shop");

  expect(paused).toMatchObject({
    paused:
      "Paused until tomorrow with its group Shop: the group spent 10.00 today, and its daily budget is 10.",
    spentToday: 10,
    succeeded: 1,
    failed: 0,
    successRate: 1,
    costs: [
      { name: "docs", spentToday: 4, successRate: null },
      { name: "fix", spentToday: 6, succeeded: 1, successRate: 1 },
    ],
  });

  expect(paused.work.map(({ routine }) => routine).sort()).toEqual([
    "docs",
    "fix",
  ]);

  expect(t.emitted("routines.paused")).toEqual([
    {
      fields: {
        name: "shop",
        title: "Shop",
        reason: paused.paused,
        until: paused.pausedUntil,
      },
      to: [person("ana")],
    },
  ]);

  expect(await detail(t, "docs")).toMatchObject({
    paused: paused.paused,
    nextAt: null,
  });

  await t.clock.advance(Date.parse(paused.pausedUntil ?? "") - t.clock.now());

  expect(await board(t, "shop")).toMatchObject({ paused: null });
  expect((await detail(t, "docs")).nextAt).not.toBeNull();
});

test("a run in a group reads the group's memory as files and adds dated notes to it, one at a time", async () => {
  await using t = await started();

  await t.as("ana").put("groups/shop", shop);

  await t.as("ana").put("routines/fix?group=shop", {
    title: "Fix",
    when: [{ kind: "webhook" }],
    do: work,
  });

  const run = await t.as("ana").post<Run>("routines/fix/run", {});
  const host = await t.attach(run.sessionId ?? "");

  expect(sessionOf(run).systemPrompt).toContain(
    'The routine is in the group "Shop", whose memory its runs share',
  );

  const part = await testSession(sessionPart, { request: host.api.raw });

  await Promise.all([
    part.tool("memory", { note: "Use the staging database." }),
    part.tool("memory", { note: "Releases go out on Tuesdays." }),
    part.tool("memory", { note: "Ask Bo about payments.", file: "people.md" }),
  ]);

  const { memory } = await board(t, "shop");

  expect(Object.keys(memory)).toEqual(["decisions.md", "people.md"]);
  expect(memory["decisions.md"]).toContain("Use the staging database.");
  expect(memory["decisions.md"]).toContain("Releases go out on Tuesdays.");

  expect(memory["decisions.md"]).toMatch(
    /^## \d{4}-\d\d-\d\d \d\d:\d\d UTC, fix\n\n/,
  );

  await part.event("before_agent_start");

  const copied = (await part.tool("memory", { note: "One more." })).text;
  const path = /Noted in (\S+)\./.exec(copied)?.[1] ?? "";

  expect(readFileSync(path, "utf8")).toContain("One more.");
  expect(readFileSync(path, "utf8")).toContain("Use the staging database.");

  expect(
    (await part.tool("memory", { note: "x", file: "../escape.md" })).isError,
  ).toBe(true);
});

test("a run outside any group gets no memory tool", async () => {
  await using t = await started();

  await t.as("ana").put("routines/fix", {
    title: "Fix",
    when: [{ kind: "webhook" }],
    do: work,
  });

  const run = await t.as("ana").post<Run>("routines/fix/run", {});
  const host = await t.attach(run.sessionId ?? "");
  const part = await testSession(sessionPart, { request: host.api.raw });

  expect(await failureOf(part.tool("memory", { note: "x" }))).toMatch(
    "has no tool memory",
  );
});

test("a team group's editors alone change it and the routines in it", async () => {
  await using t = await started();
  await t.session({ owner: "team", startedBy: "ana" });

  await t.as("ana").put("team/groups/ours", { title: "Ours", editors: ["Bo"] });

  const team = { title: "Team", when: [{ kind: "webhook" }], do: work };

  const refused = await t.as("ana").raw("team/routines/fix?group=ours", {
    method: "PUT",
    body: JSON.stringify(team),
  });

  expect(refused.status).toBe(403);

  await t.as("bo").put("team/routines/fix?group=ours", team);

  const changed = await t.as("ana").raw("team/routines/fix", {
    method: "PUT",
    body: JSON.stringify({ ...team, title: "Mine" }),
  });

  expect(changed.status).toBe(403);

  const renamed = await t.as("ana").raw("team/groups/ours", {
    method: "PUT",
    body: JSON.stringify({ title: "Mine" }),
  });

  expect(renamed.status).toBe(403);
});

async function profileWith(
  t: PluginTest,
  files: Readonly<Record<string, string>>,
): Promise<string> {
  const { id } = await t.as("ana").post<{ id: string }>("/api/profiles", {
    name: `Factory ${String(Math.random())}`,
  });

  await t.as("ana").post(`/api/profiles/${id}/files`, {
    files: Object.fromEntries(
      Object.entries(files).map(([path, text]) => [
        path,
        Buffer.from(text).toString("base64"),
      ]),
    ),
  });

  return id;
}

async function filesOf(bytes: Uint8Array): Promise<Record<string, string>> {
  const found: Record<string, string> = {};

  for (const [path, file] of await new Bun.Archive(bytes).files()) {
    found[path] = await file.text();
  }

  return found;
}

test("a group exports as one archive with its routines and the agents and workflows they start, and imports into a Profile", async () => {
  await using t = await started();

  const factory = await profileWith(t, {
    "agents/fixer.md": "---\nname: fixer\n---\nFix bugs.\n",
    "agents/unused.md": "---\nname: unused\n---\nNo.\n",
    "workflows/release.js": "export default async () => {};\n",
    "mcp.json":
      '{ "mcpServers": { "jira": { "headers": { "token": "secret" } } } }',
  });

  await t
    .as("ana")
    .put("groups/shop", { ...shop, defaults: { profile: factory } });

  await t.as("ana").put("routines/fix?group=shop", {
    title: "Fix",
    when: [{ kind: "webhook", workflow: "release" }],
    do: { ...work, agent: "fixer" },
  });

  await t.as("ana").put("routines/scout?group=shop", {
    title: "Scout",
    when: [{ kind: "webhook" }],
    do: { ...work, agent: "scout" },
  });

  const response = await t.as("ana").raw("groups/shop/archive");

  expect(response.headers.get("content-type")).toBe("application/gzip");

  const bytes = new Uint8Array(await response.arrayBuffer());
  const files = await filesOf(bytes);

  expect(Object.keys(files).sort()).toEqual([
    "agents/fixer.md",
    "pipoca-group.json",
    "shop/fix.json",
    "shop/group.json",
    "shop/scout.json",
    "workflows/release.js",
  ]);

  expect(JSON.stringify(files)).not.toContain("secret");

  // Another owner, here the team, takes it into a Profile of its own.
  await t.session({ owner: "team", startedBy: "ana" });

  const { id: teamFactory } = await t
    .as("ana")
    .post<{ id: string }>("/api/profiles", {
      name: "Team factory",
      team: true,
    });

  await t.as("ana").post(`/api/profiles/${teamFactory}/files`, {
    files: {
      "agents/fixer.md": Buffer.from("Our own fixer.\n").toString("base64"),
    },
  });

  const imported = await t
    .as("ana")
    .raw(`team/groups/archives?profile=${teamFactory}`, {
      method: "POST",
      body: bytes,
    });

  expect(imported.status).toBe(201);

  expect((await imported.json()) as Imported).toEqual({
    name: "shop",
    routines: ["fix", "scout"],
    added: ["workflows/release.js"],
    kept: ["agents/fixer.md"],
  });

  const group = await t.as("ana").get<GroupDetail>("team/groups/shop");

  expect(group.group?.defaults).toEqual({ profile: teamFactory });
  expect(group.routines.map(({ name }) => name)).toEqual(["fix", "scout"]);

  const stacked = await t
    .as("ana")
    .get<Record<string, string>>(`/api/profiles/${teamFactory}/stacked`);

  expect(stacked["workflows/release.js"]).toBe(
    "export default async () => {};\n",
  );

  expect(stacked["agents/fixer.md"]).toBe("Our own fixer.\n");

  const again = await t
    .as("ana")
    .raw(`team/groups/archives?profile=${teamFactory}`, {
      method: "POST",
      body: bytes,
    });

  expect(again.status).toBe(400);
});
