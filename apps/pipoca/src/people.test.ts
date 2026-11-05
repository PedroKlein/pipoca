import { afterEach, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  Environment,
  Invite,
  JoinInfo,
  Joined,
  Person,
  Session,
} from "@pipoca/protocol";
import { json, testServer, type TestServer } from "./testdata/harness";

let root: string;
let server: TestServer;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "people-"));

  server = testServer({
    database: join(root, "server.db"),
    configDir: join(root, "config"),
    runners: { pollWaitMs: 0 },
  });
});

afterEach(async () => {
  await server.close();
  await rm(root, { recursive: true, force: true });
});

// Signs in a second user, who isn't an admin, and returns their cookie.
async function ana(): Promise<string> {
  await server.signedIn();

  const db = new DatabaseSync(join(root, "server.db"));

  db.prepare(
    "insert into users (id, name, password_hash, created_at, admin) values (?, 'ana', ?, ?, 0)",
  ).run(randomUUID(), await Bun.password.hash("battery staple"), Date.now());

  db.close();

  const response = await fetch(new URL("/api/auth/login", server.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "ana", password: "battery staple" }),
  });

  return response.headers.get("set-cookie")?.split(";")[0] ?? "";
}

async function environment(cookie: string, name: string): Promise<string> {
  const created = await json<{ environment: Environment }>(
    server.as(cookie)("/api/environments", { body: { name } }),
  );

  return created.environment.id;
}

async function session(
  cookie: string,
  environmentId?: string,
): Promise<Session> {
  return json(
    server.as(cookie)("/api/sessions", {
      body: {
        ...(environmentId !== undefined && { environment: environmentId }),
        workspace: { kind: "folder", path: root },
        firstMessage: "hello",
      },
    }),
  );
}

const names = (environments: readonly Environment[]): string[] =>
  environments.map(({ name }) => name);

test("a person sees, changes and starts Sessions only in their own Environments", async () => {
  const anas = await ana();
  const mac = await environment(await server.signedIn(), "mac");
  const laptop = await environment(anas, "laptop");

  expect(names(await json(server.api("/api/environments")))).toEqual(["mac"]);

  expect(names(await json(server.as(anas)("/api/environments")))).toEqual([
    "laptop",
  ]);

  expect(
    (
      await server.as(anas)(`/api/environments/${mac}`, {
        method: "PATCH",
        body: { name: "x" },
      })
    ).status,
  ).toBe(404);

  expect(
    (await server.as(anas)(`/api/environments/${mac}/key`, { body: {} }))
      .status,
  ).toBe(404);

  expect(
    (
      await server.as(anas)("/api/sessions", {
        body: {
          environment: mac,
          workspace: { kind: "folder", path: root },
        },
      })
    ).status,
  ).toBe(400);

  expect((await session(anas)).environmentId).toBe(laptop);
});

test("only admins make and change team Environments, which users list apart", async () => {
  const anas = await ana();

  const created = await server.api("/api/environments", {
    body: {
      name: "team-pods",
      team: true,
    },
  });

  expect(created.status).toBe(201);

  const { environment: team } = (await created.json()) as {
    environment: Environment;
  };

  expect(team.ownerId).toBe("team");
  expect(names(await json(server.as(anas)("/api/environments")))).toEqual([]);

  const listed = await json<Environment[]>(
    server.as(anas)("/api/environments?owner=team"),
  );

  expect(names(listed)).toEqual(["team-pods"]);
  expect(listed[0]?.variables).toEqual({});

  const refused = await Promise.all([
    server.as(anas)("/api/environments", {
      body: { name: "mine-for-all", team: true },
    }),
    server.as(anas)(`/api/environments/${team.id}`, {
      method: "PATCH",
      body: { name: "x" },
    }),
    server.as(anas)(`/api/environments/${team.id}/key`, { body: {} }),
    server.as(anas)(`/api/environments/${team.id}`, { method: "DELETE" }),
  ]);

  expect(refused.map(({ status }) => status)).toEqual([403, 404, 404, 404]);

  const changed = await Promise.all([
    server.api(`/api/environments/${team.id}`, {
      method: "PATCH",
      body: { variables: { REGION: "eu" } },
    }),
    server.api(`/api/environments/${team.id}/key`, { body: {} }),
  ]);

  expect(changed.map(({ status }) => status)).toEqual([200, 200]);
});

test("a personal Session never runs in a team Environment", async () => {
  const { environment: team } = await json<{ environment: Environment }>(
    server.api("/api/environments", {
      body: { name: "team-pods", team: true },
    }),
  );

  const response = await server.api("/api/sessions", {
    body: {
      environment: team.id,
      workspace: { kind: "folder", path: root },
    },
  });

  expect(response.status).toBe(400);
});

test("an Environment a runner makes with a join key is the key maker's", async () => {
  const anas = await ana();

  const { key } = await json<{ key: string }>(
    server.as(anas)("/api/join-key", { body: {} }),
  );

  await json<Joined>(
    fetch(new URL("/agent/join", server.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "pipoca-protocol": "4",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ name: "vm" }),
    }),
  );

  expect(names(await json(server.as(anas)("/api/environments")))).toEqual([
    "vm",
  ]);

  expect(await json(server.api("/api/environments"))).toEqual([]);
});

test("a person sees and drives only their own Sessions", async () => {
  const anas = await ana();
  await environment(await server.signedIn(), "mac");
  await environment(anas, "laptop");

  const his = await session(await server.signedIn());
  const hers = await session(anas);

  const ids = (sessions: readonly Session[]): string[] =>
    sessions.map(({ id }) => id);

  expect(ids(await json(server.as(anas)("/api/sessions")))).toEqual([hers.id]);

  expect(ids(await json(server.as(anas)("/api/sessions?owner=all")))).toEqual([
    hers.id,
  ]);

  const refused = [
    server.as(anas)(`/api/sessions/${his.id}`),
    server.as(anas)(`/api/sessions/${his.id}/events`),
    server.as(anas)(`/api/sessions/${his.id}/commands`, {
      body: { type: "abort" },
    }),
    server.as(anas)(`/api/sessions/${his.id}/fork`, { body: {} }),
    server.as(anas)(`/api/sessions/${his.id}/archive`, { body: {} }),
    server.as(anas)(`/api/sessions/${his.id}/terminal`),
  ];

  for (const response of await Promise.all(refused)) {
    expect(response.status).toBe(404);
  }
});

test("an admin sees everyone's Environments and Sessions as an outline and can stop them", async () => {
  const anas = await ana();
  await environment(await server.signedIn(), "mac");
  const laptop = await environment(anas, "laptop");

  await server.as(anas)(`/api/environments/${laptop}`, {
    method: "PATCH",
    body: { variables: { TEAM: "blue" } },
  });

  const hers = await session(anas);

  const everyone = await json<Environment[]>(
    server.api("/api/environments?people=all"),
  );

  expect(names(everyone).toSorted()).toEqual(["laptop", "mac"]);
  expect(everyone.find(({ id }) => id === laptop)?.variables).toEqual({});

  const sessions = await json<Session[]>(
    server.api("/api/sessions?people=all"),
  );

  expect(sessions.map(({ id }) => id)).toContain(hers.id);

  const outline = await json<Session>(server.api(`/api/sessions/${hers.id}`));

  expect(outline.id).toBe(hers.id);
  expect(outline.firstMessage).toBeNull();

  expect((await server.api(`/api/sessions/${hers.id}/events`)).status).toBe(
    404,
  );

  expect(
    (
      await server.api(`/api/sessions/${hers.id}/commands`, {
        body: {
          type: "message",
          text: "hi",
        },
      })
    ).status,
  ).toBe(404);

  // Reaches the Session, which isn't running yet.
  expect(
    (
      await server.api(`/api/sessions/${hers.id}/commands`, {
        body: {
          type: "abort",
        },
      })
    ).status,
  ).toBe(409);

  expect(
    (await server.api(`/api/sessions/${hers.id}/archive`, { body: {} })).status,
  ).toBe(200);

  expect(
    names(await json(server.as(anas)("/api/environments?people=all"))),
  ).toEqual(["laptop"]);
});

test("an owner or an admin deletes an Environment once its Sessions are archived", async () => {
  const anas = await ana();

  const { environment: laptop, key } = await json<{
    environment: Environment;
    key: string;
  }>(server.as(anas)("/api/environments", { body: { name: "laptop" } }));

  const { token } = await json<Joined>(
    fetch(new URL("/agent/join", server.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "pipoca-protocol": "4",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ name: "mac" }),
    }),
  );

  const hers = await session(anas, laptop.id);
  const path = `/api/environments/${laptop.id}`;

  const whileActive = await server.as(anas)(path, { method: "DELETE" });
  await server.as(anas)(`/api/sessions/${hers.id}/archive`, { body: {} });

  const theirs = await environment(await server.signedIn(), "mac");

  const byOther = await server.as(anas)(`/api/environments/${theirs}`, {
    method: "DELETE",
  });

  const byAdmin = await server.api(path, { method: "DELETE" });

  const work = await fetch(new URL("/agent/work", server.url), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "pipoca-protocol": "4",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ running: [], folders: [root], models: [] }),
  });

  expect([whileActive.status, byOther.status, byAdmin.status]).toEqual([
    409, 404, 204,
  ]);

  expect(await json(server.as(anas)("/api/environments"))).toEqual([]);
  expect((await server.as(anas)(`/api/sessions/${hers.id}`)).status).toBe(404);
  expect(work.status).toBe(401);
});

test("only an admin lists everyone", async () => {
  const anas = await ana();

  const everyone = await json<{ name: string; admin: boolean }[]>(
    server.api("/api/people"),
  );

  expect(everyone.map(({ name, admin }) => [name, admin])).toEqual([
    ["pedro", true],
    ["ana", false],
  ]);

  expect((await server.as(anas)("/api/people")).status).toBe(403);
});

test("an admin changes roles, but never leaves the server without an admin", async () => {
  const anas = await ana();
  const pedros = await server.signedIn();

  const people = await json<Person[]>(server.as(pedros)("/api/people"));

  const idOf = (name: string): string =>
    people.find((person) => person.name === name)?.id ?? "";

  const byMember = await server.as(anas)(`/api/people/${idOf("pedro")}`, {
    method: "PATCH",
    body: { admin: false },
  });

  const promoted = await server.as(pedros)(`/api/people/${idOf("ana")}`, {
    method: "PATCH",
    body: { admin: true },
  });

  const listedByAna = await server.as(anas)("/api/people");

  const demoted = await server.as(anas)(`/api/people/${idOf("pedro")}`, {
    method: "PATCH",
    body: { admin: false },
  });

  const lastAdmin = await server.as(anas)(`/api/people/${idOf("ana")}`, {
    method: "PATCH",
    body: { admin: false },
  });

  expect([
    byMember.status,
    promoted.status,
    listedByAna.status,
    demoted.status,
    lastAdmin.status,
  ]).toEqual([403, 200, 200, 200, 409]);

  expect(
    (await json<Person[]>(server.as(anas)("/api/people"))).map(
      ({ name, admin }) => [name, admin],
    ),
  ).toEqual([
    ["pedro", false],
    ["ana", true],
  ]);
});

test("lists who is still setting up and when each person was last active", async () => {
  const before = new Date().toISOString();
  const anas = await ana();
  const pedros = await server.signedIn();

  await server.as(anas)("/api/environments");

  await server.as(pedros)("/api/setup", { body: { finished: true } });

  const people = await json<Person[]>(server.as(pedros)("/api/people"));

  expect(people.map(({ name, settingUp }) => [name, settingUp])).toEqual([
    ["pedro", false],
    ["ana", true],
  ]);

  expect(people.every(({ lastActive }) => (lastActive ?? "") >= before)).toBe(
    true,
  );
});

async function joinWith(token: string, name: string): Promise<Response> {
  return fetch(new URL(`/api/auth/join/${token}`, server.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, password: "correct horse" }),
  });
}

test("lets anyone with an invite link join with a password, as the role it names", async () => {
  const anas = await ana();
  const pedros = await server.signedIn();

  const byMember = await server.as(anas)("/api/invites", { body: {} });

  const [link] = await json<(Invite & { token: string })[]>(
    server.as(pedros)("/api/invites", { body: { admin: false, days: 3 } }),
  );

  const token = link?.token ?? "";

  const info = await json<JoinInfo>(
    fetch(new URL(`/api/auth/join/${token}`, server.url)),
  );

  const bea = await joinWith(token, "bea");
  const cid = await joinWith(token, "cid");
  const taken = await joinWith(token, "cid");
  const beas = bea.headers.get("set-cookie")?.split(";")[0] ?? "";

  expect(byMember.status).toBe(403);

  expect(info).toMatchObject({
    email: null,
    admin: false,
    passwordLogin: true,
  });

  expect([bea.status, cid.status, taken.status]).toEqual([201, 201, 409]);
  expect((await server.as(beas)("/api/people")).status).toBe(403);

  expect(await json(server.as(pedros)("/api/invites"))).toEqual([
    { ...link, token: undefined, uses: 2 },
  ]);
});

test("lets an email invite in once, and not after an admin revokes it", async () => {
  await ana();
  const pedros = await server.signedIn();

  const badEmail = await server.as(pedros)("/api/invites", {
    body: { emails: ["nobody"] },
  });

  const [dan, eve] = await json<(Invite & { token: string })[]>(
    server.as(pedros)("/api/invites", {
      body: {
        emails: ["Dan@Example.com ", "eve@example.com"],
        admin: true,
      },
    }),
  );

  const revoked = await server.as(pedros)(`/api/invites/${eve?.id ?? ""}`, {
    method: "DELETE",
  });

  const joined = await joinWith(dan?.token ?? "", "dan");
  const twice = await joinWith(dan?.token ?? "", "dan2");
  const afterRevoke = await joinWith(eve?.token ?? "", "eve");

  expect(badEmail.status).toBe(422);
  expect(dan?.email).toBe("dan@example.com");
  expect(revoked.status).toBe(204);

  expect([joined.status, twice.status, afterRevoke.status]).toEqual([
    201, 404, 404,
  ]);

  expect(await joined.json()).toMatchObject({ name: "dan", admin: true });
  expect(await json(server.as(pedros)("/api/invites"))).toEqual([]);
});

test("a person lists only the meta-sessions they started", async () => {
  const anas = await ana();
  await environment(await server.signedIn(), "mac");

  const started = await server.api("/api/plugins/meta/sessions", {
    body: {
      text: "what can you do?",
    },
  });

  expect(started.status).toBe(201);

  expect(
    await json<Session[]>(server.api("/api/plugins/meta/sessions")),
  ).toHaveLength(1);

  expect(await json(server.as(anas)("/api/plugins/meta/sessions"))).toEqual([]);
});
