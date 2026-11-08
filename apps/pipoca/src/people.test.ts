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
import { protocolVersion, versionHeader } from "@pipoca/protocol";
import { definePlugin, defineServer } from "@pipoca/plugins";
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

  const response = await fetch(new URL("/api/auth/session", server.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "ana", password: "battery staple" }),
  });

  return response.headers.get("set-cookie")?.split(";")[0] ?? "";
}

async function environment(cookie: string, name: string): Promise<string> {
  const created = await json<Environment>(
    server.as(cookie)("/api/environments", { body: { name } }),
  );

  return created.id;
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
    (await server.as(anas)(`/api/environments/${mac}/keys`, { body: {} }))
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

  const team = (await created.json()) as Environment;

  expect(team.ownerId).toBe("team");
  expect(names(await json(server.as(anas)("/api/environments")))).toEqual([]);

  const listed = await json<Environment[]>(
    server.as(anas)("/api/environments?scope=team"),
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
    server.as(anas)(`/api/environments/${team.id}/keys`, { body: {} }),
    server.as(anas)(`/api/environments/${team.id}`, { method: "DELETE" }),
  ]);

  expect(refused.map(({ status }) => status)).toEqual([403, 404, 404, 404]);

  const changed = await Promise.all([
    server.api(`/api/environments/${team.id}`, {
      method: "PATCH",
      body: { variables: { REGION: "eu" } },
    }),
    server.api(`/api/environments/${team.id}/keys`, { body: {} }),
  ]);

  expect(changed.map(({ status }) => status)).toEqual([200, 201]);
});

test("a personal Session never runs in a team Environment", async () => {
  const team = await json<Environment>(
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
    server.as(anas)("/api/join-keys", { body: {} }),
  );

  await json<Joined>(
    fetch(new URL("/runner/join", server.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [versionHeader]: String(protocolVersion),
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

  expect(
    ids(await json(server.as(anas)("/api/sessions?plugins=true"))),
  ).toEqual([hers.id]);

  const refused = [
    server.as(anas)(`/api/sessions/${his.id}`),
    server.as(anas)(`/api/sessions/${his.id}/events`),
    server.as(anas)(`/api/sessions/${his.id}/commands`, {
      body: { type: "abort" },
    }),
    server.as(anas)("/api/sessions", {
      body: { from: { session: his.id } },
    }),
    server.as(anas)(`/api/sessions/${his.id}`, {
      method: "PATCH",
      body: { archived: true },
    }),
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
    server.api("/api/environments?scope=all"),
  );

  expect(names(everyone).toSorted()).toEqual(["laptop", "mac"]);
  expect(everyone.find(({ id }) => id === laptop)?.variables).toEqual({});

  const sessions = await json<Session[]>(server.api("/api/sessions?scope=all"));

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
    (
      await server.api(`/api/sessions/${hers.id}`, {
        method: "PATCH",
        body: { archived: true },
      })
    ).status,
  ).toBe(200);

  expect((await server.as(anas)("/api/environments?scope=all")).status).toBe(
    403,
  );
});

test("an owner or an admin deletes an Environment once its Sessions are archived", async () => {
  const anas = await ana();

  const { key, ...laptop } = await json<Environment & { key: string }>(
    server.as(anas)("/api/environments", { body: { name: "laptop" } }),
  );

  const { token } = await json<Joined>(
    fetch(new URL("/runner/join", server.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [versionHeader]: String(protocolVersion),
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ name: "mac" }),
    }),
  );

  const hers = await session(anas, laptop.id);
  const path = `/api/environments/${laptop.id}`;

  const whileActive = await server.as(anas)(path, { method: "DELETE" });

  await server.as(anas)(`/api/sessions/${hers.id}`, {
    method: "PATCH",
    body: { archived: true },
  });

  const theirs = await environment(await server.signedIn(), "mac");

  const byOther = await server.as(anas)(`/api/environments/${theirs}`, {
    method: "DELETE",
  });

  const byAdmin = await server.api(path, { method: "DELETE" });

  const work = await fetch(new URL("/runner/work", server.url), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [versionHeader]: String(protocolVersion),
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

test("only an admin lists everyone in full; others see names", async () => {
  const anas = await ana();

  const everyone = await json<{ id: string; name: string; admin: boolean }[]>(
    server.api("/api/people"),
  );

  expect(everyone.map(({ name, admin }) => [name, admin])).toEqual([
    ["pedro", true],
    ["ana", false],
  ]);

  expect(await json(server.as(anas)("/api/people"))).toEqual(
    everyone.map(({ id, name }) => ({ id, name })),
  );
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

  await server.as(pedros)("/api/me/setup", {
    method: "PATCH",
    body: { finished: true },
  });

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
  return fetch(new URL(`/api/auth/invites/${token}`, server.url), {
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
    fetch(new URL(`/api/auth/invites/${token}`, server.url)),
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
  expect((await server.as(beas)("/api/invites")).status).toBe(403);

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

test("lets an email invite in once when it is accepted several times at once", async () => {
  await ana();
  const pedros = await server.signedIn();

  const [dan] = await json<(Invite & { token: string })[]>(
    server.as(pedros)("/api/invites", {
      body: { emails: ["dan@example.com"], admin: true },
    }),
  );

  const joined = await Promise.all(
    ["dan", "dan2", "dan3", "dan4"].map(async (name) =>
      joinWith(dan?.token ?? "", name),
    ),
  );

  const people = await json<Person[]>(server.as(pedros)("/api/people"));

  expect(joined.map(({ status }) => status).sort((a, b) => a - b)).toEqual([
    201, 404, 404, 404,
  ]);

  expect(people.filter(({ name }) => name.startsWith("dan"))).toHaveLength(1);
});

// An admin who invites through a port-forward still mails the public link.
test("links an email invite to the server's configured URL, not the host it came through", async () => {
  const links: string[] = [];

  const forwarded = testServer({
    url: new URL("https://pipoca.example.com"),
    servers: [
      defineServer(
        definePlugin({ id: "mailer", title: "Mailer", description: "" }),
        ({ events }) => {
          events.on("PersonInvited", ({ link }) => {
            links.push(link);
          });
        },
      ),
    ],
  });

  await forwarded.api("/api/invites", {
    body: { emails: ["dan@example.com"] },
    headers: { host: "localhost:7420" },
  });

  await forwarded.close();

  expect(links).toHaveLength(1);
  expect(links[0]).toStartWith("https://pipoca.example.com/#join/");
});

test("a person's assistant is theirs alone", async () => {
  const anas = await ana();
  await environment(await server.signedIn(), "mac");

  const started = await server.api("/api/ext/projects/assistant", {
    body: { text: "what can you do?" },
  });

  expect(started.status).toBe(200);
  expect((await server.api("/api/ext/projects/assistant")).status).toBe(200);

  expect((await server.as(anas)("/api/ext/projects/assistant")).status).toBe(
    404,
  );
});

test("a person renames themselves, and their Sessions start in the Environment they chose", async () => {
  const anas = await ana();
  await environment(anas, "laptop");
  const desk = await environment(anas, "desk");
  const mac = await environment(await server.signedIn(), "mac");

  const named = await server.as(anas)("/api/me", {
    method: "PATCH",
    body: { displayName: " Ana Souza ", defaultEnvironment: desk },
  });

  const someoneElses = await server.as(anas)("/api/me", {
    method: "PATCH",
    body: { defaultEnvironment: mac },
  });

  expect(await named.json()).toMatchObject({
    name: "ana",
    displayName: "Ana Souza",
    defaultEnvironment: desk,
  });

  expect(someoneElses.status).toBe(400);
  expect((await session(anas)).environmentId).toBe(desk);

  const cleared = await json(
    server.as(anas)("/api/me", {
      method: "PATCH",
      body: { displayName: "", defaultEnvironment: null },
    }),
  );

  expect(cleared).toMatchObject({
    displayName: null,
    defaultEnvironment: null,
  });
});

test("signing out everywhere ends every browser session and access token of that person only", async () => {
  const anas = await ana();
  const other = await server.signIn();

  const second = await fetch(new URL("/api/auth/session", server.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "ana", password: "battery staple" }),
  });

  const anasOther = second.headers.get("set-cookie")?.split(";")[0] ?? "";

  const { secret } = await json<{ secret: string }>(
    server.as(anas)("/api/me/access-tokens", { body: { name: "laptop" } }),
  );

  const byToken = async (): Promise<number> =>
    (
      await server.as()("/api/mcp", {
        body: { jsonrpc: "2.0", id: 1, method: "ping" },
        headers: {
          authorization: `Bearer ${secret}`,
          accept: "application/json, text/event-stream",
        },
      })
    ).status;

  expect(await byToken()).toBe(200);

  const out = await server.as(anas)("/api/me/sign-ins", { method: "DELETE" });

  expect(out.status).toBe(204);
  expect(out.headers.get("set-cookie")).toContain("Max-Age=0");

  const after = [
    (await server.as(anas)("/api/me")).status,
    (await server.as(anasOther)("/api/me")).status,
    await byToken(),
    (await server.as(other)("/api/me")).status,
  ];

  expect(after).toEqual([401, 401, 401, 200]);
});

test("only admins change plugins or restart the server", async () => {
  const cookie = await ana();

  const statuses = [
    (
      await server.as(cookie)("/api/plugins", {
        body: { url: "file:///nowhere" },
      })
    ).status,
    (
      await server.as(cookie)("/api/plugins/oidc", {
        method: "PATCH",
        body: { settings: {} },
      })
    ).status,
    (await server.as(cookie)("/api/plugins/oidc", { method: "DELETE" })).status,
    (await server.as(cookie)("/api/server/restart", { body: {} })).status,
  ];

  expect(statuses).toEqual([403, 403, 403, 403]);
});

test("only admins change a template's Kubernetes settings", async () => {
  const cookie = await ana();

  const template = (await (
    await server.api("/api/environment-templates", { body: { name: "pods" } })
  ).json()) as { id: string };

  const path = `/api/ext/kubernetes/templates/${template.id}`;
  const patch = { spec: { volumes: [{ name: "key", secret: {} }] } };

  const statuses = [
    (await server.as(cookie)(path)).status,
    (await server.as(cookie)(path, { body: { settings: { podPatch: patch } } }))
      .status,
    (await server.as(cookie)(path, { body: { settings: null } })).status,
    (await server.api(path, { body: { settings: { podPatch: patch } } }))
      .status,
  ];

  expect(statuses).toEqual([200, 403, 403, 200]);
});

test("only admins change model aliases, and anyone changes a Project's goal", async () => {
  const cookie = await ana();

  const laptop = (await (
    await server.as(cookie)("/api/environments", { body: { name: "laptop" } })
  ).json()) as { id: string };

  const project = (await (
    await server.as(cookie)("/api/ext/projects/projects", {
      body: {
        name: "Release",
        repositories: ["https://example.com/app.git"],
      },
    })
  ).json()) as { id: string };

  const aliases = `/api/ext/models/environments/${laptop.id}`;
  const settings = `/api/ext/projects/projects/${project.id}/settings`;

  const statuses = [
    (await server.as(cookie)(aliases, { body: { aliases: null } })).status,
    (await server.api(aliases, { body: { aliases: null } })).status,
    (await server.as(cookie)(settings, { body: { goal: "Ship it" } })).status,
  ];

  expect(statuses).toEqual([403, 200, 200]);
});

test("a team Project follows who sees and steers its coordinator, and a fresh one keeps that", async () => {
  const anas = await ana();
  const admin = await server.signedIn();
  const me = await json<Person>(server.api("/api/me"));

  const pods = await json<Environment>(
    server.api("/api/environments", { body: { name: "pods", team: true } }),
  );

  const profile = await json<{ id: string }>(
    server.api("/api/profiles", { body: { name: "Team work", team: true } }),
  );

  const project = await json<{ id: string; coordinatorId: string }>(
    server.api("/api/ext/projects/team/projects", {
      body: {
        name: "Release",
        repositories: ["https://example.com/app.git"],
        environment: pods.id,
        profile: profile.id,
      },
    }),
  );

  const limit = async (id: string, access: unknown): Promise<void> => {
    await server.as(admin)(`/api/sessions/${id}`, {
      method: "PATCH",
      body: { access },
    });
  };

  const at = `/api/ext/projects/projects/${project.id}`;

  const tries = async (): Promise<number[]> =>
    Promise.all(
      [
        server.as(anas)(at),
        server.as(anas)(`${at}/settings`, { body: { goal: "Leak" } }),
        server.as(anas)(`${at}/files`, {
          body: { path: "notes.md", hash: "0".repeat(64) },
        }),
        server.as(anas)(`${at}/fresh`, { method: "POST" }),
      ].map(async (response) => (await response).status),
    );

  await limit(project.coordinatorId, { kind: "named", people: [] });

  expect(await tries()).toEqual([404, 404, 404, 404]);

  expect(
    await json<unknown[]>(server.as(anas)("/api/ext/projects/team/projects")),
  ).toEqual([]);

  await limit(project.coordinatorId, { kind: "view" });

  expect(await tries()).toEqual([200, 403, 403, 403]);

  const fresh = await json<{ coordinatorId: string }>(
    server.as(admin)(`${at}/fresh`, { method: "POST" }),
  );

  expect(
    await json<Session>(
      server.as(anas)(`/api/sessions/${fresh.coordinatorId}`),
    ),
  ).toMatchObject({ access: { kind: "view" }, startedBy: me.id });

  await limit(fresh.coordinatorId, { kind: "team" });

  const anasFresh = await json<{ coordinatorId: string }>(
    server.as(anas)(`${at}/fresh`, { method: "POST" }),
  );

  const anaId = (await json<Person>(server.as(anas)("/api/me"))).id;

  expect(
    await json<Session>(
      server.as(anas)(`/api/sessions/${anasFresh.coordinatorId}`),
    ),
  ).toMatchObject({ access: { kind: "team" }, startedBy: anaId });
});
