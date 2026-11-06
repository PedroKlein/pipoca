import { afterEach, beforeEach, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { StoredSession } from "@pipoca/sessions";
import { openStore } from "./store";

let root: string;
let defaultProfile: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "store-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("opens its own database again", () => {
  const path = join(root, "server.db");
  openStore(path).close();

  const store = openStore(path);
  store.environments.ensureEnvironment("vm", "team");
  store.environments.ensureEnvironment("vm", "team");
  const [environment] = store.environments.environments();

  store.sessions.insert({
    id: "s1",
    environmentId: environment?.id ?? "",
    plugin: null,
    provider: "vm",
    runner: null,
    profileId: store.sessions.defaultProfileId("local"),
    workspace: { kind: "clone", repository: "r", branch: "b" },
    model: { provider: "openai", id: "gpt-5-mini" },
    thinking: "high",
    systemPrompt: null,
    firstMessage: null,
    title: null,
    status: "queued",
    generation: 0,
    createdAt: "2026-10-20T00:00:00.000Z",
    interruptedAt: null,
    error: null,
    archivedAt: null,
    workspaceRemoval: null,
    workspaceKeptReason: null,
    startedBy: null,
    actsAs: null,
  });

  expect(store.environments.environments()).toHaveLength(1);

  expect(store.sessions.get("s1")).toMatchObject({
    provider: "vm",
    thinking: "high",
    workspace: { kind: "clone", repository: "r", branch: "b" },
    model: { provider: "openai", id: "gpt-5-mini" },
  });

  store.close();
});

// The Sessions list reads only the rows the person or the team owns, rather
// than every Session on the server.
test("lists only one person's Sessions, or only the team's", () => {
  const store = openStore(":memory:");
  defaultProfile = store.sessions.defaultProfileId("local");

  for (const id of ["ana", "bo"]) {
    store.people.insertUser({
      id,
      name: id,
      admin: false,
      passwordHash: "",
      createdAt: new Date().toISOString(),
    });

    store.environments.ensureEnvironment(id, id);
  }

  store.environments.ensureEnvironment("pods", "team");

  const environmentOf = (slug: string): string =>
    store.environments.environments().find((each) => each.provider === slug)
      ?.id ?? "";

  store.sessions.insert(
    sessionIn(environmentOf("ana"), "ana", {
      id: "anas",
      createdAt: "2026-10-24T00:00:01.000Z",
      startedBy: "ana",
    }),
  );

  store.sessions.insert(
    sessionIn(environmentOf("ana"), "ana", {
      id: "anas-plugin",
      createdAt: "2026-10-24T00:00:02.000Z",
    }),
  );

  store.sessions.insert(
    sessionIn(environmentOf("bo"), "bo", {
      id: "bos",
      createdAt: "2026-10-24T00:00:03.000Z",
      startedBy: "bo",
    }),
  );

  store.sessions.insert(
    sessionIn(environmentOf("pods"), "pods", {
      id: "teams",
      createdAt: "2026-10-24T00:00:04.000Z",
      startedBy: "ana",
    }),
  );

  const ids = (owner: string | null): string[] =>
    store.sessions.list({ includeArchived: false, owner }).map(({ id }) => id);

  expect(ids("ana")).toEqual(["anas-plugin", "anas"]);
  expect(ids("bo")).toEqual(["bos"]);
  expect(ids(null)).toEqual(["teams"]);

  store.close();
});

test("lists the Sessions one owner holds", () => {
  const store = openStore(":memory:");
  defaultProfile = store.sessions.defaultProfileId("local");
  store.environments.ensureEnvironment("vm", "team");
  const [environment] = store.environments.environments();
  const id = environment?.id ?? "";
  const project = { id: "projects", key: "p1" };

  store.sessions.insert(
    sessionIn(id, "vm", {
      id: "owned",
      createdAt: "2026-10-24T00:00:01.000Z",
      plugin: project,
    }),
  );

  store.sessions.insert(
    sessionIn(id, "vm", { id: "plain", createdAt: "2026-10-24T00:00:02.000Z" }),
  );

  store.sessions.insert(
    sessionIn(id, "vm", {
      id: "other",
      createdAt: "2026-10-24T00:00:03.000Z",
      plugin: { id: "projects", key: "p2" },
    }),
  );

  expect(
    store.sessions
      .list({ includeArchived: false, plugin: project })
      .map((s) => s.id),
  ).toEqual(["owned"]);

  expect(store.sessions.get("owned")?.plugin).toEqual(project);
  expect(store.sessions.list({ includeArchived: false })).toHaveLength(3);

  store.close();
});

function sessionIn(
  environmentId: string,
  provider: string,
  fields: Partial<StoredSession> & Pick<StoredSession, "id" | "createdAt">,
): StoredSession {
  return {
    environmentId,
    plugin: null,
    provider,
    runner: null,
    profileId: defaultProfile,
    workspace: { kind: "clone", repository: "r", branch: fields.id },
    model: null,
    thinking: null,
    systemPrompt: null,
    firstMessage: null,
    title: null,
    status: "stopped",
    generation: 1,
    interruptedAt: null,
    error: null,
    archivedAt: null,
    workspaceRemoval: null,
    workspaceKeptReason: null,
    startedBy: null,
    actsAs: null,
    ...fields,
  };
}

test("lists sessions newest first and leaves archived ones out unless asked", () => {
  const store = openStore(join(root, "server.db"));
  defaultProfile = store.sessions.defaultProfileId("local");
  store.environments.ensureEnvironment("vm", "team");
  const vm = store.environments.environments()[0]?.id ?? "";

  for (const session of [
    sessionIn(vm, "vm", {
      id: "old",
      createdAt: "2026-10-01T00:00:00.000Z",
      status: "idle",
    }),
    sessionIn(vm, "vm", {
      id: "archived",
      createdAt: "2026-10-02T00:00:00.000Z",
      archivedAt: "2026-10-03T00:00:00.000Z",
    }),
    sessionIn(vm, "vm", {
      id: "new",
      createdAt: "2026-10-04T00:00:00.000Z",
      status: "queued",
    }),
  ]) {
    store.sessions.insert(session);
  }

  const ids = (includeArchived: boolean): string[] =>
    store.sessions.list({ includeArchived }).map(({ id }) => id);

  expect(ids(false)).toEqual(["new", "old"]);
  expect(ids(true)).toEqual(["new", "archived", "old"]);

  store.close();
});

test("lists a provider's stopped sessions whose workspace is waiting to be removed, oldest first", () => {
  const store = openStore(join(root, "server.db"));
  defaultProfile = store.sessions.defaultProfileId("local");
  store.environments.ensureEnvironment("vm", "team");
  store.environments.ensureEnvironment("laptop", "team");

  const environments = new Map(
    store.environments.environments().map(({ provider, id }) => [provider, id]),
  );

  const vm = environments.get("vm") ?? "";
  const archivedAt = "2026-10-10T00:00:00.000Z";

  const forced = sessionIn(vm, "vm", {
    id: "forced",
    runner: "vm",
    createdAt: "2026-10-03T00:00:00.000Z",
    archivedAt,
    workspaceRemoval: "forced",
  });

  for (const session of [
    forced,
    sessionIn(vm, "vm", {
      id: "pending",
      createdAt: "2026-10-01T00:00:00.000Z",
      archivedAt,
      workspaceRemoval: "pending",
    }),
    sessionIn(vm, "vm", {
      id: "removed",
      createdAt: "2026-10-02T00:00:00.000Z",
      archivedAt,
      workspaceRemoval: "removed",
    }),
    sessionIn(vm, "vm", {
      id: "kept",
      createdAt: "2026-10-04T00:00:00.000Z",
      archivedAt,
      workspaceRemoval: "kept",
    }),
    sessionIn(vm, "vm", {
      id: "nothing to remove",
      createdAt: "2026-10-05T00:00:00.000Z",
      archivedAt,
    }),
    sessionIn(vm, "vm", {
      id: "running",
      createdAt: "2026-10-06T00:00:00.000Z",
      status: "running",
      workspaceRemoval: "pending",
    }),
    sessionIn(vm, "vm", {
      id: "on another runner",
      runner: "vm-2",
      createdAt: "2026-10-06T00:00:00.000Z",
      archivedAt,
      workspaceRemoval: "pending",
    }),
    sessionIn(environments.get("laptop") ?? "", "laptop", {
      id: "elsewhere",
      createdAt: "2026-10-07T00:00:00.000Z",
      archivedAt,
      workspaceRemoval: "pending",
    }),
  ]) {
    store.sessions.insert(session);
  }

  const removals = store.sessions.pendingRemovals("vm", "vm");

  expect(removals.map(({ id }) => id)).toEqual(["pending", "forced"]);
  expect(removals[1]).toEqual(forced);

  expect(
    store.sessions.pendingRemovals("laptop", "laptop").map(({ id }) => id),
  ).toEqual(["elsewhere"]);

  expect(
    store.sessions.pendingRemovals("vm", "vm-2").map(({ id }) => id),
  ).toEqual(["pending", "on another runner"]);

  store.close();
});

function rawSecrets(path: string): string[] {
  const db = new DatabaseSync(path);

  const rows = db.prepare("select secrets_sealed from environments").all() as {
    secrets_sealed: string;
  }[];

  db.close();

  return rows.map(({ secrets_sealed }) => secrets_sealed);
}

test("stores Environment secrets encrypted and reads them back after a restart", () => {
  const path = join(root, "server.db");
  const store = openStore(path);
  store.environments.ensureEnvironment("vm", "team");
  const [environment] = store.environments.environments();

  if (environment === undefined) {
    throw new Error("no Environment");
  }

  store.environments.updateEnvironment({
    ...environment,
    secrets: { GH_TOKEN: "ghp_1" },
  });

  store.close();

  expect(rawSecrets(path).join()).not.toContain("ghp_1");

  const again = openStore(path);

  expect(again.environments.environments()[0]?.secrets).toEqual({
    GH_TOKEN: "ghp_1",
  });

  again.close();
});

test("keeps no setup of its own for an Environment made from a template", () => {
  const path = join(root, "server.db");
  const store = openStore(path);
  store.environments.ensureEnvironment("vm", "team", "python");
  store.environments.ensureEnvironment("laptop", "team");

  for (const environment of store.environments.environments()) {
    store.environments.updateEnvironment({
      ...environment,
      name: `${environment.name}!`,
    });
  }

  store.close();

  const db = new DatabaseSync(path);

  expect(
    db
      .prepare(
        "select slug, isolation, image, setup_script from environments order by slug",
      )
      .all(),
  ).toEqual([
    { slug: "laptop", isolation: "process", image: null, setup_script: "" },
    { slug: "vm", isolation: null, image: null, setup_script: null },
  ]);

  expect(() => {
    db.exec("update environments set setup_script = 'make' where slug = 'vm'");
  }).toThrow("CHECK constraint failed");

  db.close();
});

test("keeps the team's Environments the team's when the first person signs up", () => {
  const store = openStore(":memory:");
  store.environments.ensureEnvironment("shared", "team");

  store.people.insertUser({
    id: "ana",
    name: "ana",
    admin: true,
    passwordHash: "",
    createdAt: new Date().toISOString(),
  });

  expect(
    store.environments.environments().map(({ ownerId }) => ownerId),
  ).toEqual(["team"]);

  store.close();
});

test("refuses to open a database's secrets with another key", () => {
  const path = join(root, "server.db");
  const store = openStore(path, randomBytes(32));
  store.environments.ensureEnvironment("vm", "team");
  const [environment] = store.environments.environments();

  if (environment === undefined) {
    throw new Error("no Environment");
  }

  store.environments.updateEnvironment({
    ...environment,
    secrets: { GH_TOKEN: "ghp_1" },
  });

  store.close();

  expect(() => openStore(path, randomBytes(32))).toThrow(
    "the secret key doesn't open this database's secrets",
  );
});

test("refuses a secret key of the wrong length", () => {
  expect(() => openStore(":memory:", randomBytes(16))).toThrow(
    "the secret key must be 32 bytes",
  );
});

test("seals a plugin's secrets so only that plugin opens them, for that row", () => {
  const store = openStore(":memory:");
  const sealed = store.plugin("oidc").seal("s3cret", "provider-1");

  expect(sealed).not.toContain("s3cret");
  expect(store.plugin("oidc").open(sealed, "provider-1")).toBe("s3cret");
  expect(() => store.plugin("other").open(sealed, "provider-1")).toThrow();
  expect(() => store.plugin("oidc").open(sealed, "provider-2")).toThrow();

  store.close();
});

test("refuses a database that an older Pipoca made", () => {
  const path = join(root, "server.db");
  const old = new DatabaseSync(path);
  old.exec("create table sessions (id text primary key, cwd text not null)");
  old.close();

  expect(() => openStore(path)).toThrow(
    "this database was made by another Pipoca version; move it aside to start fresh",
  );
});

test("refuses a database whose kernel tables came from other SQL", () => {
  const path = join(root, "server.db");
  openStore(path).close();

  const db = new DatabaseSync(path);
  db.exec("update schema_owners set sql_hash = 'other' where owner = 'kernel'");
  db.close();

  expect(() => openStore(path)).toThrow("move it aside to start fresh");
});

test("fails a plugin whose tables came from other SQL, and keeps its data", () => {
  const path = join(root, "server.db");

  const notes = (sql: string) => ({
    name: "notes",
    schema: sql,
  });

  const first = openStore(path, undefined, undefined, undefined, [
    notes("create table notes_items (text text not null) strict"),
  ]);

  first.plugin("notes").run("insert into notes_items (text) values ('kept')");
  first.close();

  const changed = notes(
    "create table notes_items (text text not null, at integer) strict",
  );

  const second = openStore(path, undefined, undefined, undefined, [changed]);

  expect(() => second.plugin("notes")).toThrow(
    "its tables were made by another version of notes",
  );

  second.close();

  const same = openStore(path, undefined, undefined, undefined, [
    notes("create table notes_items (text text not null) strict"),
  ]);

  expect(same.plugin("notes").all("select text from notes_items")).toEqual([
    { text: "kept" },
  ]);

  same.close();
});

test("makes the tables of a plugin turned on later, and refuses ones outside its name", () => {
  const path = join(root, "server.db");
  openStore(path).close();

  const store = openStore(path, undefined, undefined, undefined, [
    {
      name: "notes",
      schema: "create table notes_items (text text) strict",
    },
    {
      name: "copier",
      schema: "create table sessions_copy (id text) strict",
    },
  ]);

  store.plugin("notes").run("insert into notes_items (text) values ('hi')");

  expect(store.plugin("notes").all("select text from notes_items")).toEqual([
    { text: "hi" },
  ]);

  expect(() => store.plugin("copier")).toThrow(
    "plugin copier may only create copier_ tables",
  );

  store.close();
});

test("refuses a plugin whose tables' names would run into the kernel's or another plugin's", () => {
  const path = join(root, "server.db");

  const store = openStore(path, undefined, undefined, undefined, [
    {
      name: "git-hosts",
      schema: "create table git_hosts_watches (id text) strict",
    },
    { name: "git", schema: "create table git_items (id text) strict" },
    { name: "session", schema: "create table session_notes (id text) strict" },
    { name: "notes", schema: "create table notes_items (id text) strict" },
    { name: "notes-x", schema: "create table notes_x_items (id text) strict" },
  ]);

  store
    .plugin("git-hosts")
    .run("insert into git_hosts_watches (id) values ('kept')");

  expect(() => store.plugin("git")).toThrow(
    "plugin git can't keep git_ tables: git_hosts_watches belongs to another owner",
  );

  expect(() => store.plugin("session")).toThrow(
    "plugin session can't keep session_ tables: session_access_people belongs to another owner",
  );

  expect(() => store.plugin("notes-x")).toThrow(
    "plugin notes-x can't keep notes_x_ tables: they would start with notes_, the tables of plugin notes",
  );

  expect(store.resetPlugin("git")).toBe(
    "plugin git can't keep git_ tables: git_hosts_watches belongs to another owner",
  );

  expect(
    store.plugin("git-hosts").all("select id from git_hosts_watches"),
  ).toEqual([{ id: "kept" }]);

  store.close();
});

test("a reset drops only the tables the plugin's schema made", () => {
  const path = join(root, "server.db");

  const notes = (sql: string) => ({ name: "notes", schema: sql });

  openStore(path, undefined, undefined, undefined, [
    notes("create table notes_items (id text) strict"),
  ]).close();

  const db = new DatabaseSync(path);

  db.exec(
    "create table notes_by_hand (id text); insert into notes_by_hand values ('kept')",
  );

  db.close();

  const store = openStore(path, undefined, undefined, undefined, [
    notes("create table notes_items (id text, at integer) strict"),
  ]);

  expect(store.resetPlugin("notes")).toBe(
    "plugin notes can't keep notes_ tables: notes_by_hand belongs to another owner",
  );

  store.close();

  const after = new DatabaseSync(path);

  expect(after.prepare("select id from notes_by_hand").all()).toEqual([
    { id: "kept" },
  ]);

  expect(
    after
      .prepare("select name from sqlite_master where name = 'notes_items'")
      .all(),
  ).toEqual([]);

  after.close();
});

test("removes a plugin's rows with the Session, Environment or person they point at", () => {
  const path = join(root, "server.db");

  const trail = {
    name: "trail",
    schema: `
        create table trail_by_session (session_id text not null references sessions (id) on delete cascade) strict;
        create table trail_by_environment (environment_id text not null references environments (id) on delete cascade) strict;
        create table trail_by_user (user_id text not null references users (id) on delete cascade) strict;
      `,
  };

  const store = openStore(path, undefined, undefined, undefined, [trail]);

  for (const id of ["ana", "bo"]) {
    store.people.insertUser({
      id,
      name: id,
      admin: false,
      passwordHash: "",
      createdAt: "2026-11-01T00:00:00.000Z",
    });
  }

  store.environments.ensureEnvironment("vm", "ana");
  store.environments.ensureEnvironment("laptop", "ana");

  const environments = new Map(
    store.environments.environments().map(({ provider, id }) => [provider, id]),
  );

  defaultProfile = store.sessions.defaultProfileId("ana");
  const vm = environments.get("vm") ?? "";
  const laptop = environments.get("laptop") ?? "";

  store.sessions.insert(
    sessionIn(vm, "vm", { id: "s-vm", createdAt: "2026-11-02T00:00:00.000Z" }),
  );

  store.sessions.insert(
    sessionIn(laptop, "laptop", {
      id: "s-laptop",
      createdAt: "2026-11-02T00:00:00.000Z",
    }),
  );

  const rows = store.plugin("trail");

  for (const session of ["s-vm", "s-laptop"]) {
    rows.run("insert into trail_by_session values (?)", session);
  }

  for (const environment of [vm, laptop]) {
    rows.run("insert into trail_by_environment values (?)", environment);
  }

  for (const user of ["ana", "bo"]) {
    rows.run("insert into trail_by_user values (?)", user);
  }

  store.environments.deleteEnvironment(vm);
  store.close();

  const db = new DatabaseSync(path);
  db.exec("pragma foreign_keys = on; delete from users where id = 'bo'");
  db.close();

  const again = openStore(path, undefined, undefined, undefined, [trail]);
  const left = again.plugin("trail");

  expect([
    left.all("select session_id as id from trail_by_session"),
    left.all("select environment_id as id from trail_by_environment"),
    left.all("select user_id as id from trail_by_user"),
  ]).toEqual([[{ id: "s-laptop" }], [{ id: laptop }], [{ id: "ana" }]]);

  expect(again.sessions.get("s-vm")).toBeUndefined();
  again.close();
});

test("keeps who said what in a Session as an actor, once per request", () => {
  const path = join(root, "server.db");
  const store = openStore(path);

  store.people.insertUser({
    id: "ana",
    name: "ana",
    admin: false,
    passwordHash: "",
    createdAt: "2026-11-01T00:00:00.000Z",
  });

  store.environments.ensureEnvironment("vm", "ana");
  const [environment] = store.environments.environments();
  defaultProfile = store.sessions.defaultProfileId("ana");

  store.sessions.insert(
    sessionIn(environment?.id ?? "", "vm", {
      id: "s1",
      createdAt: "2026-11-02T00:00:00.000Z",
    }),
  );

  const said = {
    kind: "team",
    actor: "user:ana",
    at: "2026-11-02T00:00:01.000Z",
    text: "Ship it?",
    requestId: "r1",
  } as const;

  const kept = [
    store.sessions.addVoice("s1", said),
    store.sessions.addVoice("s1", said),
  ];

  store.close();

  const db = new DatabaseSync(path);

  const insert = (actor: string, userId: string | null): void => {
    db.prepare(
      "insert into session_messages (session_id, seq, kind, actor, user_id, at) values ('s1', 9, 'team', ?, ?, 0)",
    ).run(actor, userId);
  };

  expect(kept).toEqual([true, false]);

  expect(() => {
    insert("pi", null);
  }).toThrow("CHECK constraint failed");

  expect(() => {
    insert("user:", null);
  }).toThrow("CHECK constraint failed");

  expect(() => {
    insert("user:bo", "ana");
  }).toThrow("CHECK constraint failed");

  expect(
    db.prepare("select actor, user_id, request_id from session_messages").all(),
  ).toEqual([{ actor: "user:ana", user_id: "ana", request_id: "r1" }]);

  db.close();
});

test("holds the kernel's dedupe keys as it holds a plugin's, until they expire", () => {
  const store = openStore(join(root, "server.db"));

  store.environments.ensureEnvironment("vm", "team");
  const [environment] = store.environments.environments();
  defaultProfile = store.sessions.defaultProfileId("local");

  store.sessions.insert(
    sessionIn(environment?.id ?? "", "vm", {
      id: "s1",
      createdAt: "2026-11-02T00:00:00.000Z",
    }),
  );

  const { outbox } = store.sessions;

  const add = (keysSince: number): boolean =>
    outbox.add(
      {
        kind: "context",
        text: "Checks failed",
        sessionId: "s1",
        plugin: null,
        actor: "plugin:kernel",
        dedupe: "pr-1",
        createdAt: 100,
      },
      keysSince,
    );

  const added = [add(0), add(0)];
  const first = outbox.after("s1", 0)?.seq ?? 0;

  outbox.sent(first, 200);
  outbox.acked("s1", first, 300);

  const taken = [add(300), outbox.after("s1", 0)];

  expect(added).toEqual([true, false]);
  expect(taken).toEqual([false, undefined]);
  expect(add(301)).toBe(true);
  expect(outbox.after("s1", 0)?.seq).toBeGreaterThan(first);

  store.close();
});
