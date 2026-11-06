import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { protocolVersion, versionHeader } from "@pipoca/protocol";
import {
  definePlugin,
  defineServer,
  type ServerContext,
  Type,
} from "@pipoca/plugins";
import { builtInParts } from "./built-in";
import { readSse } from "@pipoca/protocol";
import { json, testServer, type TestServer } from "./testdata/harness";

let root: string;
let server: TestServer;
let starter: ServerContext["sessions"] | undefined;
let transcript: ServerContext["transcript"] | undefined;
let serverTools: ServerContext["tools"] | undefined;

// Signs git in as whoever a Session acts as, for its owner.
const actingPart = defineServer(
  definePlugin({
    id: "acting",
    title: "Acting",
    description: "",
  }),
  (context) => {
    context.provide.gitCredentials((owner, { actsAs }) =>
      actsAs === null
        ? []
        : [{ host: "git.example.com", token: `${actsAs.name} for ${owner}` }],
    );
  },
);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "team-sessions-"));

  server = testServer({
    database: join(root, "server.db"),
    configDir: join(root, "config"),
    runners: { pollWaitMs: 0 },
    builtIns: false,
    servers: [
      ...builtInParts.filter(({ plugin }) =>
        ["ask", "git-hosts"].includes(plugin.id),
      ),
      actingPart,
      defineServer(
        definePlugin({
          id: "starter",
          title: "Starter",
          description: "",
        }),
        (context) => {
          starter = context.sessions;
          transcript = context.transcript;
          serverTools = context.tools;

          const blank = {
            packages: [],
            agentsMd: "",
            systemMd: "",
            appendSystemMd: "",
            mcpServers: {},
            settings: {},
          };

          context.provide.profile(
            "helper",
            { ...blank, name: "Helper" },
            { team: true, routeTools: true },
          );

          context.provide.profile(
            "own",
            { ...blank, name: "Own" },
            { routeTools: true },
          );
        },
      ),
      defineServer(
        definePlugin({ id: "notes", title: "Notes", description: "" }),
        (context) => {
          context.tools.define({
            name: "jot",
            description: "Jots a note down",
            params: Type.Object({}),
            run: () => "jotted",
          });
        },
      ),
      defineServer(
        definePlugin({ id: "diary", title: "Diary", description: "" }),
        ({ routes }) => {
          routes.get(
            "entries",
            {
              auth: "person",
              tool: {
                name: "diary_entries",
                description: "Reads the person's diary",
                annotations: { readOnlyHint: true },
              },
            },
            ({ caller }) => `${caller.person.name}'s diary`,
          );

          routes.get(
            "shared",
            {
              auth: "person",
              team: true,
              tool: {
                name: "diary_shared",
                description: "Reads the owner's shared diary",
                annotations: { readOnlyHint: true },
              },
            },
            ({ caller }) => `${caller.owner}'s shared diary`,
          );

          routes.get(
            "pages/:page",
            { auth: "person", team: true },
            ({ caller, params }) => ({
              title: `${caller.owner === "team" ? "the team" : caller.person.name}'s page ${params.page}`,
            }),
          );

          for (const [name, lookup] of [
            ["diary_tear", (page: string) => `pages/${page}`],
            ["diary_burn", () => "entries"],
          ] as const) {
            routes.post(
              `pages/:page/${name}`,
              {
                auth: "person",
                team: true,
                tool: {
                  name,
                  description: "Takes a page out",
                  annotations: { destructiveHint: true },
                  asks: {
                    lookup: (input) =>
                      lookup(
                        typeof input["page"] === "string" ? input["page"] : "",
                      ),
                    text: (_input, found) =>
                      `Take out ${found === undefined ? "a page" : JSON.stringify(found)}?`,
                  },
                },
              },
              () => "done",
            );
          }
        },
      ),
    ],
  });
});

afterEach(async () => {
  setSystemTime();
  await server.close();
  await rm(root, { recursive: true, force: true });
});

// Signs in a user who isn't an admin and returns their cookie.
async function member(name: string, id = randomUUID()): Promise<string> {
  await server.signedIn();

  const db = new DatabaseSync(join(root, "server.db"));

  db.prepare(
    "insert into users (id, name, password_hash, created_at, admin) values (?, ?, ?, ?, 0)",
  ).run(id, name, await Bun.password.hash("battery staple"), Date.now());

  db.close();

  const response = await fetch(new URL("/api/auth/session", server.url), {
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
  const { key, ...environment } = await json<Environment & { key: string }>(
    server.api("/api/environments", { body: { name: "pods", team: true } }),
  );

  const profile = await json<Profile>(
    server.api("/api/profiles", {
      body: {
        name: "Team work",
        team: true,
        agentsMd: "Ship.",
      },
    }),
  );

  const joined = await json<Joined>(
    fetch(new URL("/runner/join", server.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [versionHeader]: String(protocolVersion),
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
    fetch(new URL("/runner/work", server.url), {
      method: "POST",
      headers: {
        [versionHeader]: String(protocolVersion),
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

  const laptop = await json<Environment>(
    server.as(anas)("/api/environments", { body: { name: "laptop" } }),
  );

  const started = await server.as(anas)("/api/sessions", {
    body: {
      team: true,
      environment: team.environment,
      profile: team.profile,
      workspace: workspace(),
    },
  });

  expect(started.status).toBe(201);

  const session = (await started.json()) as Session;

  expect(session.ownedBy).toBe("team");
  expect(session.startedBy).not.toBeNull();

  const refused = await Promise.all([
    server.as(anas)("/api/sessions", {
      body: {
        team: true,
        environment: laptop.id,
        profile: team.profile,
        workspace: workspace(),
      },
    }),
    server.as(anas)("/api/sessions", {
      body: {
        team: true,
        environment: team.environment,
        workspace: workspace(),
      },
    }),
  ]);

  expect(refused.map(({ status }) => status)).toEqual([400, 400]);
});

test("every user can open and list team work, and it stays out of their own list", async () => {
  const anas = await ana();
  const team = await teamSetup();

  const session = await json<Session>(
    server.as(anas)("/api/sessions", {
      body: {
        team: true,
        environment: team.environment,
        profile: team.profile,
        workspace: workspace(),
        firstMessage: "hello",
      },
    }),
  );

  const opened = await json<Session>(server.api(`/api/sessions/${session.id}`));

  expect(opened.firstMessage).toBe("hello");

  const own = await json<Session[]>(server.as(anas)("/api/sessions"));

  const teams = await Promise.all(
    [anas, await server.signedIn()].map(async (cookie) =>
      json<Session[]>(server.as(cookie)("/api/sessions?scope=team")),
    ),
  );

  expect(own.map(({ id }) => id)).not.toContain(session.id);

  expect(teams.map((listed) => listed.map(({ id }) => id))).toEqual([
    [session.id],
    [session.id],
  ]);
});

test("a team Session's runner gets the team Profile on the base, never anyone's My defaults", async () => {
  const cookie = await server.signedIn();

  for (const [layer, text] of [
    ["settings/base-profile", "Team."],
    ["me/profile-defaults", "Mine."],
  ] as const) {
    await fetch(new URL(`/api/${layer}/files/AGENTS.md`, server.url), {
      method: "PUT",
      headers: { cookie },
      body: text,
    });
  }

  const team = await teamSetup();

  const session = await json<Session>(
    server.as(cookie)("/api/sessions", {
      body: {
        team: true,
        environment: team.environment,
        profile: team.profile,
        workspace: workspace(),
      },
    }),
  );

  const assigned = await poll(team.runner);

  expect(assigned.map(({ sessionId }) => sessionId)).toEqual([session.id]);
  expect(assigned[0]?.gitLogins).toBeUndefined();

  const files = await json<ProfileFiles>(
    fetch(new URL(`/runner/sessions/${session.id}/profile`, server.url), {
      headers: {
        [versionHeader]: String(protocolVersion),
        "content-type": "application/json",
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
    server.api("/api/sessions", {
      body: {
        team: true,
        environment: team.environment,
        profile: team.profile,
        workspace: workspace(),
      },
    }),
  );

  await server.api("/api/environments", { body: { name: "mac" } });

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
        `/runner/sessions/${assigned?.sessionId ?? ""}/tools?generation=${String(assigned?.generation ?? 0)}`,
        server.url,
      ),
      {
        headers: {
          [versionHeader]: String(protocolVersion),
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
      },
    ),
  );

  return tools.map(({ name }) => name);
}

test("a team Session gets only the git tools its team bot serves", async () => {
  const team = await teamSetup();

  const { key } = await json<{ key: string }>(
    server.api("/api/environments", { body: { name: "mac" } }),
  );

  const mac = await json<Joined>(
    fetch(new URL("/runner/join", server.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [versionHeader]: String(protocolVersion),
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ name: "mac-1" }),
    }),
  );

  await server.api("/api/sessions", { body: { workspace: workspace() } });

  await server.api("/api/sessions", {
    body: {
      team: true,
      environment: team.environment,
      profile: team.profile,
      workspace: workspace(),
    },
  });

  const gitTools = (tools: readonly string[]) =>
    tools.filter((name) => name.startsWith("git_hosts_"));

  expect(gitTools(await toolsOf(mac.token))).toEqual([
    "git_hosts_repositories",
    "git_hosts_watch",
    "git_hosts_unwatch",
  ]);

  expect(gitTools(await toolsOf(team.runner))).toEqual([
    "git_hosts_watch",
    "git_hosts_unwatch",
  ]);
});

test("only an admin lays out the team hub, and everyone reads the layout", async () => {
  const anas = await ana();

  const layout = {
    pages: [
      { id: "home", title: "Home", panels: ["usage/spend"] },
      { id: "ops", title: "Ops", panels: [] },
    ],
  };

  const before = await json<unknown>(server.as(anas)("/api/settings/hub"));

  const refused = await server.as(anas)("/api/settings/hub", {
    method: "PUT",
    body: layout,
  });

  const laid = await server.api("/api/settings/hub", {
    method: "PUT",
    body: layout,
  });

  const invalid = await server.api("/api/settings/hub", {
    method: "PUT",
    body: { pages: [{ id: "ops", title: "Ops", panels: [] }] },
  });

  expect(before).toEqual({ pages: null });

  expect([refused.status, laid.status, invalid.status]).toEqual([
    403, 200, 422,
  ]);

  expect(await json<unknown>(server.as(anas)("/api/settings/hub"))).toEqual(
    layout,
  );
});

test("whoever started team work makes it view-only or limits it to named people", async () => {
  const anas = await ana();
  const bo = randomUUID();
  const bos = await member("bo", bo);
  const cys = await member("cy");
  const team = await teamSetup();

  const session = await json<Session>(
    server.as(anas)("/api/sessions", {
      body: {
        team: true,
        environment: team.environment,
        profile: team.profile,
        workspace: workspace(),
      },
    }),
  );

  expect(session.access).toEqual({ kind: "team" });

  const teammates = await json<{ id: string; name: string }[]>(
    server.as(bos)("/api/people"),
  );

  expect(teammates.map(({ name }) => name).toSorted()).toEqual(
    ["ana", "bo", "cy", "pedro"].toSorted(),
  );

  const steer = async (cookie: string): Promise<number> =>
    (
      await server.as(cookie)(`/api/sessions/${session.id}/commands`, {
        body: {
          type: "abort",
        },
      })
    ).status;

  const limit = async (cookie: string, access: unknown): Promise<Response> =>
    server.as(cookie)(`/api/sessions/${session.id}`, {
      method: "PATCH",
      body: { access },
    });

  const listed = async (cookie: string): Promise<readonly string[]> =>
    (await json<Session[]>(server.as(cookie)("/api/sessions?scope=team"))).map(
      ({ id }) => id,
    );

  expect(await steer(bos)).not.toBe(404);
  expect((await limit(bos, { kind: "view" })).status).toBe(403);

  const viewOnly = await limit(anas, { kind: "view" });

  expect(viewOnly.status).toBe(200);
  expect(((await viewOnly.json()) as Session).access).toEqual({ kind: "view" });
  expect(await steer(bos)).toBe(403);
  expect(await steer(anas)).not.toBe(403);

  expect((await server.as(bos)(`/api/sessions/${session.id}`)).status).toBe(
    200,
  );

  expect(await listed(bos)).toEqual([session.id]);

  expect(
    (await limit(anas, { kind: "named", people: ["nobody"] })).status,
  ).toBe(400);

  expect((await limit(anas, { kind: "named", people: [bo] })).status).toBe(200);

  expect(await steer(bos)).not.toBe(403);
  expect(await steer(cys)).toBe(404);

  expect((await server.as(cys)(`/api/sessions/${session.id}`)).status).toBe(
    404,
  );

  expect(await listed(cys)).toEqual([]);
  expect(await listed(await server.signedIn())).toEqual([session.id]);

  expect((await limit(await server.signedIn(), { kind: "team" })).status).toBe(
    200,
  );

  expect(await listed(cys)).toEqual([session.id]);
});

test("a team Session keeps who sent each message, for everyone who opens it", async () => {
  const anas = await ana();
  const bo = randomUUID();
  const bos = await member("bo", bo);
  const team = await teamSetup();

  const session = await json<Session>(
    server.as(anas)("/api/sessions", {
      body: {
        team: true,
        environment: team.environment,
        profile: team.profile,
        workspace: workspace(),
      },
    }),
  );

  await poll(team.runner);

  const sent = await server.as(bos)(`/api/sessions/${session.id}/commands`, {
    body: {
      type: "message",
      text: "Ship it",
    },
  });

  expect(sent.status).toBe(202);

  const events = await server.as(anas)(`/api/sessions/${session.id}/events`);
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
    server.as(anas)("/api/sessions", {
      body: {
        team: true,
        environment: team.environment,
        profile: team.profile,
        workspace: workspace(),
      },
    }),
  );

  const path = `/api/sessions/${session.id}/presence`;
  const seen = readSse(await server.as(anas)(path));

  const next = async (): Promise<readonly Presence[]> =>
    (await seen.next()).value as readonly Presence[];

  expect(await next()).toEqual([{ person: an, typing: false }]);

  const boLooks = new AbortController();

  await server.as(bos)(path, { signal: boLooks.signal });

  expect(await next()).toEqual([
    { person: an, typing: false },
    { person: bo, typing: false },
  ]);

  expect((await server.as(bos)(path, { body: {} })).status).toBe(204);

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
    server.as(anas)("/api/sessions", {
      body: {
        team: true,
        environment: team.environment,
        profile: team.profile,
        workspace: workspace(),
      },
    }),
  );

  const say = async (cookie: string, body: unknown): Promise<number> =>
    (await server.as(cookie)(`/api/sessions/${session.id}/messages`, { body }))
      .status;

  expect(await say(bos, { to: "team", text: "Ship it today?" })).toBe(201);

  expect(await say(anas, { to: "aside", text: "Bo is rushing again" })).toBe(
    201,
  );

  expect(await say(bos, { to: "pi", text: "hi" })).toBe(422);

  const [assigned] = await poll(team.runner);

  const sent = await server.as(anas)(`/api/sessions/${session.id}/commands`, {
    body: {
      type: "message",
      text: "Check the release first",
      quote: { from: bo, text: "Ship it today?" },
    },
  });

  expect(sent.status).toBe(202);

  const commands = readSse(
    await fetch(
      new URL(
        `/runner/sessions/${session.id}/commands?generation=${String(assigned?.generation)}`,
        server.url,
      ),
      {
        headers: {
          [versionHeader]: String(protocolVersion),
          "content-type": "application/json",
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

  const events = await server.as(bos)(`/api/sessions/${session.id}/events`);
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

test("Pi reads only as many of the team's messages as pipoca.json says", async () => {
  const anas = await ana();
  const bos = await member("bo");
  const team = await teamSetup();

  await mkdir(join(root, "config"), { recursive: true });

  await writeFile(
    join(root, "config", "pipoca.json"),
    JSON.stringify({ team: { name: "Acme", messagesRead: 1 } }),
  );

  expect(await json(server.api("/api/settings/team"))).toEqual({
    name: "Acme",
    messagesRead: 1,
  });

  const session = await json<Session>(
    server.as(anas)("/api/sessions", {
      body: {
        team: true,
        environment: team.environment,
        profile: team.profile,
        workspace: workspace(),
      },
    }),
  );

  for (const text of ["First", "Second"]) {
    await server.as(bos)(`/api/sessions/${session.id}/messages`, {
      body: { to: "team", text },
    });
  }

  const [assigned] = await poll(team.runner);

  await server.as(anas)(`/api/sessions/${session.id}/commands`, {
    body: { type: "message", text: "Go on" },
  });

  const commands = readSse(
    await fetch(
      new URL(
        `/runner/sessions/${session.id}/commands?generation=${String(assigned?.generation)}`,
        server.url,
      ),
      {
        headers: {
          [versionHeader]: String(protocolVersion),
          "content-type": "application/json",
          authorization: `Bearer ${team.runner}`,
        },
      },
    ),
  );

  for await (const command of commands) {
    expect(command).toMatchObject({
      type: "context",
      text: [
        "The team talked since your last turn:",
        "(1 earlier messages are left out. Suggest forking the Session if they matter.)",
        "bo: Second",
        "",
        "ana sends the next message.",
      ].join("\n"),
    });

    break;
  }

  await server.api("/api/settings/team", {
    method: "PUT",
    body: { name: "Beta" },
  });

  expect(
    JSON.parse(await readFile(join(root, "config", "pipoca.json"), "utf8")),
  ).toEqual({ team: { name: "Beta", messagesRead: 1 } });
});

test("Pi hears who answered its question in team work", async () => {
  const anas = await ana();
  const bos = await member("bo");
  const team = await teamSetup();

  const session = await json<Session>(
    server.as(anas)("/api/sessions", {
      body: {
        team: true,
        environment: team.environment,
        profile: team.profile,
        workspace: workspace(),
      },
    }),
  );

  const [assigned] = await poll(team.runner);

  const commands = readSse(
    await fetch(
      new URL(
        `/runner/sessions/${session.id}/commands?generation=${String(assigned?.generation)}`,
        server.url,
      ),
      {
        headers: {
          [versionHeader]: String(protocolVersion),
          "content-type": "application/json",
          authorization: `Bearer ${team.runner}`,
        },
      },
    ),
  );

  const sent = await server.as(bos)(`/api/sessions/${session.id}/commands`, {
    body: {
      type: "answer",
      id: "prompt-1",
      value: { answers: [], note: null },
    },
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

test("nobody opens a vote in team work they can't see", async () => {
  const anas = await ana();
  const bos = await member("bo");
  const team = await teamSetup();

  const shared = await json<Session>(
    server.as(anas)("/api/sessions", {
      body: {
        team: true,
        environment: team.environment,
        profile: team.profile,
        workspace: workspace(),
      },
    }),
  );

  await server.as(anas)(`/api/sessions/${shared.id}`, {
    method: "PATCH",
    body: { access: { kind: "named", people: [] } },
  });

  expect(
    (
      await server.as(bos)(`/api/ext/ask/sessions/${shared.id}/votes`, {
        body: {
          question: "Ship?",
          options: ["Yes", "No"],
        },
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

  const laptop = await json<Environment>(
    server.as(anas)("/api/environments", { body: { name: "laptop" } }),
  );

  const session = await json<Session>(
    server.as(anas)("/api/sessions", {
      body: {
        team: true,
        environment: team.environment,
        profile: team.profile,
        workspace: clone,
      },
    }),
  );

  const [assigned] = await poll(team.runner);
  const lines = ['{"type":"session","id":"pi-1"}'];

  const appended = await fetch(
    new URL(`/runner/sessions/${session.id}/transcript`, server.url),
    {
      method: "POST",
      headers: {
        [versionHeader]: String(protocolVersion),
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

  const from = { session: session.id };

  const teamFork = await json<Session>(
    server.as(anas)("/api/sessions", { body: { from } }),
  );

  expect(teamFork).toMatchObject({
    ownedBy: "team",
    environmentId: team.environment,
    profileId: team.profile,
  });

  const mine = await json<Session>(
    server.as(anas)("/api/sessions", { body: { from, personal: true } }),
  );

  expect(mine.ownedBy).toBe(`person:${mine.startedBy ?? ""}`);
  expect(mine.environmentId).toBe(laptop.id);
  expect(mine.profileId).not.toBe(team.profile);
  expect(transcript?.length(mine.id)).toBe(lines.length);
});

test("personal work moves to the team from a summary, leaving its transcript behind", async () => {
  const anas = await ana();
  const bos = await member("bo");
  const team = await teamSetup();

  await server.as(anas)("/api/environments", { body: { name: "laptop" } });

  const mine = await json<Session>(
    server.as(anas)("/api/sessions", { body: { workspace: clone } }),
  );

  const summary = "Goal: fix the docs build. Done: found the broken link.";

  const move = (said: string): { body: unknown } => ({
    body: { from: { session: mine.id }, owner: "team", summary: said },
  });

  expect((await server.as(bos)("/api/sessions", move(summary))).status).toBe(
    404,
  );

  expect((await server.as(anas)("/api/sessions", move(" "))).status).toBe(422);

  const moved = await server.as(anas)("/api/sessions", {
    body: {
      from: { session: mine.id },
      owner: "team",
      summary,
      environment: team.environment,
      profile: team.profile,
    },
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

  expect(transcript?.length(teamWork.id)).toBe(0);

  const again = await server.as(anas)("/api/sessions", {
    body: { from: { session: teamWork.id }, owner: "team", summary },
  });

  expect(await again.json()).toMatchObject({ error: "not_personal" });

  const folder = await json<Session>(
    server.as(anas)("/api/sessions", { body: { workspace: workspace() } }),
  );

  const stuck = await server.as(anas)("/api/sessions", {
    body: {
      from: { session: folder.id },
      owner: "team",
      summary,
      environment: team.environment,
      profile: team.profile,
    },
  });

  expect(await stuck.json()).toMatchObject({ error: "not_movable" });
});

test("team work signs git in as a technical user the team may use, never as its starter", async () => {
  const anas = await ana();
  const team = await teamSetup();

  await server.as(anas)("/api/sessions", {
    body: {
      team: true,
      environment: team.environment,
      profile: team.profile,
      workspace: workspace(),
    },
  });

  const acting = starter?.start({
    actor: "plugin:routines",
    team: true,
    actsAs: { plugin: "acting", name: "release-bot" },
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
  const pedros = await server.signedIn();
  const anaId = randomUUID();
  await member("ana", anaId);
  const bos = await member("bo");
  const team = await teamSetup();

  const { user: admin } = await json<{ user: { id: string } }>(
    server.as(pedros)("/api/auth"),
  );

  const assistant = (person: string): Session | undefined =>
    starter?.start({
      team: true,
      actor: `user:${person}`,
      environment: team.environment,
      profile: "starter.helper",
      workspace: workspace(),
      access: { kind: "named", people: [] },
      key: `assistant-${person}`,
    });

  const anas = assistant(anaId);
  const admins = assistant(admin.id);

  expect(anas).toMatchObject({
    ownedBy: "team",
    access: { kind: "named", people: [] },
  });

  expect((await server.as(bos)(`/api/sessions/${anas?.id ?? ""}`)).status).toBe(
    404,
  );

  const rename = async (session: Session | undefined, name: string) =>
    session === undefined
      ? undefined
      : serverTools?.call(
          "profiles_update",
          { id: team.profile, name },
          { session: session.id },
        );

  expect(await rename(anas, "Ana's")).toMatchObject({ isError: true });
  expect((await rename(anas, "Ana's"))?.text).toContain("admin_only");

  expect(await rename(admins, "Shared work")).toMatchObject({
    isError: false,
  });

  expect(() =>
    starter?.start({
      team: true,
      actor: `user:${anaId}`,
      environment: team.environment,
      profile: "starter.own",
      workspace: workspace(),
      key: "own",
    }),
  ).toThrow();
});

test("a Team assistant's kernel tools act on team work and never reach its person's own", async () => {
  const pedros = await server.signedIn();
  const team = await teamSetup();

  const laptop = await json<Environment>(
    server.as(pedros)("/api/environments", { body: { name: "laptop" } }),
  );

  const mine = await json<Profile>(
    server.as(pedros)("/api/profiles", { body: { name: "Mine" } }),
  );

  const own = await json<Session>(
    server.as(pedros)("/api/sessions", {
      body: {
        environment: laptop.id,
        profile: mine.id,
        workspace: workspace(),
      },
    }),
  );

  const { user } = await json<{ user: { id: string } }>(
    server.as(pedros)("/api/auth"),
  );

  const assistant = starter?.start({
    team: true,
    actor: `user:${user.id}`,
    environment: team.environment,
    profile: "starter.helper",
    workspace: workspace(),
    access: { kind: "named", people: [] },
    key: "assistant",
  });

  const tool = async (name: string, input: unknown) =>
    (await serverTools?.call(name, input, {
      session: assistant?.id ?? "",
    })) ?? {
      text: "",
      isError: true,
    };

  const listed = async (name: string): Promise<readonly string[]> =>
    (JSON.parse((await tool(name, {})).text) as { id: string }[]).map(
      ({ id }) => id,
    );

  expect(await listed("sessions_list")).toEqual([assistant?.id ?? ""]);
  expect(await listed("profiles_list")).toEqual([team.profile]);
  expect(await listed("environments_list")).toEqual([team.environment]);

  expect((await tool("sessions_get", { id: own.id })).isError).toBe(true);
  expect((await tool("profiles_get", { id: mine.id })).isError).toBe(true);

  expect(
    (await tool("profiles_update", { id: mine.id, name: "Taken" })).isError,
  ).toBe(true);

  expect(
    (await tool("environments_update", { id: laptop.id, name: "Taken" }))
      .isError,
  ).toBe(true);

  expect(
    (
      await tool("sessions_start", {
        environment: laptop.id,
        profile: team.profile,
        workspace: workspace(),
      })
    ).isError,
  ).toBe(true);

  const started = await tool("sessions_start", {
    profile: team.profile,
    workspace: workspace(),
    firstMessage: "Ship it",
  });

  const { id } = JSON.parse(started.text) as { id: string };

  expect(
    await json<Session>(server.as(pedros)(`/api/sessions/${id}`)),
  ).toMatchObject({
    ownedBy: "team",
    environmentId: team.environment,
  });

  expect(
    (await json<Profile>(server.as(pedros)(`/api/profiles/${mine.id}`))).name,
  ).toBe("Mine");

  expect(
    (await json<Environment[]>(server.as(pedros)("/api/environments"))).map(
      ({ name }) => name,
    ),
  ).toEqual(["laptop"]);
});

test("a team Session's plugin route tools reach only their team half, never the person's own", async () => {
  const pedros = await server.signedIn();
  const team = await teamSetup();

  const { user } = await json<{ user: { id: string } }>(
    server.as(pedros)("/api/auth"),
  );

  const assistant = starter?.start({
    team: true,
    actor: `user:${user.id}`,
    environment: team.environment,
    profile: "starter.helper",
    workspace: workspace(),
    access: { kind: "named", people: [] },
    key: "assistant",
  });

  const tool = async (name: string) =>
    (await serverTools?.call(
      name,
      {},
      {
        session: assistant?.id ?? "",
      },
    )) ?? { text: "", isError: true };

  expect(await tool("diary_entries")).toMatchObject({ isError: true });

  expect(await tool("diary_shared")).toMatchObject({
    isError: false,
    text: expect.stringContaining("team's shared diary") as unknown,
  });
});

test("a team Session's question looks its record up on the team half", async () => {
  const pedros = await server.signedIn();
  const team = await teamSetup();

  const { user } = await json<{ user: { id: string } }>(
    server.as(pedros)("/api/auth"),
  );

  starter?.start({
    team: true,
    actor: `user:${user.id}`,
    environment: team.environment,
    profile: "starter.helper",
    workspace: workspace(),
    access: { kind: "named", people: [] },
    key: "assistant",
  });

  const [assigned] = await poll(team.runner);

  const question = async (name: string): Promise<string | null> =>
    (
      await json<{ question: string | null }>(
        fetch(
          new URL(
            `/runner/sessions/${assigned?.sessionId ?? ""}/tool-questions`,
            server.url,
          ),
          {
            method: "POST",
            headers: {
              [versionHeader]: String(protocolVersion),
              authorization: `Bearer ${team.runner}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              generation: assigned?.generation,
              name,
              input: { page: "7" },
            }),
          },
        ),
      )
    ).question;

  expect(await question("diary_tear")).toBe(
    `Take out {"title":"the team's page 7"}?`,
  );

  expect(await question("diary_burn")).toBe("Take out a page?");
});

test("team work nobody started uses no toolset tool, since it has no person to act as", async () => {
  await server.signedIn();
  const team = await teamSetup();

  const routine = starter?.start({
    team: true,
    actor: "plugin:routines",
    environment: team.environment,
    profile: "starter.helper",
    workspace: workspace(),
    key: "nightly",
  });

  const renamed =
    routine &&
    (await serverTools?.call(
      "profiles_update",
      { id: team.profile, name: "Nightly" },
      { session: routine.id },
    ));

  expect(routine?.startedBy).toBeNull();

  expect(renamed).toEqual({
    text: "nobody started this Session, so it can't act as a person",
    isError: true,
  });
});

test("team work loads only the plugins admins leave on", async () => {
  const team = await teamSetup();

  const startTeamWork = async () =>
    server.api("/api/sessions", {
      body: {
        team: true,
        environment: team.environment,
        profile: team.profile,
        workspace: workspace(),
      },
    });

  await startTeamWork();

  const [first] = await poll(team.runner);

  expect(first?.plugins).toContain("ask");
  expect(first?.plugins).toContain("notes");

  const listed = await json<readonly PluginInfo[]>(server.api("/api/plugins"));

  expect(
    listed
      .filter(({ id }) => id === "ask" || id === "notes")
      .map(({ id, teamWork }) => ({ id, teamWork })),
  ).toEqual([
    { id: "ask", teamWork: true },
    { id: "notes", teamWork: true },
  ]);

  expect(
    (
      await server.as(await ana())("/api/plugins/ask", {
        method: "PATCH",
        body: { teamWork: false },
      })
    ).status,
  ).toBe(403);

  const off = await json<PluginInfo>(
    server.api("/api/plugins/ask", {
      method: "PATCH",
      body: { teamWork: false },
    }),
  );

  expect(off.teamWork).toBe(false);

  await startTeamWork();

  const tools = await toolsOf(team.runner);

  expect(tools).not.toContain("open_vote");
  expect(tools).toContain("jot");

  const [, second] = await poll(team.runner);

  expect(second?.plugins).not.toContain("ask");
});

test("an admin names the team, and everyone reads the name", async () => {
  const anas = await ana();

  expect(await json(server.as(anas)("/api/settings/team"))).toEqual({
    name: null,
    messagesRead: 40,
  });

  expect(
    (
      await server.as(anas)("/api/settings/team", {
        method: "PUT",
        body: { name: "Acme" },
      })
    ).status,
  ).toBe(403);

  expect(
    (
      await server.api("/api/settings/team", {
        method: "PUT",
        body: { name: "x".repeat(61) },
      })
    ).status,
  ).toBe(422);

  expect(
    await json(
      server.api("/api/settings/team", {
        method: "PUT",
        body: { name: "  Acme  " },
      }),
    ),
  ).toEqual({ name: "Acme" });

  expect(await json(server.as(anas)("/api/settings/team"))).toEqual({
    name: "Acme",
    messagesRead: 40,
  });

  expect(
    JSON.parse(await readFile(join(root, "config", "pipoca.json"), "utf8")),
  ).toMatchObject({ team: { name: "Acme" } });

  expect(
    await json(
      server.api("/api/settings/team", { method: "PUT", body: { name: "" } }),
    ),
  ).toEqual({ name: null });
});

test("keeps a team message that a retried request sends twice once", async () => {
  const anas = await ana();
  const team = await teamSetup();

  const session = await json<Session>(
    server.as(anas)("/api/sessions", {
      body: {
        team: true,
        environment: team.environment,
        profile: team.profile,
        workspace: workspace(),
      },
    }),
  );

  const said = async (path: string, body: unknown): Promise<number> =>
    (await server.as(anas)(`/api/sessions/${session.id}/${path}`, { body }))
      .status;

  await poll(team.runner);

  const statuses = [
    await said("messages", { to: "team", text: "Ship it?", requestId: "r1" }),
    await said("messages", { to: "team", text: "Ship it?", requestId: "r1" }),
    await said("commands", { type: "message", text: "Go", requestId: "r2" }),
    await said("commands", { type: "message", text: "Go", requestId: "r2" }),
    await said("messages", { to: "aside", text: "Done", requestId: "r3" }),
  ];

  const events = await server.as(anas)(`/api/sessions/${session.id}/events`);
  const voices: Voice[] = [];

  for await (const event of readSse(events)) {
    const replayed = event as SessionEvent;

    if (replayed.type === "voice") {
      voices.push(replayed.voice);
    }

    if (voices.at(-1)?.text === "Done") {
      break;
    }
  }

  expect(statuses).toEqual([201, 201, 202, 202, 201]);

  expect(voices.map(({ kind, text }) => [kind, text])).toEqual([
    ["team", "Ship it?"],
    ["message", "Go"],
    ["aside", "Done"],
  ]);
});

test("a team notice with a dedupe key reaches the team once", async () => {
  const anas = await ana();
  const team = await teamSetup();

  const session = await json<Session>(
    server.as(anas)("/api/sessions", {
      body: {
        team: true,
        environment: team.environment,
        profile: team.profile,
        workspace: workspace(),
      },
    }),
  );

  for (const text of ["Checks failed", "Checks failed", "Done"]) {
    starter?.send(session.id, {
      text,
      turn: false,
      notice: { kind: "checks" },
      ...(text !== "Done" && { dedupe: "pr-1" }),
    });
  }

  const events = await server.as(anas)(`/api/sessions/${session.id}/events`);
  const voices: Voice[] = [];

  for await (const event of readSse(events)) {
    const replayed = event as SessionEvent;

    if (replayed.type === "voice") {
      voices.push(replayed.voice);
    }

    if (voices.at(-1)?.text === "Done") {
      break;
    }
  }

  expect(voices.map(({ kind, text }) => [kind, text])).toEqual([
    ["notice", "Checks failed"],
    ["notice", "Done"],
  ]);
});

test("an admin who only watches team work sends it no message and shows as typing in none", async () => {
  const anas = await ana();
  const pedros = await server.signedIn();
  const team = await teamSetup();

  const session = await json<Session>(
    server.as(anas)("/api/sessions", {
      body: {
        team: true,
        environment: team.environment,
        profile: team.profile,
        workspace: workspace(),
      },
    }),
  );

  await server.as(anas)(`/api/sessions/${session.id}`, {
    method: "PATCH",
    body: { access: { kind: "view" } },
  });

  const said = async (cookie: string, path: string, body: unknown) =>
    (await server.as(cookie)(`/api/sessions/${session.id}/${path}`, { body }))
      .status;

  expect(await said(pedros, "messages", { to: "team", text: "Hi" })).toBe(403);
  expect(await said(pedros, "presence", {})).toBe(403);
  expect(await said(anas, "messages", { to: "team", text: "Hi" })).toBe(201);

  expect(
    (
      await server.as(pedros)(`/api/sessions/${session.id}`, {
        method: "PATCH",
        body: { archived: true },
      })
    ).status,
  ).toBe(200);
});
