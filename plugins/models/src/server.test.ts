import { expect, test } from "bun:test";
import { getEventListeners } from "node:events";
import type { ModelOffer, PluginRoute, RouteCaller } from "@pipoca/plugins";
import type { Environment, EnvironmentTemplate } from "@pipoca/protocol";
import {
  fakeContext,
  fakeSession,
  fakeUser,
  memoryStore,
  served,
} from "@pipoca/plugins/testing";
import { models } from "./server";

const environmentId = "environment-1";
const admin = fakeUser({ admin: true });

const caller: RouteCaller = {
  kind: "session",
  session: fakeSession({ environmentId }),
  actor: "session:session-1",
};

function registered(signal: AbortSignal): PluginRoute {
  const routes: PluginRoute[] = [];

  models.register(
    fakeContext({
      store: memoryStore(models.schema),
      routes: {
        handle: (route) => {
          routes.push(served(route));
        },
      },
      models: { offer: () => undefined },
      signal,
    }),
  );

  const [route] = routes;
  if (route === undefined) {
    throw new Error("models registered no route");
  }

  return route;
}

async function configVersion(
  route: PluginRoute,
  after?: number,
  signal: AbortSignal | null = null,
): Promise<number> {
  const query = after === undefined ? "" : `?after=${String(after)}`;
  const request = new Request(`http://models/config${query}`, { signal });
  const response = await route(request, "config", caller);
  const { version } = (await response.json()) as { version: number };

  return version;
}

async function clearAliases(route: PluginRoute): Promise<void> {
  const request = new Request(`http://models/environments/${environmentId}`, {
    method: "POST",
    body: JSON.stringify({ aliases: null }),
  });

  await route(request, `environments/${environmentId}`, admin);
}

async function saveAliases(
  route: PluginRoute,
  body: string,
): Promise<Response> {
  const request = new Request(`http://models/environments/${environmentId}`, {
    method: "POST",
    body,
  });

  return route(request, `environments/${environmentId}`, admin);
}

async function savedAliases(route: PluginRoute): Promise<unknown> {
  const request = new Request("http://models/environments");
  const response = await route(request, "environments", admin);
  const [saved] = (await response.json()) as { aliases: unknown }[];

  return saved?.aliases;
}

const aliases = { models: { fast: ["local/llama"] } };

test.each([
  ["no body", "", 400],
  ["broken JSON", '{"aliases":', 400],
  ["no aliases key", "{}", 422],
  ["a misspelled aliases key", JSON.stringify({ alias: aliases }), 422],
])("a save with %s keeps the saved aliases", async (_, body, status) => {
  const route = registered(new AbortController().signal);
  await saveAliases(route, JSON.stringify({ aliases }));
  const seen = await configVersion(route);

  const response = await saveAliases(route, body);

  expect(response.status).toBe(status);
  expect(await savedAliases(route)).toEqual(aliases);
  expect(await configVersion(route)).toBe(seen);
});

test("keeps a capped account's spend in whole millionths", async () => {
  const store = memoryStore(models.schema);
  const routes: PluginRoute[] = [];

  models.register(
    fakeContext({
      store,
      routes: {
        handle: (route) => {
          routes.push(served(route));
        },
      },
      models: { offer: () => undefined },
    }),
  );

  const until = new Date(Date.now() + 60_000).toISOString();
  const quota = { spent: 10.1, cap: 10.2, currency: "USD" };

  const reported = await routes[0]?.(
    new Request("http://models/health", {
      method: "POST",
      body: JSON.stringify({
        version: 1,
        unhealthyUntil: { openai: { until, reason: "capped", quota } },
      }),
    }),
    "health",
    caller,
  );

  expect(reported?.status).toBe(204);

  expect(
    store.all(
      "select typeof(quota_spent_micros) as kind, quota_spent_micros, quota_cap_micros from models_health",
    ),
  ).toEqual([
    {
      kind: "integer",
      quota_spent_micros: 10_100_000,
      quota_cap_micros: 10_200_000,
    },
  ]);

  const request = new Request("http://models/config");

  const config = (await (
    await routes[0]?.(request, "config", caller)
  )?.json()) as {
    health: { unhealthyUntil: Record<string, { quota?: unknown }> };
  };

  expect(config.health.unhealthyUntil["openai"]?.quota).toEqual(quota);
});

test("a save with null aliases turns them off", async () => {
  const route = registered(new AbortController().signal);
  await saveAliases(route, JSON.stringify({ aliases }));

  await clearAliases(route);

  expect(await savedAliases(route)).toBeNull();
});

test("a config wait woken by a change leaves no listener on the server signal", async () => {
  const server = new AbortController();
  const route = registered(server.signal);
  const seen = await configVersion(route);

  const waited = configVersion(route, seen);
  await clearAliases(route);

  expect(await waited).toBe(seen + 1);
  expect(getEventListeners(server.signal, "abort")).toHaveLength(0);
});

test("a config wait the client gave up on leaves no listener on the server signal", async () => {
  const server = new AbortController();
  const route = registered(server.signal);
  const seen = await configVersion(route);

  const client = new AbortController();
  const waited = configVersion(route, seen, client.signal);
  client.abort();

  expect(await waited).toBe(seen);
  expect(getEventListeners(server.signal, "abort")).toHaveLength(0);
});

test("a config wait for a client that already left returns at once", async () => {
  const server = new AbortController();
  const route = registered(server.signal);
  const seen = await configVersion(route);

  expect(await configVersion(route, seen, AbortSignal.abort())).toBe(seen);
  expect(getEventListeners(server.signal, "abort")).toHaveLength(0);
});

test("a config wait returns when the server stops", async () => {
  const server = new AbortController();
  const route = registered(server.signal);
  const seen = await configVersion(route);

  const waited = configVersion(route, seen);
  server.abort();

  expect(await waited).toBe(seen);
});

test("a config wait after the server stopped answers 503 so the Session backs off", async () => {
  const server = new AbortController();
  const route = registered(server.signal);
  const seen = await configVersion(route);
  server.abort();

  const request = new Request(`http://models/config?after=${String(seen)}`);
  const response = await route(request, "config", caller);

  expect(response.status).toBe(503);
  expect(getEventListeners(server.signal, "abort")).toHaveLength(0);
});

test("an Environment without aliases of its own takes its template's", async () => {
  const routes: PluginRoute[] = [];
  const base = fakeContext();
  const team = { models: { fast: ["team/llama"] }, defaultAlias: "fast" };

  models.register(
    fakeContext({
      store: memoryStore(models.schema),
      routes: {
        handle: (route) => {
          routes.push(served(route));
        },
      },
      models: { offer: () => undefined },
      environments: {
        ...base.environments,
        list: () => [{ id: environmentId, templateId: "team" } as Environment],
        templates: () => [
          { id: "team", aliases: team } as unknown as EnvironmentTemplate,
        ],
      },
    }),
  );

  const [route] = routes;
  if (route === undefined) {
    throw new Error("models registered no route");
  }

  const config = async (): Promise<unknown> => {
    const response = await route(
      new Request("http://models/config"),
      "config",
      caller,
    );

    return ((await response.json()) as { aliases: unknown }).aliases;
  };

  expect(await config()).toEqual(team);

  await saveAliases(route, JSON.stringify({ aliases }));

  expect(await config()).toEqual(aliases);
});

test("an admin hides models from the pickers, and every Environment's offer carries them", async () => {
  let saved: unknown = { other: true };
  const routes: PluginRoute[] = [];
  const offers: ModelOffer[] = [];

  models.register(
    fakeContext({
      store: memoryStore(models.schema),
      routes: {
        handle: (route) => {
          routes.push(served(route));
        },
      },
      models: {
        offer: (offer) => {
          offers.push(offer);
        },
      },
      config: {
        get: () => saved,
        set: (value) => {
          saved = value;
        },
        dir: "",
        lockedIn: () => undefined,
      },
    }),
  );

  const [route] = routes;
  const [offer] = offers;
  if (route === undefined || offer === undefined) {
    throw new Error("models registered no route or offer");
  }

  const hide = async (
    hidden: readonly string[],
    who: RouteCaller,
  ): Promise<Response> =>
    route(
      new Request("http://models/hidden", {
        method: "POST",
        body: JSON.stringify({ hidden }),
      }),
      "hidden",
      who,
    );

  expect((await hide(["openai/gpt-4o"], fakeUser())).status).toBe(403);
  expect((await hide(["no-slash"], admin)).status).toBe(400);
  expect((await hide(["openai/gpt-4o", "openai/o3"], admin)).status).toBe(200);

  expect(saved).toEqual({
    other: true,
    hidden: ["openai/gpt-4o", "openai/o3"],
  });

  expect(
    offer({ id: environmentId, templateId: null, ownerId: "owner" }).hidden,
  ).toEqual(["openai/gpt-4o", "openai/o3"]);

  await hide([], admin);
  expect(saved).toEqual({ other: true });
});
