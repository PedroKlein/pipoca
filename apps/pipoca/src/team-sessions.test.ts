import { afterEach, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  Assignment,
  Command,
  Environment,
  Joined,
  Profile,
  ProfileFiles,
  Presence,
  Session,
  SessionEvent,
  Voice,
} from "@pipoca/protocol";
import { gitHosts } from "@pipoca/git-hosts/server";
import type { ServerPluginContext } from "@pipoca/plugins";
import { serve } from "./serve";
import { builtInPlugins } from "./session-parts";
import { readSse } from "./sse";
import { firstUser } from "./testdata/sign-in";

let root: string;
let server: ReturnType<typeof serve>;
let pedro: () => Promise<string>;
let starter: ServerPluginContext["sessions"] | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "team-sessions-"));

  const logs: string[] = [];

  server = serve({
    port: 0,
    database: join(root, "server.db"),
    configDir: join(root, "config"),
    sessions: { pollWaitMs: 0 },
    plugins: [
      {
        name: "starter",
        register: ({ sessions }) => {
          starter = sessions;
        },
      },
      gitHosts,
    ],
    manifests: [
      {
        id: "starter",
        title: "Starter",
        description: "",
        capabilities: ["sessions"],
      },
      ...builtInPlugins.filter(({ id }) => id === "git-hosts"),
    ],
    log: (message, fields) => {
      logs.push(`${message} ${JSON.stringify(fields)}`);
    },
  });

  pedro = firstUser(server, logs);
});

afterEach(async () => {
  await server.stop();
  await rm(root, { recursive: true, force: true });
});

async function api(
  path: string,
  cookie: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
): Promise<Response> {
  return fetch(new URL(path, server.url), {
    method,
    headers: {
      cookie,
      ...(body !== undefined && { "content-type": "application/json" }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}

async function json<T>(response: Promise<Response>): Promise<T> {
  return (await (await response).json()) as T;
}

// Signs in a user who isn't an admin and returns their cookie.
async function member(name: string, id = randomUUID()): Promise<string> {
  await pedro();

  const db = new DatabaseSync(join(root, "server.db"));

  db.prepare(
    "insert into users (id, name, password_hash, created_at, admin) values (?, ?, ?, ?, 0)",
  ).run(
    id,
    name,
    await Bun.password.hash("battery staple"),
    new Date().toISOString(),
  );

  db.close();

  const response = await fetch(new URL("/api/auth/login", server.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, password: "battery staple" }),
  });

  return response.headers.get("set-cookie")?.split(";")[0] ?? "";
}

async function ana(): Promise<string> {
  return member("ana");
}

// The team's Environment and Profile, which an admin makes, and the token
// of a runner in that Environment.
async function teamSetup(): Promise<{
  readonly environment: string;
  readonly profile: string;
  readonly runner: string;
}> {
  const { environment, key } = await json<{
    environment: Environment;
    key: string;
  }>(api("/api/environments", await pedro(), { name: "pods", team: true }));

  const profile = await json<Profile>(
    api("/api/profiles", await pedro(), {
      name: "Team work",
      team: true,
      agentsMd: "Ship.",
    }),
  );

  const joined = await json<Joined>(
    fetch(new URL("/agent/join", server.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "pipoca-protocol": "4",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ name: "pod-1" }),
    }),
  );

  return {
    environment: environment.id,
    profile: profile.id,
    runner: joined.token,
  };
}

async function poll(token: string): Promise<readonly Assignment[]> {
  const { start } = await json<{ start: readonly Assignment[] }>(
    fetch(new URL("/agent/work", server.url), {
      method: "POST",
      headers: {
        "pipoca-protocol": "4",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ running: [], folders: [], models: [] }),
    }),
  );

  return start;
}

const workspace = (): { kind: "folder"; path: string } => ({
  kind: "folder",
  path: root,
});

test("a team Session starts only in a team Environment, on a team Profile", async () => {
  const anas = await ana();
  const team = await teamSetup();

  const { environment: laptop } = await json<{ environment: Environment }>(
    api("/api/environments", anas, { name: "laptop" }),
  );

  const started = await api("/api/sessions", anas, {
    team: true,
    environment: team.environment,
    profile: team.profile,
    workspace: workspace(),
  });

  expect(started.status).toBe(201);

  const session = (await started.json()) as Session;

  expect(session.ownedBy).toBe("team");
  expect(session.startedBy).not.toBeNull();

  const refused = await Promise.all([
    api("/api/sessions", anas, {
      team: true,
      environment: laptop.id,
      profile: team.profile,
      workspace: workspace(),
    }),
    api("/api/sessions", anas, {
      team: true,
      environment: team.environment,
      workspace: workspace(),
    }),
  ]);

  expect(refused.map(({ status }) => status)).toEqual([400, 400]);
});

test("every user can open and list team work, and it stays out of their own list", async () => {
  const anas = await ana();
  const team = await teamSetup();

  const session = await json<Session>(
    api("/api/sessions", anas, {
      team: true,
      environment: team.environment,
      profile: team.profile,
      workspace: workspace(),
      firstMessage: "hello",
    }),
  );

  const opened = await json<Session>(
    api(`/api/sessions/${session.id}`, await pedro()),
  );

  expect(opened.firstMessage).toBe("hello");

  const own = await json<Session[]>(api("/api/sessions", anas));

  const teams = await Promise.all(
    [anas, await pedro()].map(async (cookie) =>
      json<Session[]>(api("/api/sessions?owner=team", cookie)),
    ),
  );

  expect(own.map(({ id }) => id)).not.toContain(session.id);

  expect(teams.map((listed) => listed.map(({ id }) => id))).toEqual([
    [session.id],
    [session.id],
  ]);
});

test("a team Session's runner gets the team Profile on the base, never anyone's My defaults", async () => {
  const cookie = await pedro();

  for (const [layer, text] of [
    ["base", "Team."],
    ["defaults", "Mine."],
  ] as const) {
    await fetch(new URL(`/api/${layer}/files/AGENTS.md`, server.url), {
      method: "PUT",
      headers: { cookie },
      body: text,
    });
  }

  const team = await teamSetup();

  const session = await json<Session>(
    api("/api/sessions", cookie, {
      team: true,
      environment: team.environment,
      profile: team.profile,
      workspace: workspace(),
    }),
  );

  const assigned = await poll(team.runner);

  expect(assigned.map(({ sessionId }) => sessionId)).toEqual([session.id]);
  expect(assigned[0]?.gitLogins).toBeUndefined();

  const files = await json<ProfileFiles>(
    fetch(new URL(`/agent/sessions/${session.id}/profile`, server.url), {
      headers: {
        "pipoca-protocol": "4",
        authorization: `Bearer ${team.runner}`,
      },
    }),
  );

  expect(
    Buffer.from(files.files["AGENTS.md"] ?? "", "base64").toString("utf8"),
  ).toBe("Team.\n\nShip.");
});

test("a Session a team Session starts is the team's too", async () => {
  const team = await teamSetup();

  const parent = await json<Session>(
    api("/api/sessions", await pedro(), {
      team: true,
      environment: team.environment,
      profile: team.profile,
      workspace: workspace(),
    }),
  );

  await api("/api/environments", await pedro(), { name: "mac" });

  const child = starter?.start({
    actor: `session:${parent.id}`,
    profile: team.profile,
    workspace: workspace(),
  });

  expect(child?.ownedBy).toBe("team");
  expect(child?.environmentId).toBe(team.environment);
});

async function toolsOf(token: string): Promise<readonly string[]> {
  const [assigned] = await poll(token);

  const tools = await json<readonly { name: string }[]>(
    fetch(
      new URL(
        `/agent/sessions/${assigned?.sessionId ?? ""}/tools?generation=${String(assigned?.generation ?? 0)}`,
        server.url,
      ),
      {
        headers: {
          "pipoca-protocol": "4",
          authorization: `Bearer ${token}`,
        },
      },
    ),
  );

  return tools.map(({ name }) => name);
}

test("a team Session gets no tools that use a person's git accounts", async () => {
  const team = await teamSetup();

  const { key } = await json<{ key: string }>(
    api("/api/environments", await pedro(), { name: "mac" }),
  );

  const mac = await json<Joined>(
    fetch(new URL("/agent/join", server.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "pipoca-protocol": "4",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ name: "mac-1" }),
    }),
  );

  await api("/api/sessions", await pedro(), { workspace: workspace() });

  await api("/api/sessions", await pedro(), {
    team: true,
    environment: team.environment,
    profile: team.profile,
    workspace: workspace(),
  });

  const gitTools = (tools: readonly string[]) =>
    tools.filter((name) => name.startsWith("git_hosts_"));

  expect(gitTools(await toolsOf(mac.token))).toEqual([
    "git_hosts_repositories",
    "git_hosts_watch",
    "git_hosts_unwatch",
  ]);

  expect(gitTools(await toolsOf(team.runner))).toEqual([]);
});

test("only an admin lays out the team hub, and everyone reads the layout", async () => {
  const anas = await ana();

  const layout = {
    pages: [
      { id: "home", title: "Home", panels: ["usage/spend"] },
      { id: "ops", title: "Ops", panels: [] },
    ],
  };

  const before = await json<unknown>(api("/api/hub", anas));
  const refused = await api("/api/hub", anas, layout, "PUT");
  const laid = await api("/api/hub", await pedro(), layout, "PUT");

  const invalid = await api(
    "/api/hub",
    await pedro(),
    { pages: [{ id: "ops", title: "Ops", panels: [] }] },
    "PUT",
  );

  expect(before).toEqual({ pages: null });

  expect([refused.status, laid.status, invalid.status]).toEqual([
    403, 200, 400,
  ]);

  expect(await json<unknown>(api("/api/hub", anas))).toEqual(layout);
});

test("whoever started team work makes it view-only or limits it to named people", async () => {
  const anas = await ana();
  const bo = randomUUID();
  const bos = await member("bo", bo);
  const cys = await member("cy");
  const team = await teamSetup();

  const session = await json<Session>(
    api("/api/sessions", anas, {
      team: true,
      environment: team.environment,
      profile: team.profile,
      workspace: workspace(),
    }),
  );

  expect(session.access).toEqual({ kind: "team" });

  const teammates = await json<{ id: string; name: string }[]>(
    api("/api/teammates", bos),
  );

  expect(teammates.map(({ name }) => name).toSorted()).toEqual(
    ["ana", "bo", "cy", "pedro"].toSorted(),
  );

  const steer = async (cookie: string): Promise<number> =>
    (
      await api(`/api/sessions/${session.id}/commands`, cookie, {
        type: "abort",
      })
    ).status;

  const limit = async (cookie: string, access: unknown): Promise<Response> =>
    api(`/api/sessions/${session.id}/access`, cookie, access, "PUT");

  const listed = async (cookie: string): Promise<readonly string[]> =>
    (await json<Session[]>(api("/api/sessions?owner=team", cookie))).map(
      ({ id }) => id,
    );

  expect(await steer(bos)).not.toBe(404);
  expect((await limit(bos, { kind: "view" })).status).toBe(403);

  const viewOnly = await limit(anas, { kind: "view" });

  expect(viewOnly.status).toBe(200);
  expect(((await viewOnly.json()) as Session).access).toEqual({ kind: "view" });
  expect(await steer(bos)).toBe(403);
  expect(await steer(anas)).not.toBe(403);
  expect((await api(`/api/sessions/${session.id}`, bos)).status).toBe(200);
  expect(await listed(bos)).toEqual([session.id]);

  expect(
    (await limit(anas, { kind: "named", people: ["nobody"] })).status,
  ).toBe(400);

  expect((await limit(anas, { kind: "named", people: [bo] })).status).toBe(200);

  expect(await steer(bos)).not.toBe(403);
  expect(await steer(cys)).toBe(404);
  expect((await api(`/api/sessions/${session.id}`, cys)).status).toBe(404);
  expect(await listed(cys)).toEqual([]);
  expect(await listed(await pedro())).toEqual([session.id]);

  expect((await limit(await pedro(), { kind: "team" })).status).toBe(200);
  expect(await listed(cys)).toEqual([session.id]);
});

test("a team Session keeps who sent each message, for everyone who opens it", async () => {
  const anas = await ana();
  const bo = randomUUID();
  const bos = await member("bo", bo);
  const team = await teamSetup();

  const session = await json<Session>(
    api("/api/sessions", anas, {
      team: true,
      environment: team.environment,
      profile: team.profile,
      workspace: workspace(),
    }),
  );

  await poll(team.runner);

  const sent = await api(`/api/sessions/${session.id}/commands`, bos, {
    type: "message",
    text: "Ship it",
  });

  expect(sent.status).toBe(202);

  const events = await api(`/api/sessions/${session.id}/events`, anas);
  const voices: Voice[] = [];

  for await (const event of readSse(events)) {
    const replayed = event as SessionEvent;

    if (replayed.type === "voice") {
      voices.push(replayed.voice);
      break;
    }
  }

  expect(voices.map(({ kind, person, text }) => [kind, person, text])).toEqual([
    ["message", bo, "Ship it"],
  ]);
});

test("everyone following team work sees who else is looking and who is typing", async () => {
  const an = randomUUID();
  const anas = await member("ana", an);
  const bo = randomUUID();
  const bos = await member("bo", bo);
  const team = await teamSetup();

  const session = await json<Session>(
    api("/api/sessions", anas, {
      team: true,
      environment: team.environment,
      profile: team.profile,
      workspace: workspace(),
    }),
  );

  const path = `/api/sessions/${session.id}/presence`;
  const seen = readSse(await api(path, anas));

  const next = async (): Promise<readonly Presence[]> =>
    (await seen.next()).value as readonly Presence[];

  expect(await next()).toEqual([{ person: an, typing: false }]);

  const boLooks = new AbortController();

  await fetch(new URL(path, server.url), {
    headers: { cookie: bos },
    signal: boLooks.signal,
  });

  expect(await next()).toEqual([
    { person: an, typing: false },
    { person: bo, typing: false },
  ]);

  expect((await api(path, bos, {})).status).toBe(204);

  expect(await next()).toEqual([
    { person: an, typing: false },
    { person: bo, typing: true },
  ]);

  boLooks.abort();

  expect(await next()).toEqual([{ person: an, typing: false }]);
  await seen.return(undefined);
});

test("Pi reads what the team said since its last turn, with names and replies, but nothing off the record", async () => {
  const anas = await ana();
  const bo = randomUUID();
  const bos = await member("bo", bo);
  const team = await teamSetup();

  const session = await json<Session>(
    api("/api/sessions", anas, {
      team: true,
      environment: team.environment,
      profile: team.profile,
      workspace: workspace(),
    }),
  );

  const say = async (cookie: string, body: unknown): Promise<number> =>
    (await api(`/api/sessions/${session.id}/say`, cookie, body)).status;

  expect(await say(bos, { to: "team", text: "Ship it today?" })).toBe(201);

  expect(await say(anas, { to: "aside", text: "Bo is rushing again" })).toBe(
    201,
  );

  expect(await say(bos, { to: "pi", text: "hi" })).toBe(400);

  const [assigned] = await poll(team.runner);

  const sent = await api(`/api/sessions/${session.id}/commands`, anas, {
    type: "message",
    text: "Check the release first",
    quote: { from: bo, text: "Ship it today?" },
  });

  expect(sent.status).toBe(202);

  const commands = readSse(
    await fetch(
      new URL(
        `/agent/sessions/${session.id}/commands?generation=${String(assigned?.generation)}`,
        server.url,
      ),
      {
        headers: {
          "pipoca-protocol": "4",
          authorization: `Bearer ${team.runner}`,
        },
      },
    ),
  );

  const received: Command[] = [];

  for await (const command of commands) {
    received.push(command as Command);

    if (received.length === 2) {
      break;
    }
  }

  expect(received.map(({ type }) => type)).toEqual(["context", "message"]);

  expect(received[0]).toMatchObject({
    hidden: true,
    text: [
      "The team talked since your last turn:",
      "bo: Ship it today?",
      "",
      'ana, replying to bo ("Ship it today?") sends the next message.',
    ].join("\n"),
  });

  const events = await api(`/api/sessions/${session.id}/events`, bos);
  const kinds: string[] = [];

  for await (const event of readSse(events)) {
    const replayed = event as SessionEvent;

    if (replayed.type === "voice") {
      kinds.push(replayed.voice.kind);
    }

    if (kinds.length === 3) {
      break;
    }
  }

  expect(kinds).toEqual(["team", "aside", "message"]);
});

test("Pi hears who answered its question in team work", async () => {
  const anas = await ana();
  const bos = await member("bo");
  const team = await teamSetup();

  const session = await json<Session>(
    api("/api/sessions", anas, {
      team: true,
      environment: team.environment,
      profile: team.profile,
      workspace: workspace(),
    }),
  );

  const [assigned] = await poll(team.runner);

  const commands = readSse(
    await fetch(
      new URL(
        `/agent/sessions/${session.id}/commands?generation=${String(assigned?.generation)}`,
        server.url,
      ),
      {
        headers: {
          "pipoca-protocol": "4",
          authorization: `Bearer ${team.runner}`,
        },
      },
    ),
  );

  const sent = await api(`/api/sessions/${session.id}/commands`, bos, {
    type: "answer",
    id: "prompt-1",
    value: { answers: [], note: null },
  });

  expect(sent.status).toBe(202);

  for await (const command of commands) {
    expect(command).toMatchObject({
      type: "answer",
      value: { answers: [], note: null, by: "bo" },
    });

    break;
  }
});
