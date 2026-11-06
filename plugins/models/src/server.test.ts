import { afterEach, expect, test } from "bun:test";
import {
  person,
  type PluginTest,
  type TestPluginOptions,
  type TestSession,
  testPlugin,
  until,
} from "@pipoca/testing";
import type { models } from "../plugin";
import { server } from "./server";

const people = [
  { id: "ada", name: "Ada", admin: true },
  { id: "ana", name: "Ana" },
];

const aliases = { models: { fast: ["local/llama"] } };

interface Config {
  readonly version: number;
  readonly aliases: unknown;
  readonly health: {
    readonly unhealthyUntil: Readonly<
      Record<string, { readonly quota?: unknown }>
    >;
  };
}

let opened: PluginTest | undefined;

afterEach(async () => {
  await opened?.close();
  opened = undefined;
});

async function started(
  config?: TestPluginOptions<typeof models>["config"],
): Promise<{ readonly kernel: PluginTest; readonly session: TestSession }> {
  opened = await testPlugin(server, {
    people,
    ...(config !== undefined && { config }),
  });

  return {
    kernel: opened,
    session: await opened.session({ owner: person("ana") }),
  };
}

async function saveAliases(
  kernel: PluginTest,
  session: TestSession,
  body: string,
): Promise<Response> {
  return kernel.as("ada").raw("POST", `environments/${session.environmentId}`, {
    headers: { "content-type": "application/json" },
    body,
  });
}

test.each([
  ["no body", "", 400],
  ["broken JSON", '{"aliases":', 400],
  ["no aliases key", "{}", 422],
  ["a misspelled aliases key", JSON.stringify({ alias: aliases }), 422],
])("a save with %s keeps the saved aliases", async (_, body, status) => {
  const { kernel, session } = await started();
  await saveAliases(kernel, session, JSON.stringify({ aliases }));
  const seen = await session.api.get<Config>("config");

  const response = await saveAliases(kernel, session, body);

  expect(response.status).toBe(status);
  expect(await session.api.get<Config>("config")).toEqual(seen);
});

test("a save with null aliases turns them off", async () => {
  const { kernel, session } = await started();
  await saveAliases(kernel, session, JSON.stringify({ aliases }));

  await saveAliases(kernel, session, JSON.stringify({ aliases: null }));

  expect((await session.api.get<Config>("config")).aliases).toBeNull();
});

test("only admins change an Environment's aliases", async () => {
  const { kernel, session } = await started();

  const response = await kernel
    .as("ana")
    .raw("POST", `environments/${session.environmentId}`, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ aliases }),
    });

  expect(response.status).toBe(403);
});

test("keeps a capped account's spend in whole micro-dollars", async () => {
  const { kernel, session } = await started();
  const resets = new Date(kernel.clock.now() + 60_000).toISOString();
  const quota = { spent: 10.1, cap: 10.2, currency: "USD" };

  await session.api.post("health", {
    version: 1,
    unhealthyUntil: { openai: { until: resets, reason: "capped", quota } },
  });

  expect(
    kernel.store.all(
      "select typeof(quota_spent_micros) as kind, quota_spent_micros, quota_cap_micros from models_health",
    ),
  ).toEqual([
    {
      kind: "integer",
      quota_spent_micros: 10_100_000,
      quota_cap_micros: 10_200_000,
    },
  ]);

  const config = await session.api.get<Config>("config");

  expect(config.health.unhealthyUntil["openai"]?.quota).toEqual(quota);
});

test("a config wait ends when the Environment's aliases change", async () => {
  const { kernel, session } = await started();
  const { version } = await session.api.get<Config>("config");

  const waited = session.api.get<Config>("config", { after: version });
  await saveAliases(kernel, session, JSON.stringify({ aliases }));

  expect(await waited).toMatchObject({ version: version + 1, aliases });
});

test("a config wait ends on the schedule after 20 seconds", async () => {
  const { kernel, session } = await started();
  const { version } = await session.api.get<Config>("config");
  let answered: Config | undefined;

  void session.api.get<Config>("config", { after: version }).then((config) => {
    answered = config;
  });

  await until(
    async () => {
      await kernel.clock.advance("20s");

      return answered;
    },
    (config) => config !== undefined,
  );

  expect(answered?.version).toBe(version);
});

test("hidden models come from the plugin's config", async () => {
  const { kernel } = await started({ hidden: ["openai/gpt-4o"] });

  expect(await kernel.as("ana").get("hidden")).toEqual({
    hidden: ["openai/gpt-4o"],
    mayChange: false,
  });
});

test("an admin hides models, which the config keeps", async () => {
  const { kernel } = await started();

  const hide = async (who: string, hidden: readonly string[]) =>
    kernel.as(who).raw("POST", "hidden", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hidden }),
    });

  expect((await hide("ana", ["openai/gpt-4o"])).status).toBe(403);
  expect((await hide("ada", ["no-slash"])).status).toBe(400);

  expect((await hide("ada", ["openai/gpt-4o", "openai/o3"])).status).toBe(200);

  await kernel.restart();

  expect(await kernel.as("ada").get("hidden")).toEqual({
    hidden: ["openai/gpt-4o", "openai/o3"],
    mayChange: true,
  });
});
