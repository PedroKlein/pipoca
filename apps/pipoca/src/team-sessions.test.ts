import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
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
  PluginInfo,
  Profile,
  ProfileFiles,
  Presence,
  Session,
  SessionEvent,
  Voice,
} from "@pipoca/protocol";
import { askServer } from "@pipoca/ask/server";
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
let toolsets: ServerPluginContext["toolsets"] | undefined;

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
        register: (context) => {
          starter = context.sessions;
          toolsets = context.toolsets;

          const blank = {
            packages: [],
            agentsMd: "",
            systemMd: "",
            appendSystemMd: "",
            mcpServers: {},
            settings: {},
          };

          context.profiles.provide(
            "helper",
            { ...blank, name: "Helper" },
            { team: true },
          );

          context.profiles.provide("own", { ...blank, name: "Own" });
          context.toolsets.loadInOwnSessions();

          context.auth.gitLogins((userId, { actsAs }) =>
            actsAs === null
              ? []
              : [{ host: "git.example.com", token: `${actsAs} for ${userId}` }],
          );
        },
      },
      gitHosts,
      askServer,
      {
        name: "notes",
        register: (context) => {
          context.tools.register({
            name: "jot",
            description: "Jots a note down",
            parameters: { type: "object", properties: {} },
            appliesTo: () => true,
            run: async () =>
              Promise.resolve({ text: "jotted", isError: false }),
          });
        },
      },
    ],
    manifests: [
      {
        id: "starter",
        title: "Starter",
        description: "",
        capabilities: ["sessions", "profiles", "toolsets"],
        works: ["personal", "team"],
      },
      {
        id: "notes",
        title: "Notes",
        description: "",
        capabilities: ["tools"],
      },
      ...builtInPlugins.filter(({ id }) => id === "git-hosts" || id === "ask"),
    ],
    log: (message, fields) => {
      logs.push(`${message} ${JSON.stringify(fields)}`);
    },
  });

  pedro = firstUser(server, logs);
});

afterEach(async () => {
  setSystemTime();
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

test("the team votes, and Pi reads the result the next time it's asked", async () => {
  const anas = await ana();
  const bos = await member("bo");
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

  const votes = `/api/plugins/ask/sessions/${session.id}/votes`;

  const opened = await api(votes, bos, {
    question: "Ship it today?",
    options: ["Ship", "Wait"],
  });

  expect(opened.status).toBe(201);

  const { id } = (await opened.json()) as { id: string };

  const pick = async (cookie: string, option: string): Promise<number> =>
    (await api(`/api/plugins/ask/votes/${id}/pick`, cookie, { option }, "PUT"))
      .status;

  expect(await pick(anas, "Ship")).toBe(200);
  expect(await pick(bos, "Wait")).toBe(200);
  expect(await pick(bos, "Ship")).toBe(200);
  expect(await pick(cys, "Later")).toBe(400);

  expect(await json(api(votes, cys))).toMatchObject({
    canOpen: true,
    votes: [
      {
        question: "Ship it today?",
        options: ["Ship", "Wait"],
        picks: [
          { name: "ana", option: "Ship" },
          { name: "bo", option: "Ship" },
        ],
        mine: null,
        canClose: false,
      },
    ],
  });

  const close = `/api/plugins/ask/votes/${id}/close`;

  expect((await api(close, cys, {})).status).toBe(403);
  expect((await api(close, anas, {})).status).toBe(200);
  expect(await json(api(votes, anas))).toEqual({ canOpen: true, votes: [] });

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

  await api(`/api/sessions/${session.id}/commands`, anas, {
    type: "message",
    text: "Go on",
  });

  for await (const command of commands) {
    expect(command).toMatchObject({
      type: "context",
      text: [
        "The team talked since your last turn:",
        'A vote closed: "Ship it today?": Ship 2 (ana, bo), Wait 0. ana closed it.',
        "",
        "ana sends the next message.",
      ].join("\n"),
    });

    break;
  }
});

test("a vote closes on time, even with nobody voting", async () => {
  const anas = await ana();
  const team = await teamSetup();

  const session = await json<Session>(
    api("/api/sessions", anas, {
      team: true,
      environment: team.environment,
      profile: team.profile,
      workspace: workspace(),
    }),
  );

  const votes = `/api/plugins/ask/sessions/${session.id}/votes`;

  expect(
    (
      await api(votes, anas, {
        question: "Lunch?",
        options: ["Yes", "No"],
        minutes: 1,
      })
    ).status,
  ).toBe(201);

  setSystemTime(new Date(Date.now() + 61_000));

  expect(await json(api(votes, anas))).toEqual({ canOpen: true, votes: [] });

  const events = await api(`/api/sessions/${session.id}/events`, anas);

  for await (const event of readSse(events)) {
    const replayed = event as SessionEvent;

    if (replayed.type === "voice") {
      expect(replayed.voice).toMatchObject({
        kind: "vote",
        text: '"Lunch?": nobody voted. It closed on time.',
      });

      break;
    }
  }
});

test("nobody opens a vote in team work they can't see", async () => {
  const anas = await ana();
  const bos = await member("bo");
  const team = await teamSetup();

  const shared = await json<Session>(
    api("/api/sessions", anas, {
      team: true,
      environment: team.environment,
      profile: team.profile,
      workspace: workspace(),
    }),
  );

  await api(
    `/api/sessions/${shared.id}/access`,
    anas,
    { kind: "named", people: [] },
    "PUT",
  );

  expect(
    (
      await api(`/api/plugins/ask/sessions/${shared.id}/votes`, bos, {
        question: "Ship?",
        options: ["Yes", "No"],
      })
    ).status,
  ).toBe(404);
});

const clone = {
  kind: "clone",
  repository: "https://git.example.com/team/docs.git",
  startPoint: "main",
} as const;

test("team work forks as team work, or to a person's own side with its transcript", async () => {
  const anas = await ana();
  const team = await teamSetup();

  const { environment: laptop } = await json<{ environment: Environment }>(
    api("/api/environments", anas, { name: "laptop" }),
  );

  const session = await json<Session>(
    api("/api/sessions", anas, {
      team: true,
      environment: team.environment,
      profile: team.profile,
      workspace: clone,
    }),
  );

  const [assigned] = await poll(team.runner);
  const lines = ['{"type":"session","id":"pi-1"}'];

  const appended = await fetch(
    new URL(`/agent/sessions/${session.id}/transcript`, server.url),
    {
      method: "POST",
      headers: {
        "pipoca-protocol": "4",
        authorization: `Bearer ${team.runner}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        generation: assigned?.generation,
        start: 0,
        lines,
      }),
    },
  );

  expect(appended.status).toBe(200);

  const fork = `/api/sessions/${session.id}/fork`;
  const teamFork = await json<Session>(api(fork, anas, {}));

  expect(teamFork).toMatchObject({
    ownedBy: "team",
    environmentId: team.environment,
    profileId: team.profile,
  });

  const mine = await json<Session>(api(fork, anas, { personal: true }));

  expect(mine.ownedBy).toBe(`person:${mine.startedBy ?? ""}`);
  expect(mine.environmentId).toBe(laptop.id);
  expect(mine.profileId).not.toBe(team.profile);
  expect(starter?.transcript(mine.id)).toEqual(lines);
});

test("personal work moves to the team from a summary, leaving its transcript behind", async () => {
  const anas = await ana();
  const bos = await member("bo");
  const team = await teamSetup();

  await api("/api/environments", anas, { name: "laptop" });

  const mine = await json<Session>(
    api("/api/sessions", anas, { workspace: clone }),
  );

  const move = `/api/sessions/${mine.id}/move`;
  const summary = "Goal: fix the docs build. Done: found the broken link.";

  expect((await api(move, bos, { summary })).status).toBe(404);
  expect((await api(move, anas, { summary: " " })).status).toBe(400);

  const moved = await api(move, anas, {
    summary,
    environment: team.environment,
    profile: team.profile,
  });

  expect(moved.status).toBe(201);

  const teamWork = (await moved.json()) as Session;

  expect(teamWork).toMatchObject({
    ownedBy: "team",
    environmentId: team.environment,
    profileId: team.profile,
    firstMessage: summary,
    workspace: {
      kind: "clone",
      repository: clone.repository,
      startPoint: "main",
    },
  });

  expect(teamWork.workspace).not.toMatchObject({
    branch: mine.workspace.kind === "clone" ? mine.workspace.branch : "",
  });

  expect(starter?.transcript(teamWork.id)).toEqual([]);

  const again = await api(`/api/sessions/${teamWork.id}/move`, anas, {
    summary,
  });

  expect(await again.json()).toMatchObject({ error: "not_personal" });

  const folder = await json<Session>(
    api("/api/sessions", anas, { workspace: workspace() }),
  );

  const stuck = await api(`/api/sessions/${folder.id}/move`, anas, {
    summary,
    environment: team.environment,
    profile: team.profile,
  });

  expect(await stuck.json()).toMatchObject({ error: "not_movable" });
});

test("team work signs git in as a technical user the team may use, never as its starter", async () => {
  const anas = await ana();
  const team = await teamSetup();

  await api("/api/sessions", anas, {
    team: true,
    environment: team.environment,
    profile: team.profile,
    workspace: workspace(),
  });

  const acting = starter?.start({
    actor: "plugin:routines",
    team: true,
    actsAs: "release-bot",
    environment: team.environment,
    profile: team.profile,
    workspace: workspace(),
  });

  const assigned = await poll(team.runner);

  expect(
    assigned.map(({ sessionId, gitLogins }) => [sessionId, gitLogins]),
  ).toContainEqual([
    acting?.id,
    [{ host: "git.example.com", token: "release-bot for team" }],
  ]);

  expect(
    assigned.filter(({ gitLogins }) => gitLogins === undefined),
  ).toHaveLength(1);
});

test("a Team assistant runs as team work only its person steers, with tools that follow their role", async () => {
  const pedros = await pedro();
  const anaId = randomUUID();
  await member("ana", anaId);
  const bos = await member("bo");
  const team = await teamSetup();

  const { user: admin } = await json<{ user: { id: string } }>(
    api("/api/auth", pedros),
  );

  const assistant = (person: string): Session | undefined =>
    starter?.start(
      {
        team: true,
        actor: `user:${person}`,
        environment: team.environment,
        profile: "starter.helper",
        workspace: workspace(),
        access: { kind: "named", people: [] },
      },
      `assistant-${person}`,
    );

  const anas = assistant(anaId);
  const admins = assistant(admin.id);

  expect(anas).toMatchObject({
    ownedBy: "team",
    access: { kind: "named", people: [] },
  });

  expect((await api(`/api/sessions/${anas?.id ?? ""}`, bos)).status).toBe(404);

  const rename = async (session: Session | undefined, name: string) =>
    session === undefined
      ? undefined
      : toolsets?.call(session, "profiles_update", {
          id: team.profile,
          name,
        });

  expect(await rename(anas, "Ana's")).toMatchObject({ isError: true });
  expect((await rename(anas, "Ana's"))?.text).toContain("admin_only");

  expect(await rename(admins, "Shared work")).toMatchObject({
    isError: false,
  });

  expect(() =>
    starter?.start(
      {
        team: true,
        actor: `user:${anaId}`,
        environment: team.environment,
        profile: "starter.own",
        workspace: workspace(),
      },
      "own",
    ),
  ).toThrow();
});

test("team work loads only plugins that say they work there and that admins leave on", async () => {
  const team = await teamSetup();

  const startTeamWork = async () =>
    api("/api/sessions", await pedro(), {
      team: true,
      environment: team.environment,
      profile: team.profile,
      workspace: workspace(),
    });

  await startTeamWork();

  const [first] = await poll(team.runner);

  expect(first?.plugins).toContain("ask");
  expect(first?.plugins).not.toContain("notes");

  const listed = await json<readonly PluginInfo[]>(
    api("/api/plugins", await pedro()),
  );

  expect(
    listed
      .filter(({ id }) => id === "ask" || id === "notes")
      .map(({ id, teamWork }) => ({ id, teamWork })),
  ).toEqual([
    { id: "ask", teamWork: true },
    { id: "notes", teamWork: false },
  ]);

  expect(
    (
      await api(
        "/api/plugins/notes",
        await pedro(),
        { teamWork: true },
        "PATCH",
      )
    ).status,
  ).toBe(400);

  expect(
    (await api("/api/plugins/ask", await ana(), { teamWork: false }, "PATCH"))
      .status,
  ).toBe(403);

  const off = await json<PluginInfo>(
    api("/api/plugins/ask", await pedro(), { teamWork: false }, "PATCH"),
  );

  expect(off.teamWork).toBe(false);

  await startTeamWork();

  const tools = await toolsOf(team.runner);

  expect(tools).not.toContain("open_vote");
  expect(tools).not.toContain("jot");

  const [, second] = await poll(team.runner);

  expect(second?.plugins).not.toContain("ask");
});
