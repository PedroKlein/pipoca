import { expect, test } from "bun:test";
import {
  type PluginTest,
  person,
  type TestPluginOptions,
  testPlugin,
  until,
} from "@pipoca/testing";
import type { Environment, Profile } from "@pipoca/protocol";
import type { Account, Connectable } from "./model";
import { server } from "./server";

const people = [
  { id: "admin", name: "Admin", admin: true },
  { id: "ana", name: "Ana" },
  { id: "bo", name: "Bo" },
];

async function started(
  o: Omit<TestPluginOptions, "people"> = {},
): Promise<PluginTest> {
  return testPlugin(server, { people, ...o });
}

const nobody = { admin: false, logins: [], mcp: [], servers: [] };

async function account(t: PluginTest, id: string): Promise<Account> {
  return t.as(id).get<Account>("account");
}

async function save(
  t: PluginTest,
  id: string,
  provider: string,
  key: string,
  layer?: string,
): Promise<Response> {
  return t.as(id).raw("save", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      provider,
      credential: { type: "api_key", key },
      ...(layer !== undefined && { layer }),
    }),
  });
}

// A person's Profile on the kernel's own routes.
async function profile(
  t: PluginTest,
  id: string,
  content: Readonly<Record<string, unknown>>,
): Promise<string> {
  const created = await t
    .as(id)
    .raw("/api/profiles", { method: "POST", body: JSON.stringify(content) });

  expect(created.status).toBe(201);

  return ((await created.json()) as Profile).id;
}

// Pi's providers load in the background when the plugin registers.
async function connectable(t: PluginTest): Promise<readonly Connectable[]> {
  return until(
    async () => t.as("ana").get<readonly Connectable[]>("providers"),
    (providers) => providers.length > 0,
  );
}

test("a person sees their own logins and can log out of one", async () => {
  await using t = await started();
  const ana = await t.session({ owner: person("ana") });

  for (const provider of ["anthropic", "openai"]) {
    const { lease } = await ana.api.post<{ lease: string }>(
      `credentials/${provider}/lock`,
    );

    await ana.api.post(`credentials/${provider}/release`, {
      lease,
      value: { type: "api_key", key: "sk" },
    });
  }

  expect(await account(t, "ana")).toMatchObject({
    logins: [
      { provider: "anthropic", type: "api_key", layer: "defaults" },
      { provider: "openai", type: "api_key", layer: "defaults" },
    ],
  });

  expect(await t.as("ana").delete("credentials/anthropic")).toMatchObject({
    logins: [{ provider: "openai" }],
  });

  expect(await account(t, "bo")).toEqual(nobody);
});

test("a person logs out of an MCP server by its name and address", async () => {
  await using t = await started();
  const ana = await t.session({ owner: person("ana") });
  const key = encodeURIComponent("linear https://mcp.linear.app/mcp");

  const { lease } = await ana.api.post<{ lease: string }>(`mcp/${key}/lock`);
  await ana.api.post(`mcp/${key}/release`, { lease, value: { tokens: {} } });

  expect(await account(t, "ana")).toMatchObject({
    mcp: [{ server: "linear https://mcp.linear.app/mcp" }],
  });

  expect(await t.as("ana").delete(`mcp/${key}`)).toEqual(nobody);
});

test("a person saves a login, such as an API key, that their Sessions read", async () => {
  await using t = await started();

  expect(await (await save(t, "ana", "openai", "sk")).json()).toMatchObject({
    logins: [{ provider: "openai", type: "api_key" }],
  });

  const ana = await t.session({ owner: person("ana") });
  const bo = await t.session({ owner: person("bo") });

  expect(await ana.api.get("credentials/values")).toEqual({
    openai: { type: "api_key", key: "sk" },
  });

  expect(await ana.api.get("credentials")).toEqual([
    { key: "openai", type: "api_key" },
  ]);

  expect(await bo.api.get("credentials/values")).toEqual({});
});

test("a Session reads the nearest layer's login: its Profile's, the one it builds on, My defaults, then the base", async () => {
  await using t = await started();

  const research = await profile(t, "ana", { name: "Research" });
  const deep = await profile(t, "ana", { name: "Deep", buildsOn: research });
  const other = await profile(t, "ana", { name: "Other" });

  expect((await save(t, "admin", "openai", "team", "base")).status).toBe(200);
  expect((await save(t, "ana", "anthropic", "mine")).status).toBe(200);

  expect(
    (await save(t, "ana", "anthropic", "research", `profile:${research}`))
      .status,
  ).toBe(200);

  const onDeep = await t.session({ owner: person("ana"), profile: deep });
  const onOther = await t.session({ owner: person("ana"), profile: other });

  expect(await onDeep.api.get("credentials/values")).toEqual({
    anthropic: { type: "api_key", key: "research" },
    openai: { type: "api_key", key: "team" },
  });

  expect(await onOther.api.get("credentials/values")).toEqual({
    anthropic: { type: "api_key", key: "mine" },
    openai: { type: "api_key", key: "team" },
  });

  expect((await account(t, "ana")).logins).toMatchObject([
    { provider: "anthropic", layer: "defaults" },
    { provider: "anthropic", layer: `profile:${research}` },
    { provider: "openai", layer: "base" },
  ]);

  // Removing the Profile's own login inherits the one below it.
  await t.as("ana").delete("credentials/anthropic", {
    layer: `profile:${research}`,
  });

  expect(await onDeep.api.get("credentials/values")).toMatchObject({
    anthropic: { type: "api_key", key: "mine" },
  });
});

test("only admins put a login on the base, and only an API key", async () => {
  await using t = await started();

  expect((await save(t, "ana", "anthropic", "sk", "base")).status).toBe(403);

  const oauth = await t.as("admin").raw("save", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      provider: "anthropic",
      credential: { type: "oauth", access: "a", refresh: "r", expires: 0 },
      layer: "base",
    }),
  });

  expect(oauth.status).toBe(403);

  expect((await save(t, "ana", "anthropic", "sk", "elsewhere")).status).toBe(
    400,
  );
});

test("a team Session gets no one's logins, not even its starter's", async () => {
  await using t = await started();
  await save(t, "ana", "anthropic", "sk");

  const team = await t.session({ owner: "team", startedBy: "ana" });

  expect(await team.api.get("credentials")).toEqual([]);
  expect(await team.api.get("mcp")).toEqual([]);

  const locked = await team.api.raw("credentials/anthropic/lock", {
    method: "POST",
  });

  expect(locked.status).toBe(403);
});

test("a Session that refreshes a login from the base keeps its own copy in My defaults", async () => {
  await using t = await started();
  await save(t, "admin", "openai", "team", "base");

  const ana = await t.session({ owner: person("ana") });
  const bo = await t.session({ owner: person("bo") });

  const { lease, value } = await ana.api.post<{
    lease: string;
    value: unknown;
  }>("credentials/openai/lock");

  expect(value).toEqual({ type: "api_key", key: "team" });

  await ana.api.post("credentials/openai/release", {
    lease,
    value: { type: "api_key", key: "rotated" },
  });

  expect(await ana.api.get("credentials/values")).toEqual({
    openai: { type: "api_key", key: "rotated" },
  });

  expect(await bo.api.get("credentials/values")).toEqual({
    openai: { type: "api_key", key: "team" },
  });
});

test("a write without the lease is refused, and so is a login that isn't one", async () => {
  await using t = await started();
  const ana = await t.session({ owner: person("ana") });

  const refused = await ana.api.raw("credentials/anthropic/release", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      lease: "made-up",
      value: { type: "api_key", key: "sk" },
    }),
  });

  expect({ status: refused.status, body: await refused.json() }).toEqual({
    status: 409,
    body: {
      error: "lease_lapsed",
      message: "the lease lapsed, so this write could undo another",
    },
  });

  const { lease } = await ana.api.post<{ lease: string }>(
    "credentials/anthropic/lock",
  );

  const wrong = await ana.api.raw("credentials/anthropic/release", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ lease, value: { key: "sk" } }),
  });

  expect(wrong.status).toBe(400);
});

test("a person is offered Pi's models of the providers they logged in to, and a team Environment the team's", async () => {
  await using t = await started();
  await save(t, "ana", "anthropic", "sk");
  await save(t, "admin", "openai", "sk-team", "base");

  await t.as("ana").raw("/api/environments", {
    method: "POST",
    body: JSON.stringify({ name: "mine" }),
  });

  await t.as("admin").raw("/api/environments", {
    method: "POST",
    body: JSON.stringify({
      name: "shared",
      team: true,
    }),
  });

  const offered = async (id: string, name: string, scope: string) =>
    until(
      async () =>
        (
          (await (
            await t
              .as(id)
              .raw(`/api/environments?scope=${scope}`, { method: "GET" })
          ).json()) as readonly Environment[]
        ).find((each) => each.name === name)?.models ?? [],
      (models) => models.length > 0,
    );

  const mine = await offered("ana", "mine", "mine");

  // The base's key reaches everyone's own work too.
  expect([...new Set(mine.map(({ provider }) => provider))].sort()).toEqual([
    "anthropic",
    "openai",
  ]);

  const team = await offered("admin", "shared", "team");

  expect([...new Set(team.map(({ provider }) => provider))]).toEqual([
    "openai",
  ]);

  await t.as("bo").raw("/api/environments", {
    method: "POST",
    body: JSON.stringify({ name: "bos" }),
  });

  const bos = await offered("bo", "bos", "mine");

  expect([...new Set(bos.map(({ provider }) => provider))]).toEqual(["openai"]);
});

test("a person connects a provider from Settings by answering Pi's prompts", async () => {
  await using t = await started();

  expect(
    (await connectable(t)).find(({ id }) => id === "openai")?.methods,
  ).toContainEqual({ type: "api_key", label: "API key" });

  await t.as("ana").post("connect", { provider: "openai", type: "api_key" });

  const asked = await until(
    async () => account(t, "ana"),
    ({ connection }) => connection?.prompt !== undefined,
  );

  expect(asked.connection?.prompt).toMatchObject({ type: "secret" });

  await t.as("ana").post("connection/answer", {
    prompt: asked.connection?.prompt?.id,
    answer: "sk-ana",
  });

  const done = await until(
    async () => account(t, "ana"),
    ({ connection }) => connection?.state !== "running",
  );

  expect(done.connection?.state).toBe("done");
  expect(done.logins).toMatchObject([{ provider: "openai", type: "api_key" }]);

  const ana = await t.session({ owner: person("ana") });

  expect(await ana.api.get("credentials/values")).toEqual({
    openai: { type: "api_key", key: "sk-ana" },
  });

  expect(await account(t, "bo")).toEqual(nobody);
});

test("a person dismisses a sign-in and it stops asking", async () => {
  await using t = await started();
  await connectable(t);

  await t.as("ana").post("connect", { provider: "openai", type: "api_key" });

  const asked = await until(
    async () => account(t, "ana"),
    ({ connection }) => connection?.prompt !== undefined,
  );

  expect(await t.as("ana").delete("connection")).toEqual(nobody);

  const late = await t.as("ana").raw("connection/answer", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      prompt: asked.connection?.prompt?.id,
      answer: "sk-ana",
    }),
  });

  expect({ status: late.status, body: await late.json() }).toEqual({
    status: 409,
    body: {
      error: "not_asked",
      message: "the sign-in isn't waiting for that answer",
    },
  });
});

test("a sign-in a provider doesn't take is refused", async () => {
  await using t = await started();
  await connectable(t);

  const refused = await t.as("ana").raw("connect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "openai-codex", type: "api_key" }),
  });

  expect(refused.status).toBe(400);
});

// An MCP server with its own authorization server, which registers any
// client and swaps the code "granted" for tokens.
function oauthServer(): AsyncDisposable & { readonly url: string } {
  const listening: Bun.Server<undefined> = Bun.serve({
    port: 0,
    fetch: async (request): Promise<Response> => {
      const { pathname } = new URL(request.url);
      const origin = listening.url.origin;

      if (pathname.startsWith("/.well-known/oauth-protected-resource")) {
        return Response.json({
          resource: `${origin}/mcp`,
          authorization_servers: [origin],
        });
      }

      if (
        pathname.startsWith("/.well-known/oauth-authorization-server") ||
        pathname.startsWith("/.well-known/openid-configuration")
      ) {
        return Response.json({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        });
      }

      if (pathname === "/register") {
        const metadata = (await request.json()) as Record<string, unknown>;

        return Response.json(
          { ...metadata, client_id: "client-1" },
          { status: 201 },
        );
      }

      if (pathname === "/token") {
        const params = new URLSearchParams(await request.text());

        return params.get("code") === "granted"
          ? Response.json({
              access_token: "access-1",
              refresh_token: "refresh-1",
              token_type: "Bearer",
              expires_in: 3600,
            })
          : Response.json({ error: "invalid_grant" }, { status: 400 });
      }

      return new Response("unauthorized", {
        status: 401,
        headers: {
          "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
        },
      });
    },
  });

  return {
    url: `${listening.url.origin}/mcp`,
    [Symbol.asyncDispose]: async () => listening.stop(true),
  };
}

// The test's MCP server listens on a loopback address, which an admin lets
// sign-ins reach.
async function allowing(url: string): Promise<PluginTest> {
  return started({ config: { privateHosts: [new URL(url).host] } });
}

// A Profile's MCP server address can't make the server probe its own
// network, such as the cluster's Services.
test("signs in to an MCP server on a private address only when an admin allows its host", async () => {
  await using linear = oauthServer();
  await using t = await started();

  await profile(t, "ana", {
    name: "Tools",
    mcpServers: { linear: { url: linear.url } },
  });

  await t.as("ana").post("connect-mcp", { server: `linear ${linear.url}` });

  const done = await until(
    async () => account(t, "ana"),
    ({ connection }) => connection?.state !== "running",
  );

  expect(done.connection).toMatchObject({ state: "failed" });
  expect(JSON.stringify(done.connection)).toContain("private address");
  expect(done.mcp).toEqual([]);
});

test("a person signs in to an MCP server of their Profiles from Settings, and the sign-in page sends them back to Pipoca", async () => {
  await using linear = oauthServer();
  await using t = await allowing(linear.url);

  await profile(t, "ana", {
    name: "Tools",
    mcpServers: {
      linear: { url: linear.url },
      local: { command: "linear-mcp" },
    },
  });

  const key = `linear ${linear.url}`;

  expect((await account(t, "ana")).servers).toEqual([
    { key, name: "linear", url: linear.url },
  ]);

  const begun = await t.as("ana").raw("connect-mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ server: key }),
  });

  const cookie = (begun.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

  expect(cookie).toStartWith("browser-");

  const asked = await until(
    async () => account(t, "ana"),
    ({ connection }) =>
      (connection?.events ?? []).some(({ type }) => type === "auth_url"),
  );

  const event = asked.connection?.events.find(
    ({ type }) => type === "auth_url",
  );

  const page = new URL(event?.type === "auth_url" ? event.url : "");
  const back = new URL(page.searchParams.get("redirect_uri") ?? "");

  expect(back.pathname).toBe("/api/ext/logins/callback");

  const query = new URLSearchParams({
    code: "granted",
    state: page.searchParams.get("state") ?? "",
  }).toString();

  // Another browser can't finish it with the same link.
  expect(
    (await t.public().raw(`callback?${query}`, { method: "GET" })).status,
  ).toBe(400);

  const returned = await t
    .public()
    .raw(`callback?${query}`, { method: "GET", headers: { cookie } });

  expect(returned.status).toBe(200);

  const done = await until(
    async () => account(t, "ana"),
    ({ connection }) => connection?.state !== "running",
  );

  expect(done.connection).toMatchObject({ state: "done" });
  expect(done.mcp).toMatchObject([{ server: key }]);

  const ana = await t.session({ owner: person("ana") });

  expect(await ana.api.get("mcp/values")).toMatchObject({
    [key]: { tokens: { access_token: "access-1", refresh_token: "refresh-1" } },
  });
});

test("a client registered for a loopback address signs in with the address the person pastes", async () => {
  await using linear = oauthServer();
  await using t = await allowing(linear.url);

  await profile(t, "ana", {
    name: "Tools",
    mcpServers: {
      linear: {
        url: linear.url,
        oauth: { clientId: "registered", callbackPort: 8123 },
      },
      secret: { url: linear.url, oauth: { clientSecret: "${SECRET}" } },
    },
  });

  const key = `linear ${linear.url}`;

  await t.as("ana").post("connect-mcp", { server: key });

  const asked = await until(
    async () => account(t, "ana"),
    ({ connection }) => connection?.prompt !== undefined,
  );

  expect(asked.servers.map(({ name }) => name)).toEqual(["linear"]);
  expect(asked.connection?.prompt).toMatchObject({ type: "manual_code" });

  const event = asked.connection?.events.find(
    ({ type }) => type === "auth_url",
  );

  const page = new URL(event?.type === "auth_url" ? event.url : "");

  expect(page.searchParams.get("client_id")).toBe("registered");

  expect(page.searchParams.get("redirect_uri")).toBe(
    "http://127.0.0.1:8123/callback",
  );

  await t.as("ana").post("connection/answer", {
    prompt: asked.connection?.prompt?.id,
    answer: `http://127.0.0.1:8123/callback?code=granted&state=${page.searchParams.get("state") ?? ""}`,
  });

  const done = await until(
    async () => account(t, "ana"),
    ({ connection }) => connection?.state !== "running",
  );

  expect(done.connection).toMatchObject({ state: "done" });
  expect(done.mcp).toMatchObject([{ server: key }]);
});

interface Proxy {
  readonly providers: readonly {
    readonly provider: string;
    readonly baseUrl: string;
  }[];
  readonly token?: string;
}

// The team's key for provider, and a team Session once its proxy is ready.
async function teamWith(t: PluginTest, provider: string) {
  expect((await save(t, "admin", provider, "sk-team", "base")).status).toBe(
    200,
  );

  const team = await t.session({ owner: "team", startedBy: "ana" });

  const proxy = await until(
    async () => team.api.get<Proxy>("proxy"),
    ({ providers }) => providers.length > 0,
  );

  return { team, proxy };
}

const sse = (...events: unknown[]): string =>
  events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");

test("a team Session calls the team's provider through the proxy, with a token in place of the key", async () => {
  const upstream: Request[] = [];

  await using t = await started({
    fetch: (request) => {
      upstream.push(request);

      return new Response("data: {}\n\n", {
        headers: {
          "content-type": "text/event-stream",
          "content-encoding": "gzip",
        },
      });
    },
  });

  const { proxy } = await teamWith(t, "anthropic");

  expect(
    proxy.providers.find(({ provider }) => provider === "anthropic")?.baseUrl,
  ).toEndWith("/api/ext/logins/proxy/anthropic");

  const answer = await t.public().raw("proxy/anthropic/v1/messages?beta=true", {
    method: "POST",
    headers: {
      "x-api-key": proxy.token ?? "",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: "claude", stream: true }),
  });

  expect(answer.status).toBe(200);
  expect(await answer.text()).toBe("data: {}\n\n");
  expect(answer.headers.get("content-encoding")).toBeNull();

  const [sent] = upstream;

  expect(sent?.url).toBe("https://api.anthropic.com/v1/messages?beta=true");
  expect(sent?.headers.get("x-api-key")).toBe("sk-team");
  expect(await sent?.json()).toEqual({ model: "claude", stream: true });
});

test("the proxy refuses a token that isn't a live team Session's", async () => {
  await using t = await started({
    fetch: () => new Response("{}"),
  });

  const { team, proxy } = await teamWith(t, "anthropic");

  const statusOf = async (token: string) =>
    (
      await t.public().raw("proxy/anthropic/v1/messages", {
        method: "POST",
        headers: { "x-api-key": token },
        body: "{}",
      })
    ).status;

  expect(await statusOf(proxy.token ?? "")).toBe(200);
  expect(await statusOf("ppx_made_up")).toBe(401);

  await team.archive();

  expect(await statusOf(proxy.token ?? "")).toBe(401);
});

test("a personal Session gets no proxy, since its own logins reach only its runner", async () => {
  await using t = await started();
  const ana = await t.session({ owner: person("ana") });

  expect(await ana.api.get("proxy")).toEqual({ providers: [] });
});

// What the proxy reports for an upstream that answers with the body given.
async function reported(answer: string, path: string, body: unknown) {
  await using t = await started({
    fetch: () =>
      new Response(answer, {
        headers: { "content-type": "text/event-stream" },
      }),
  });

  const { team, proxy } = await teamWith(t, path.split("/")[0] ?? "");
  const token = proxy.token ?? "";

  const response = await t.public().raw(`proxy/${path}`, {
    method: "POST",
    headers: {
      "x-api-key": token,
      "x-goog-api-key": token,
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  expect(await response.text()).toBe(answer);

  const [called] = await until(
    () => t.emitted("logins.model_called"),
    (found) => found.length > 0,
  );

  return { called, team };
}

test("the proxy reports the tokens an Anthropic stream used, to the team", async () => {
  const { called, team } = await reported(
    sse(
      {
        type: "message_start",
        message: {
          usage: {
            input_tokens: 11,
            cache_read_input_tokens: 4,
            output_tokens: 1,
          },
        },
      },
      { type: "message_delta", usage: { output_tokens: 7 } },
    ),
    "anthropic/v1/messages",
    { model: "claude-sonnet-4-5", stream: true },
  );

  expect(called).toEqual({
    fields: {
      sessionId: team.id,
      person: "ana",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      input: 15,
      output: 7,
    },
    to: ["team"],
  });
});

test("the proxy reads OpenAI's and Google's token reports too", async () => {
  const openai = await reported(
    sse(
      { type: "response.created", response: { usage: null } },
      {
        type: "response.completed",
        response: { usage: { input_tokens: 12, output_tokens: 8 } },
      },
    ),
    "openai/responses",
    { model: "gpt-5", stream: true },
  );

  const google = await reported(
    sse(
      { usageMetadata: { promptTokenCount: 13 } },
      {
        usageMetadata: {
          promptTokenCount: 13,
          candidatesTokenCount: 6,
          thoughtsTokenCount: 3,
        },
      },
    ),
    "google/models/gemini-2.5-flash:streamGenerateContent",
    {},
  );

  expect(openai.called?.fields).toMatchObject({
    model: "gpt-5",
    input: 12,
    output: 8,
  });

  expect(google.called?.fields).toMatchObject({
    model: "gemini-2.5-flash",
    input: 13,
    output: 9,
  });
});

test("an admin sees which of the team's keys reach models only through the server", async () => {
  await using t = await started();

  await save(t, "admin", "my-extension", "sk-team", "base");
  await teamWith(t, "anthropic");

  expect((await t.as("ana").raw("keys", { method: "GET" })).status).toBe(403);

  expect(await t.as("admin").get("keys")).toEqual([
    { provider: "anthropic", proxied: true },
    { provider: "my-extension", proxied: false },
  ]);
});

test("a team Session reads the base's keys the proxy can't carry, and only those", async () => {
  await using t = await started();

  await save(t, "admin", "sap-ai-core", "sap-ai-core-key", "base");
  const { team } = await teamWith(t, "anthropic");

  expect(await team.api.get("credentials")).toEqual([
    { key: "sap-ai-core", type: "api_key" },
  ]);

  expect(await team.api.get("credentials/values")).toEqual({
    "sap-ai-core": { type: "api_key", key: "sap-ai-core-key" },
  });

  const locked = await team.api.raw("credentials/sap-ai-core/lock", {
    method: "POST",
  });

  expect(locked.status).toBe(403);
  expect(await team.api.get("mcp")).toEqual([]);
});

test("a Session can't call a person's routes, and a person can't call a Session's", async () => {
  await using t = await started();
  const ana = await t.session({ owner: person("ana") });

  expect((await ana.api.raw("account")).status).toBe(403);

  expect(
    (await t.as("ana").raw("credentials/values", { method: "GET" })).status,
  ).toBe(403);
});

test("the proxy reports what a stream cut off midway counted so far", async () => {
  const opening = sse({
    type: "message_start",
    message: { usage: { input_tokens: 20, output_tokens: 1 } },
  });

  let pulls = 0;

  await using t = await started({
    fetch: () =>
      new Response(
        new ReadableStream({
          pull: async (controller) => {
            pulls += 1;

            if (pulls === 1) {
              controller.enqueue(new TextEncoder().encode(opening));

              return;
            }

            await new Promise((resolve) => setTimeout(resolve, 50));
            controller.error(new Error("the person stopped the turn"));
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  });

  const { proxy } = await teamWith(t, "anthropic");

  await t
    .public()
    .raw("proxy/anthropic/v1/messages", {
      method: "POST",
      headers: { "x-api-key": proxy.token ?? "" },
      body: JSON.stringify({ model: "claude-sonnet-4-5", stream: true }),
    })
    .then(async (response) => response.text())
    .catch(() => "");

  const [called] = await until(
    () => t.emitted("logins.model_called"),
    (found) => found.length > 0,
    2000,
  );

  expect(called?.fields).toMatchObject({
    model: "claude-sonnet-4-5",
    input: 20,
    output: 1,
  });
});
