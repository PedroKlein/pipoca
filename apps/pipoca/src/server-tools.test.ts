import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { definePlugin, defineServer, ToolError, Type } from "@pipoca/plugins";
import {
  type Assignment,
  type Command,
  type Environment,
  readSse,
  type Session,
  type ToolResult,
  type ToolSpec,
} from "@pipoca/protocol";
import { protocolVersion, versionHeader } from "@pipoca/protocol";
import { json, testServer, type TestServer } from "./testdata/harness";
import { runnerCredentials } from "./testdata/runners";

let root: string;
let server: TestServer;
const ran: unknown[] = [];

afterEach(async () => {
  await server.close();
  await rm(root, { recursive: true, force: true });
});

const desk = {
  name: "Desk",
  packages: [],
  agentsMd: "",
  systemMd: "",
  appendSystemMd: "",
  mcpServers: {},
  settings: {},
};

const keys = defineServer(
  definePlugin({
    id: "keys",
    title: "Keys",
    description: "Keeps keys.",
  }),
  ({ tools, routes, sessions, provide }) => {
    tools.define({
      name: "count_keys",
      description: "Counts keys",
      params: Type.Object({ count: Type.Integer() }),
      prompt: {
        snippet: "Count keys before you wipe them",
        guidelines: ["Count again after a wipe"],
      },
      sequential: true,
      run: (input) => {
        ran.push(input);

        return `${String(input.count)} keys`;
      },
    });

    tools.define({
      name: "lose_key",
      description: "Loses a key",
      params: Type.Object({ how: Type.String() }),
      run: ({ how }) => {
        if (how === "said") {
          throw new ToolError("That key is gone already.");
        }

        throw new Error("disk on fire");
      },
    });

    tools.define({
      name: "team_keys",
      description: "Shows the team's keys",
      params: Type.Object({}),
      when: { owner: "team" },
      run: () => "team keys",
    });

    tools.define({
      name: "wipe_keys",
      description: "Wipes the keys",
      params: Type.Object({ count: Type.Integer() }),
      asks: ({ count }, { person }) =>
        `Wipe ${String(count)} keys of ${person?.name ?? "nobody"}?`,
      run: () => "wiped",
    });

    tools.define({
      name: "burn_keys",
      description: "Burns the keys",
      params: Type.Object({}),
      asks: () => {
        throw new Error("lookup failed");
      },
      run: () => "burned",
    });

    tools.define({
      name: "hidden_keys",
      description: "Shows hidden keys",
      params: Type.Object({}),
      when: {
        available: () => {
          throw new Error("availability broke");
        },
      },
      run: () => "hidden keys",
    });

    const profile = provide.profile("desk", desk, { routeTools: true });

    routes.post(
      "keys/:name",
      {
        auth: "person",
        body: Type.Object({ value: Type.String() }),
        tool: {
          name: "keys_put",
          description: "Puts a key",
          asks: { text: (input) => `Put the key ${String(input["name"])}?` },
        },
      },
      ({ params, body, caller }) => ({
        name: params.name,
        value: body.value,
        by: caller.person.name,
      }),
    );

    routes.get("keys", { auth: "person" }, () => ["front", "back"]);

    tools.fromRoute("GET", "keys", {
      name: "keys_list",
      description: "Lists the keys",
      annotations: { readOnlyHint: true },
    });

    routes.post(
      "desks",
      { auth: "person", body: Type.Object({ environment: Type.String() }) },
      ({ caller, body }) =>
        sessions.start({
          actor: `user:${caller.person.id}`,
          environment: body.environment,
          profile,
          workspace: { kind: "folder", path: root },
          key: "desk",
        }),
    );
  },
);

// A list for each person and one for the team, read by a route tool.
const lists = defineServer(
  definePlugin({
    id: "lists",
    title: "Lists",
    description: "Keeps lists.",
  }),
  ({ routes, sessions, provide }) => {
    const profile = provide.profile(
      "planner",
      { ...desk, name: "Planner" },
      { team: true, routeTools: true },
    );

    routes.get(
      "lists",
      {
        auth: "person",
        team: true,
        tool: { name: "lists_read", description: "Reads the list" },
      },
      ({ caller }) => ({ owner: caller.owner }),
    );

    routes.post(
      "planners",
      { auth: "person", body: Type.Object({ environment: Type.String() }) },
      ({ caller, body }) =>
        sessions.start({
          actor: `user:${caller.person.id}`,
          environment: body.environment,
          profile,
          team: true,
          key: "planner",
          workspace: { kind: "folder", path: root },
        }),
    );
  },
);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "server-tools-"));
  ran.length = 0;

  server = testServer({
    runners: { pollWaitMs: 0 },
    servers: [keys, lists],
  });
});

const runnerHeaders = (token: string): Record<string, string> => ({
  [versionHeader]: String(protocolVersion),
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
});

async function laptop(): Promise<{
  readonly token: string;
  readonly environment: string;
}> {
  const token = await runnerCredentials(server, server.signedIn).token(
    "laptop",
  );

  const environments = await json<Environment[]>(
    server.api("/api/environments"),
  );

  return {
    token,
    environment:
      environments.find(({ name }) => name === "laptop")?.id ?? "missing",
  };
}

async function ordinary(environment: string): Promise<Session> {
  return json<Session>(
    server.api("/api/sessions", {
      body: { environment, workspace: { kind: "folder", path: root } },
    }),
  );
}

// A poll that runs nothing, so it takes the Session in a new attempt.
async function claim(token: string, id?: string): Promise<Assignment> {
  const { start } = await json<{ start: readonly Assignment[] }>(
    fetch(new URL("/runner/work", server.url), {
      method: "POST",
      headers: runnerHeaders(token),
      body: JSON.stringify({ running: [], folders: [], models: [] }),
    }),
  );

  const assigned =
    id === undefined ? start[0] : start.find((each) => each.sessionId === id);

  if (assigned === undefined) {
    throw new Error("no Session was assigned");
  }

  return assigned;
}

async function toolsOf(
  token: string,
  { sessionId, generation }: Assignment,
): Promise<ToolSpec[]> {
  return json<ToolSpec[]>(
    fetch(
      new URL(
        `/runner/sessions/${sessionId}/tools?generation=${String(generation)}`,
        server.url,
      ),
      { headers: runnerHeaders(token) },
    ),
  );
}

async function question(
  token: string,
  { sessionId, generation }: Assignment,
  name: string,
  input: unknown,
): Promise<string | null> {
  const { question: asked } = await json<{ question: string | null }>(
    fetch(new URL(`/runner/sessions/${sessionId}/tool-questions`, server.url), {
      method: "POST",
      headers: runnerHeaders(token),
      body: JSON.stringify({ generation, name, input }),
    }),
  );

  return asked;
}

async function call(
  token: string,
  { sessionId, generation }: Assignment,
  name: string,
  input: unknown,
): Promise<ToolResult> {
  await fetch(new URL(`/runner/sessions/${sessionId}/tool-calls`, server.url), {
    method: "POST",
    headers: runnerHeaders(token),
    body: JSON.stringify({ generation, id: "call-1", name, input }),
  });

  const stream = await fetch(
    new URL(
      `/runner/sessions/${sessionId}/commands?generation=${String(generation)}`,
      server.url,
    ),
    { headers: runnerHeaders(token) },
  );

  for await (const command of readSse(stream, 3000)) {
    const sent = command as Command;

    if (sent.type === "tool_result") {
      return sent.result;
    }
  }

  throw new Error("no tool result");
}

test("checks a tool's params before it runs", async () => {
  const { token, environment } = await laptop();
  await ordinary(environment);
  const assigned = await claim(token);

  const refused = await call(token, assigned, "count_keys", { count: "two" });

  expect(refused.isError).toBe(true);
  expect(refused.text).toContain("count");
  expect(ran).toEqual([]);

  const counted = await claim(token).then(async (again) =>
    call(token, again, "count_keys", { count: 2 }),
  );

  expect(counted).toEqual({ text: "2 keys", isError: false });
  expect(ran).toEqual([{ count: 2 }]);
});

test("hands the model a ToolError's message, and only a plain failure for any other throw", async () => {
  const { token, environment } = await laptop();
  await ordinary(environment);

  const said = await call(token, await claim(token), "lose_key", {
    how: "said",
  });

  const crashed = await call(token, await claim(token), "lose_key", {
    how: "crash",
  });

  expect(said).toEqual({ text: "That key is gone already.", isError: true });
  expect(crashed).toEqual({ text: "The tool failed", isError: true });
  expect(server.logs.some((line) => line.includes("disk on fire"))).toBe(true);
});

test("leaves a team-only tool out of personal work", async () => {
  const { token, environment } = await laptop();
  await ordinary(environment);
  const assigned = await claim(token);

  const names = (await toolsOf(token, assigned)).map(({ name }) => name);

  expect(names).toContain("count_keys");
  expect(names).not.toContain("team_keys");

  expect(await call(token, assigned, "team_keys", {})).toEqual({
    text: "no tool named team_keys",
    isError: true,
  });
});

test("tells the Session what the system prompt says about a tool, and that it runs alone", async () => {
  const { token, environment } = await laptop();
  await ordinary(environment);
  const assigned = await claim(token);

  const count = (await toolsOf(token, assigned)).find(
    ({ name }) => name === "count_keys",
  );

  expect(count?.prompt).toEqual({
    snippet: "Count keys before you wipe them",
    guidelines: ["Count again after a wipe"],
  });

  expect(count?.sequential).toBe(true);
});

test("says a tool asks, and what to ask the person, before every call", async () => {
  const { token, environment } = await laptop();
  await ordinary(environment);
  const assigned = await claim(token);

  const wipe = (await toolsOf(token, assigned)).find(
    ({ name }) => name === "wipe_keys",
  );

  expect(wipe?.asks).toBe(true);

  expect(await question(token, assigned, "wipe_keys", { count: 3 })).toBe(
    "Wipe 3 keys of pedro?",
  );

  expect(await question(token, assigned, "count_keys", { count: 3 })).toBe(
    null,
  );
});

test("still asks the person before a tool whose question throws", async () => {
  const { token, environment } = await laptop();
  await ordinary(environment);
  const assigned = await claim(token);

  expect(await question(token, assigned, "burn_keys", {})).toBe(
    "Run burn_keys?",
  );

  expect(server.logs.some((line) => line.includes("lookup failed"))).toBe(true);
});

test("leaves out only the tool whose availability check throws", async () => {
  const { token, environment } = await laptop();
  await ordinary(environment);
  const assigned = await claim(token);

  const names = (await toolsOf(token, assigned)).map(({ name }) => name);

  expect(names).toContain("count_keys");
  expect(names).not.toContain("hidden_keys");

  expect(await call(token, assigned, "hidden_keys", {})).toEqual({
    text: "no tool named hidden_keys",
    isError: true,
  });

  expect(server.logs.some((line) => line.includes("availability broke"))).toBe(
    true,
  );
});

test("runs a team route's tool on the team's half in a team Session", async () => {
  const office = await json<{ id: string; key: string }>(
    server.api("/api/environments", { body: { name: "office", team: true } }),
  );

  const { token } = await json<{ token: string }>(
    fetch(new URL("/runner/join", server.url), {
      method: "POST",
      headers: runnerHeaders(office.key),
      body: JSON.stringify({ name: "office" }),
    }),
  );

  const session = await json<Session>(
    server.api("/api/ext/lists/planners", { body: { environment: office.id } }),
  );

  expect(session.ownedBy).toBe("team");

  const assigned = await claim(token, session.id);

  expect(
    (await toolsOf(token, assigned)).filter(
      ({ name }) => name === "lists_read",
    ),
  ).toHaveLength(1);

  expect(await call(token, assigned, "lists_read", {})).toEqual({
    text: JSON.stringify({ owner: "team" }),
    isError: false,
  });
});

test("loads every route tool only in Sessions on a Profile that asks for them", async () => {
  const { token, environment } = await laptop();
  await ordinary(environment);
  const plain = await toolsOf(token, await claim(token));

  const session = await json<Session>(
    server.api("/api/ext/keys/desks", { body: { environment } }),
  );

  const assigned = await claim(token, session.id);
  const loaded = await toolsOf(token, assigned);

  const names = loaded.map(({ name }) => name);

  expect(plain.map(({ name }) => name)).not.toContain("sessions_list");
  expect(names).toContain("sessions_list");
  expect(names).toContain("keys_put");
  expect(names).not.toContain("profiles_upload");

  expect(loaded.find(({ name }) => name === "keys_put")?.asks).toBe(true);

  expect(loaded.find(({ name }) => name === "sessions_list")?.asks).toBe(
    undefined,
  );

  expect(
    await question(token, assigned, "keys_put", { name: "front", value: "x" }),
  ).toBe("Put the key front?");

  expect(
    await call(token, assigned, "keys_put", { name: "front", value: "x" }),
  ).toEqual({
    text: JSON.stringify({ name: "front", value: "x", by: "pedro" }),
    isError: false,
  });
});

test("serves a plugin's route tools to MCP clients, as the token's person", async () => {
  const { secret } = await json<{ secret: string }>(
    server.api("/api/me/access-tokens", { body: { name: "editor" } }),
  );

  const rpc = async (method: string, params?: unknown): Promise<unknown> => {
    const { result } = await json<{ result: unknown }>(
      fetch(new URL("/api/mcp", server.url), {
        method: "POST",
        headers: {
          authorization: `Bearer ${secret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      }),
    );

    return result;
  };

  const { tools } = (await rpc("tools/list")) as {
    tools: { name: string; annotations?: unknown }[];
  };

  expect(tools.find(({ name }) => name === "keys_list")).toMatchObject({
    annotations: { readOnlyHint: true },
  });

  expect(tools.map(({ name }) => name)).not.toContain("count_keys");

  expect(
    await rpc("tools/call", {
      name: "keys_put",
      arguments: { name: "back", value: "y" },
    }),
  ).toEqual({
    content: [
      {
        type: "text",
        text: JSON.stringify({ name: "back", value: "y", by: "pedro" }),
      },
    ],
    isError: false,
  });
});
