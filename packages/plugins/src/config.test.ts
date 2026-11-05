import { describe, expect, test } from "bun:test";
import { Config, type PluginStore, Secret, Type } from "@pipoca/plugins";
import { configOf, envSecrets, secretRefs } from "@pipoca/plugins/host";

// Seals like the server's key does: a value opens only under the context
// it was sealed with, and each plugin's store adds its id to the context.
function storeOf(plugin: string): Pick<PluginStore, "seal" | "open"> {
  return {
    seal: (text, context) => JSON.stringify([`${plugin}:${context}`, text]),
    open: (sealed, context) => {
      const [sealedFor, text] = JSON.parse(sealed) as [string, string];

      if (sealedFor !== `${plugin}:${context}`) {
        throw new Error("wrong context");
      }

      return text;
    },
  };
}

function reading(plugin = "slack", env: NodeJS.ProcessEnv = {}) {
  const logs: { message: string; fields?: unknown }[] = [];
  const secrets = secretRefs(storeOf(plugin), envSecrets(env));

  return {
    logs,
    read: (schema: Parameters<typeof configOf>[0], raw: unknown): unknown =>
      configOf(schema, raw, secrets, (message, fields) => {
        logs.push({ message, fields });
      }),
  };
}

const settings = Config.object({
  greeting: Config.string({ title: "Greeting", default: "Hello" }),
  pollSeconds: Config.number({ title: "Poll", default: 60, min: 5 }),
  quiet: Config.boolean({ title: "Quiet", default: false }),
  tone: Config.choice({
    title: "Tone",
    options: ["plain", "warm"],
    default: "plain",
  }),
  channels: Config.strings({ title: "Channels", default: ["general"] }),
  limits: Config.object({
    daily: Config.number({ title: "Daily", default: 10 }),
  }),
});

const bots = Config.object({
  bots: Config.collection({
    title: "Bots",
    key: "name",
    item: Type.Object({
      name: Type.String(),
      botToken: Secret(),
      users: Config.audience(),
    }),
  }),
});

describe("configOf", () => {
  test("fills every default when the key is left out", () => {
    expect(reading().read(settings, undefined)).toEqual({
      greeting: "Hello",
      pollSeconds: 60,
      quiet: false,
      tone: "plain",
      channels: ["general"],
      limits: { daily: 10 },
    });
  });

  test("keeps what the file sets and fills the rest, dropping unknown fields", () => {
    expect(
      reading().read(settings, {
        tone: "warm",
        limits: { daily: 3 },
        retired: true,
      }),
    ).toEqual({
      greeting: "Hello",
      pollSeconds: 60,
      quiet: false,
      tone: "warm",
      channels: ["general"],
      limits: { daily: 3 },
    });
  });

  test("throws naming the field that doesn't fit", () => {
    const { read } = reading();

    expect(() => read(settings, { pollSeconds: "often" })).toThrow(
      "pollSeconds must be number",
    );

    expect(() => read(settings, { pollSeconds: 1 })).toThrow(
      "pollSeconds must be >= 5",
    );

    expect(() => read(settings, { limits: { daily: "x" } })).toThrow(
      "limits.daily must be number",
    );

    expect(() => read(settings, "on")).toThrow("config must be object");
  });

  test("skips collection items that don't fit, with a log line each, and keeps the rest", () => {
    const store = storeOf("slack");
    const token = store.seal("xoxb", "bots.botToken");
    const { read, logs } = reading();

    expect(
      read(bots, {
        bots: [
          { name: "ops", botToken: { sealed: token } },
          { name: "ops", botToken: { sealed: token } },
          { name: "Big Bot", botToken: { sealed: token } },
          { name: "bare" },
          "not a bot",
          { name: "team", botToken: { sealed: token }, users: ["team"] },
        ],
      }),
    ).toEqual({
      bots: [
        { name: "ops", botToken: "xoxb", users: [] },
        { name: "team", botToken: "xoxb", users: ["team"] },
      ],
    });

    expect(logs).toEqual([
      {
        message: "config item skipped",
        fields: {
          path: "bots",
          item: "ops",
          error: "another item has the name ops",
        },
      },
      {
        message: "config item skipped",
        fields: {
          path: "bots",
          item: "Big Bot",
          error: "name must be lowercase letters, digits and hyphens",
        },
      },
      {
        message: "config item skipped",
        fields: {
          path: "bots",
          item: "bare",
          error: "item must have required properties botToken",
        },
      },
      {
        message: "config item skipped",
        fields: { path: "bots", item: 4, error: "item must be object" },
      },
    ]);
  });

  test("opens a sealed secret and one named by an environment variable, which leaves the environment", () => {
    const env: NodeJS.ProcessEnv = { SLACK_TOKEN: "from env" };
    const { read } = reading("slack", env);
    const schema = Config.object({ token: Secret(), backup: Secret() });

    const value = read(schema, {
      token: { env: "SLACK_TOKEN" },
      backup: { sealed: storeOf("slack").seal("sealed one", "backup") },
    });

    expect(value).toEqual({ token: "from env", backup: "sealed one" });
    expect(env).toEqual({});

    expect(
      read(schema, {
        token: { env: "SLACK_TOKEN" },
        backup: { env: "SLACK_TOKEN" },
      }),
    ).toEqual({ token: "from env", backup: "from env" });
  });

  test("throws for a missing environment variable outside a collection and skips the item inside one", () => {
    const { read, logs } = reading();

    expect(() =>
      read(Config.object({ token: Secret() }), { token: { env: "UNSET" } }),
    ).toThrow("token names the environment variable UNSET, which isn't set");

    expect(
      read(bots, { bots: [{ name: "ops", botToken: { env: "UNSET" } }] }),
    ).toEqual({ bots: [] });

    expect(logs).toEqual([
      {
        message: "config item skipped",
        fields: {
          path: "bots",
          item: "ops",
          error:
            "bots.botToken names the environment variable UNSET, which isn't set",
        },
      },
    ]);
  });

  test("a sealed secret survives renaming its item and doesn't open in another plugin", () => {
    const token = storeOf("slack").seal("xoxb", "bots.botToken");

    const renamed = {
      bots: [{ name: "renamed", botToken: { sealed: token } }],
    };

    expect(reading("slack").read(bots, renamed)).toEqual({
      bots: [{ name: "renamed", botToken: "xoxb", users: [] }],
    });

    const other = reading("email");

    expect(other.read(bots, renamed)).toEqual({ bots: [] });

    expect(other.logs).toEqual([
      {
        message: "config item skipped",
        fields: {
          path: "bots",
          item: "renamed",
          error:
            "bots.botToken isn't sealed with this server's key; save it in Settings or name an environment variable",
        },
      },
    ]);
  });
});
