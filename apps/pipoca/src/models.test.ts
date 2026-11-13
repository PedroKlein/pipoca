import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Environment, Session } from "@pipoca/protocol";
import { testServer, type TestServer } from "./testdata/harness";
import { until } from "@pipoca/testing/until";

let root: string;
let primary: ReturnType<typeof fauxProvider>;
let fallback: ReturnType<typeof fauxProvider>;
let server: TestServer;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "pipoca-models-")));
  primary = fauxProvider({ provider: "primary" });
  fallback = fauxProvider({ provider: "fallback" });

  const runtime = await ModelRuntime.create({
    authPath: join(root, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  });

  runtime.registerNativeProvider(primary.provider);
  runtime.registerNativeProvider(fallback.provider);

  server = testServer({
    runners: { pollWaitMs: 100, offlineAfterMs: 1000 },
    agent: {
      provider: "local",
      dataDir: join(root, "local"),
      extensionPaths: [],
      folders: [root],
      models: { runtime, model: primary.getModel() },
    },
  });
});

afterEach(async () => {
  await server.close();
  await rm(root, { recursive: true, force: true });
});

async function environment(): Promise<Environment> {
  const [found] = await until(
    async () =>
      (await (await server.api("/api/environments")).json()) as Environment[],
    (environments) => environments.length > 0,
  );

  if (!found) {
    throw new Error("no environment");
  }

  return found;
}

const session = async (id: string): Promise<Session> =>
  (await (await server.api(`/api/sessions/${id}`)).json()) as Session;

// A new Session reports idle once before its first turn starts, so a test
// that counts model calls waits for the call first.
const settled = (value: Session): boolean =>
  value.status === "idle" || value.status === "failed";

async function aliases(environmentId: string): Promise<void> {
  const response = await server.api(
    `/api/ext/models/environments/${environmentId}`,
    {
      body: {
        aliases: {
          models: {
            "medium-1": [
              `primary/${primary.getModel().id}`,
              `fallback/${fallback.getModel().id}`,
            ],
          },
        },
      },
    },
  );

  expect(response.status).toBe(200);
}

test("routes an alias to its first model in the session's Environment", async () => {
  const { id: environmentId } = await environment();
  await aliases(environmentId);

  primary.setResponses([fauxAssistantMessage("from primary")]);

  const started = (await (
    await server.api("/api/sessions", {
      body: {
        workspace: { kind: "folder", path: root },
        model: { provider: "alias", id: "medium-1" },
        firstMessage: "hi",
      },
    })
  ).json()) as Session;

  await until(
    () => primary.state.callCount,
    (count) => count > 0,
  );

  expect((await until(async () => session(started.id), settled)).status).toBe(
    "idle",
  );

  expect(primary.state.callCount).toBe(1);
  expect(fallback.state.callCount).toBe(0);
});

test("takes a provider that hit its cap out of routing for the whole Environment", async () => {
  const { id: environmentId } = await environment();
  await aliases(environmentId);

  primary.setResponses([
    fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage: "402 insufficient_quota",
    }),
  ]);

  fallback.setResponses([fauxAssistantMessage("from fallback")]);

  const capped = (await (
    await server.api("/api/sessions", {
      body: {
        workspace: { kind: "folder", path: root },
        model: { provider: "alias", id: "medium-1" },
        firstMessage: "hi",
      },
    })
  ).json()) as Session;

  const [models] = await until(
    async () =>
      (await (await server.api("/api/ext/models/environments")).json()) as {
        readonly health: {
          readonly unhealthyUntil: Readonly<
            Record<string, { readonly reason: string }>
          >;
        };
      }[],
    ([found]) =>
      found !== undefined && "primary" in found.health.unhealthyUntil,
  );

  expect(models?.health.unhealthyUntil["primary"]?.reason).toContain("402");

  const next = (await (
    await server.api("/api/sessions", {
      body: {
        workspace: { kind: "folder", path: root },
        model: { provider: "alias", id: "medium-1" },
        firstMessage: "hi again",
      },
    })
  ).json()) as Session;

  await until(
    () => primary.state.callCount + fallback.state.callCount,
    (count) => count > 1,
  );

  expect((await until(async () => session(next.id), settled)).status).toBe(
    "idle",
  );

  expect(fallback.state.callCount).toBe(1);
  expect(primary.state.callCount).toBe(1);

  await until(async () => session(capped.id), settled);
});

test("shows a model that failed in a Session as unavailable, with why, in its Environment", async () => {
  primary.setResponses([
    fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage: "404 deployment not found",
    }),
  ]);

  const failed = (await (
    await server.api("/api/sessions", {
      body: {
        workspace: { kind: "folder", path: root },
        model: { provider: "primary", id: primary.getModel().id },
        firstMessage: "hi",
      },
    })
  ).json()) as Session;

  const { unavailableModels } = await until(
    environment,
    (found) => found.unavailableModels.length > 0,
  );

  expect(unavailableModels).toEqual([
    {
      target: `primary/${primary.getModel().id}`,
      reason: "404 deployment not found",
    },
  ]);

  await until(async () => session(failed.id), settled);
});

test("refuses an alias config without aliases or with a malformed one", async () => {
  const { id: environmentId } = await environment();

  for (const config of [
    { models: {} },
    { models: { "medium-1": [] } },
    { models: { "medium-1": ["no-provider"] } },
    { models: { "a/b": ["primary/m"] } },
    { models: { "medium-1": ["primary/m"] }, defaultAlias: "heavy-1" },
  ]) {
    const response = await server.api(
      `/api/ext/models/environments/${environmentId}`,
      { body: { aliases: config } },
    );

    expect(response.status).toBe(400);
  }
});

test("refuses provider settings with the wrong types", async () => {
  const { id: environmentId } = await environment();

  for (const settings of [
    { capStatusCodes: 402 },
    { capStatusCodes: ["402"] },
    { resetSchedule: 1 },
  ]) {
    const response = await server.api(
      `/api/ext/models/environments/${environmentId}`,
      {
        body: {
          aliases: {
            models: { "medium-1": ["primary/m"] },
            providers: { primary: settings },
          },
        },
      },
    );

    expect(response.status).toBe(422);
  }
});

test("lists an Environment's aliases first and gives a session with no model its default alias", async () => {
  const { id: environmentId } = await environment();

  await server.api(`/api/ext/models/environments/${environmentId}`, {
    body: {
      aliases: {
        defaultAlias: "medium-1",
        models: { "medium-1": [`primary/${primary.getModel().id}`] },
      },
    },
  });

  const [listed] = (await (
    await server.api("/api/environments")
  ).json()) as Environment[];

  expect(listed?.models[0]).toEqual({ provider: "alias", id: "medium-1" });

  primary.setResponses([fauxAssistantMessage("from primary")]);

  const started = (await (
    await server.api("/api/sessions", {
      body: {
        workspace: { kind: "folder", path: root },
        firstMessage: "hi",
      },
    })
  ).json()) as Session;

  expect(started.model).toEqual({ provider: "alias", id: "medium-1" });

  expect((await until(async () => session(started.id), settled)).status).toBe(
    "idle",
  );
});

test("routes an alias set after its Session started", async () => {
  primary.setResponses([fauxAssistantMessage("from primary")]);

  const started = (await (
    await server.api("/api/sessions", {
      body: {
        workspace: { kind: "folder", path: root },
        firstMessage: "hi",
      },
    })
  ).json()) as Session;

  await until(async () => session(started.id), settled);

  const { id: environmentId } = await environment();

  await server.api(`/api/ext/models/environments/${environmentId}`, {
    body: {
      aliases: {
        models: { "medium-1": [`fallback/${fallback.getModel().id}`] },
      },
    },
  });

  fallback.setResponses([fauxAssistantMessage("from fallback")]);

  // The Session learns of the alias a moment after the server has it.
  await until(
    async () => {
      await server.api(`/api/sessions/${started.id}/commands`, {
        body: {
          type: "set_model",
          model: { provider: "alias", id: "medium-1" },
        },
      });

      await server.api(`/api/sessions/${started.id}/commands`, {
        body: {
          type: "message",
          text: "hi again",
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      return fallback.state.callCount;
    },
    (count) => count > 0,
  );

  expect(fallback.state.callCount).toBe(1);
});
