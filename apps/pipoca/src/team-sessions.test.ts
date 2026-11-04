import { afterEach, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  Assignment,
  Environment,
  Joined,
  Profile,
  ProfileFiles,
  Session,
} from "@pipoca/protocol";
import { gitHosts } from "@pipoca/git-hosts/server";
import type { ServerPluginContext } from "@pipoca/plugins";
import { serve } from "./serve";
import { builtInPlugins } from "./session-parts";
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

// Signs in a second user, who isn't an admin, and returns their cookie.
async function ana(): Promise<string> {
  await pedro();

  const db = new DatabaseSync(join(root, "server.db"));

  db.prepare(
    "insert into users (id, name, password_hash, created_at, admin) values (?, 'ana', ?, ?, 0)",
  ).run(
    randomUUID(),
    await Bun.password.hash("battery staple"),
    new Date().toISOString(),
  );

  db.close();

  const response = await fetch(new URL("/api/auth/login", server.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "ana", password: "battery staple" }),
  });

  return response.headers.get("set-cookie")?.split(";")[0] ?? "";
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
