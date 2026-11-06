import { expect, test } from "bun:test";
import type { Credential, CredentialStore } from "@earendil-works/pi-ai";
import type { McpLoginState, SessionLogins } from "@pipoca/plugins";
import {
  type PluginTest,
  person,
  testPlugin,
  testSession,
  until,
} from "@pipoca/testing";
import { server } from "./server";
import { session } from "./session";

const people = [
  { id: "admin", name: "Admin", admin: true },
  { id: "ana", name: "Ana" },
  { id: "bo", name: "Bo" },
];

// A runner's Session of the person, its logins kept on the test's server.
async function runner(t: PluginTest, id: string): Promise<SessionLogins> {
  const started = await t.session({ owner: person(id) });
  const part = await testSession(session, { request: started.request });
  const logins = await part.modelCredentials();

  if (logins === undefined) {
    throw new Error("the Session part keeps no logins");
  }

  return logins;
}

const oauth = (access: string): Credential => ({
  type: "oauth",
  access,
  refresh: `refresh-${access}`,
  expires: 0,
});

test("a login made on one runner is there on another, for its owner only", async () => {
  await using t = await testPlugin(server, { people });

  await (
    await runner(t, "ana")
  ).models.modify("openai-codex", async () => Promise.resolve(oauth("a1")));

  const other = await runner(t, "ana");

  expect(await other.models.read("openai-codex")).toEqual(oauth("a1"));

  expect(await other.models.list()).toEqual([
    { providerId: "openai-codex", type: "oauth" },
  ]);

  const bo = await runner(t, "bo");

  expect(await bo.models.read("openai-codex")).toBeUndefined();
  expect(await bo.models.list()).toEqual([]);
});

test("runners refresh one login one at a time, each seeing the last write", async () => {
  await using t = await testPlugin(server, { people });

  await (
    await runner(t, "ana")
  ).models.modify("openai-codex", async () => Promise.resolve(oauth("t0")));

  const seen: string[] = [];

  const refresh = async (store: CredentialStore): Promise<void> => {
    await store.modify("openai-codex", async (current) => {
      const access = current?.type === "oauth" ? current.access : "none";
      seen.push(access);
      await Bun.sleep(20);

      return oauth(`${access}+`);
    });
  };

  const [first, second] = [await runner(t, "ana"), await runner(t, "ana")];

  await Promise.all([refresh(first.models), refresh(second.models)]);

  expect(seen).toEqual(["t0", "t0+"]);

  expect(await (await runner(t, "ana")).models.read("openai-codex")).toEqual(
    oauth("t0++"),
  );
});

test("a failed refresh lets go of the login and keeps it", async () => {
  await using t = await testPlugin(server, { people });
  const { models } = await runner(t, "ana");

  await models.modify("anthropic", async () => Promise.resolve(oauth("k")));

  expect(
    models.modify("anthropic", async () =>
      Promise.reject(new Error("refused")),
    ),
  ).rejects.toThrow("refused");

  await models.modify("anthropic", async (current) => Promise.resolve(current));

  expect(await models.read("anthropic")).toEqual(oauth("k"));
});

test("logging out removes the login on every runner", async () => {
  await using t = await testPlugin(server, { people });

  await (
    await runner(t, "ana")
  ).models.modify("anthropic", async () =>
    Promise.resolve({ type: "api_key", key: "sk" }),
  );

  await (await runner(t, "ana")).models.delete("anthropic");

  expect(
    await (await runner(t, "ana")).models.read("anthropic"),
  ).toBeUndefined();
});

const mcpState = (access: string): McpLoginState => ({
  client: { client_id: "pi" },
  tokens: { access_token: access, refresh_token: `refresh-${access}` },
});

const linear = ["linear", "https://mcp.linear.app/mcp"] as const;

// Writes go back to the server in the background, so another runner sees
// them a moment later.
const is =
  (wanted: unknown) =>
  (value: unknown): boolean =>
    Bun.deepEquals(value, wanted);

test("an MCP sign-in on one runner is there on another, for its owner only", async () => {
  await using t = await testPlugin(server, { people });

  (await runner(t, "ana")).mcp.forServer(...linear).save(mcpState("m1"));

  const loaded = async (id: string) =>
    (await runner(t, id)).mcp.forServer(...linear).load();

  expect(await until(async () => loaded("ana"), is(mcpState("m1")))).toEqual(
    mcpState("m1"),
  );

  expect(await loaded("bo")).toBeUndefined();
});

test("runners refresh one MCP login one at a time, each seeing the last write", async () => {
  await using t = await testPlugin(server, { people });

  (await runner(t, "ana")).mcp.forServer(...linear).save(mcpState("t0"));

  await until(
    async () => (await runner(t, "ana")).mcp.forServer(...linear).load(),
    is(mcpState("t0")),
  );

  const [first, second] = [await runner(t, "ana"), await runner(t, "ana")];
  const seen: string[] = [];

  const refresh = async ({ mcp }: SessionLogins): Promise<void> => {
    const login = mcp.forServer(...linear);

    await login.withRefreshLock(async () => {
      const access = (login.load()?.tokens as { access_token: string })
        .access_token;

      seen.push(access);
      await Bun.sleep(20);
      login.save(mcpState(`${access}+`));
    });
  };

  await Promise.all([refresh(first), refresh(second)]);

  expect(seen).toEqual(["t0", "t0+"]);

  expect((await runner(t, "ana")).mcp.forServer(...linear).load()).toEqual(
    mcpState("t0++"),
  );
});

test("an MCP logout reaches every runner", async () => {
  await using t = await testPlugin(server, { people });
  const { mcp } = await runner(t, "ana");

  mcp.forServer(...linear).save(mcpState("m1"));

  await until(
    async () => (await runner(t, "ana")).mcp.tokens(...linear),
    (tokens) => tokens !== undefined,
  );

  expect(mcp.remove(...linear)).toBe(true);

  expect(
    await until(
      async () => (await runner(t, "ana")).mcp.tokens(...linear),
      (tokens) => tokens === undefined,
    ),
  ).toBeUndefined();
});

test("a team Session points the team's providers at the proxy, with its token as the key", async () => {
  await using t = await testPlugin(server, { people });

  await t.as("admin").post("save", {
    provider: "anthropic",
    credential: { type: "api_key", key: "sk-team" },
    layer: "base",
  });

  const team = await t.session({ owner: "team", startedBy: "ana" });

  // Pi's providers load in the background when the plugin registers.
  await until(
    async () =>
      (await team.api.get<{ providers: readonly unknown[] }>("proxy"))
        .providers,
    (providers) => providers.length > 0,
  );

  const part = await testSession(session, { request: team.request });

  const pointed = part.provider("anthropic") as
    { readonly baseUrl: string; readonly apiKey: string } | undefined;

  expect(pointed?.baseUrl).toEndWith("/api/ext/logins/proxy/anthropic");
  expect(pointed?.apiKey).toStartWith("ppx_");

  const mine = await t.session({ owner: person("ana") });
  const personal = await testSession(session, { request: mine.request });

  expect(personal.provider("anthropic")).toBeUndefined();
});
