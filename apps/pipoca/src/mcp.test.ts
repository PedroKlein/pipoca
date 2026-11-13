import { afterEach, beforeEach, expect, test } from "bun:test";
import { testServer, type TestServer } from "./testdata/harness";

let server: TestServer;

beforeEach(() => {
  server = testServer({
    runners: { pollWaitMs: 0 },
  });
});

afterEach(async () => {
  await server.close();
});

async function newToken(name = "Claude Code"): Promise<{
  id: string;
  name: string;
  secret: string;
}> {
  const response = await server.api("/api/me/access-tokens", {
    body: { name },
  });

  expect(response.status).toBe(201);

  return (await response.json()) as {
    id: string;
    name: string;
    secret: string;
  };
}

let nextId = 1;

async function rpc(
  secret: string,
  method: string,
  params?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(new URL("/api/mcp", server.url), {
    method: "POST",
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: nextId++,
      method,
      ...(params !== undefined && { params }),
    }),
  });
}

async function result<T>(response: Promise<Response>): Promise<T> {
  const { result: value, error } = (await (await response).json()) as {
    result?: T;
    error?: unknown;
  };

  if (error !== undefined) {
    throw new Error(JSON.stringify(error));
  }

  return value as T;
}

interface ToolsList {
  readonly tools: readonly {
    readonly name: string;
    readonly inputSchema: unknown;
    readonly annotations?: Record<string, boolean>;
  }[];
}

interface CallResult {
  readonly content: readonly { readonly type: string; readonly text: string }[];
  readonly isError: boolean;
}

test("serves the meta toolsets to an MCP client with a token", async () => {
  const { secret } = await newToken();

  const initialized = await result<{
    protocolVersion: string;
    capabilities: unknown;
  }>(
    rpc(secret, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    }),
  );

  const notified = await fetch(new URL("/api/mcp", server.url), {
    method: "POST",
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    }),
  });

  const { tools } = await result<ToolsList>(rpc(secret, "tools/list"));
  const archive = tools.find(({ name }) => name === "sessions_archive");

  expect(initialized).toMatchObject({
    protocolVersion: "2025-06-18",
    capabilities: { tools: {} },
  });

  expect(notified.status).toBe(202);
  expect(tools.map(({ name }) => name)).toContain("projects_create");
  expect(archive?.annotations).toEqual({ destructiveHint: true });
  expect(archive?.inputSchema).toMatchObject({ required: ["id"] });

  expect(
    tools.every((tool) =>
      Object.values(tool).every((value) => typeof value !== "function"),
    ),
  ).toBe(true);
});

test("lists the kernel's route tools by the names the meta toolsets had, and none that only plugins call", async () => {
  const { secret } = await newToken();
  const { tools } = await result<ToolsList>(rpc(secret, "tools/list"));

  expect(tools.map(({ name }) => name).sort()).toEqual([
    "environments_create",
    "environments_list",
    "environments_update",
    "plugins_files",
    "plugins_list",
    "plugins_read_file",
    "profile_defaults_files",
    "profile_defaults_get",
    "profiles_create",
    "profiles_get",
    "profiles_list",
    "profiles_make_default",
    "profiles_update",
    "projects_archive",
    "projects_create",
    "projects_get",
    "projects_list",
    "projects_update",
    "sessions_archive",
    "sessions_get",
    "sessions_list",
    "sessions_open",
    "sessions_start",
  ]);
});

test("runs a tool as the token's user, through the same route", async () => {
  const { secret } = await newToken();

  const created = await result<CallResult>(
    rpc(secret, "tools/call", {
      name: "environments_create",
      arguments: { name: "lab" },
    }),
  );

  const refused = await result<CallResult>(
    rpc(secret, "tools/call", {
      name: "environments_create",
      arguments: { name: " " },
    }),
  );

  const environments = (await (
    await server.api("/api/environments")
  ).json()) as { name: string }[];

  expect(created.isError).toBe(false);
  expect(created.content[0]?.text).toContain("Replace key");
  expect(created.content[0]?.text).not.toContain("pck_");
  expect(environments.map(({ name }) => name)).toContain("lab");
  expect(refused.isError).toBe(true);
});

test("lets a revoked token, a missing one or another site's page in no more", async () => {
  const token = await newToken();
  const { secret } = token;

  const listed = await (await server.api("/api/me/access-tokens")).json();

  const foreign = await rpc(secret, "ping", undefined, {
    origin: "https://evil.example",
  });

  const revoked = await server.api(`/api/me/access-tokens/${token.id}`, {
    method: "DELETE",
  });

  const after = await rpc(secret, "ping");
  const missing = await rpc("pcm_unknown", "ping");
  const streamed = await fetch(new URL("/api/mcp", server.url));

  const again = await server.api(`/api/me/access-tokens/${token.id}`, {
    method: "DELETE",
  });

  expect(listed).toMatchObject([{ id: token.id, name: "Claude Code" }]);

  expect(JSON.stringify(listed)).not.toContain(secret);
  expect(foreign.status).toBe(403);
  expect(revoked.status).toBe(204);
  expect(after.status).toBe(401);
  expect(missing.status).toBe(401);
  expect(streamed.status).toBe(405);
  expect(again.status).toBe(404);
});

test("answers an unknown method with a JSON-RPC error", async () => {
  const { secret } = await newToken();

  const body = (await (await rpc(secret, "resources/list")).json()) as {
    error?: { code: number };
  };

  expect(body.error?.code).toBe(-32601);
});

test("agrees on a protocol version the client knows", async () => {
  const { secret } = await newToken();

  const initialize = async (protocolVersion: string): Promise<string> =>
    (
      await result<{ protocolVersion: string }>(
        rpc(secret, "initialize", { protocolVersion, capabilities: {} }),
      )
    ).protocolVersion;

  expect(await initialize("2025-03-26")).toBe("2025-03-26");
  expect(await initialize("1999-01-01")).toBe("2025-06-18");
});

test("answers bad requests with JSON-RPC errors and unknown tools as failed calls", async () => {
  const { secret } = await newToken();

  const post = async (body: string): Promise<{ error?: { code: number } }> =>
    (await (
      await fetch(new URL("/api/mcp", server.url), {
        method: "POST",
        headers: {
          authorization: `bearer  ${secret}`,
          "content-type": "application/json",
        },
        body,
      })
    ).json()) as { error?: { code: number } };

  const unnamed = (await (await rpc(secret, "tools/call", {})).json()) as {
    error?: { code: number };
  };

  const unknown = await result<CallResult>(
    rpc(secret, "tools/call", { name: "nothing_here", arguments: {} }),
  );

  expect((await post("{")).error?.code).toBe(-32700);
  expect((await post('{"jsonrpc":"2.0","id":1}')).error?.code).toBe(-32600);

  expect(
    (await post('[{"jsonrpc":"2.0","id":1,"method":"ping"}]')).error?.code,
  ).toBe(-32600);

  expect(unnamed.error?.code).toBe(-32602);
  expect(unknown.isError).toBe(true);
});

test("lists Profiles with what each is for, without their content", async () => {
  const { secret } = await newToken();

  const created = await result<CallResult>(
    rpc(secret, "tools/call", {
      name: "profiles_create",
      arguments: {
        name: "Cluster ops",
        description: "kubectl, helm and the cluster skills",
        agentsMd: "Never delete a namespace.",
      },
    }),
  );

  const listed = await result<CallResult>(
    rpc(secret, "tools/call", { name: "profiles_list", arguments: {} }),
  );

  const profiles = JSON.parse(listed.content[0]?.text ?? "[]") as unknown;

  expect(created.isError).toBe(false);

  expect(profiles).toEqual([
    {
      id: "default",
      name: "Default",
      description: "",
      isDefault: true,
      shared: true,
      buildsOn: null,
    },
    {
      id: "cluster-ops",
      name: "Cluster ops",
      description: "kubectl, helm and the cluster skills",
      isDefault: false,
      shared: false,
      buildsOn: null,
    },
  ]);
});
