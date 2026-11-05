import { expect, test } from "bun:test";
import { type PluginEvent, type PluginRoute, eventBus } from "@pipoca/plugins";
import {
  fakeContext,
  fakeSession,
  fakeUser,
  memoryStore,
  served,
} from "@pipoca/plugins/testing";
import { usage } from "./server";

function registered(
  prices: unknown = {},
  budgets: unknown = {},
): {
  readonly route: PluginRoute;
  readonly called: (fields: Record<string, unknown>) => void;
  readonly warnings: readonly PluginEvent[];
  readonly events: ReturnType<typeof eventBus>;
  readonly config: () => unknown;
} {
  const events = eventBus((_type, error) => {
    throw error;
  });

  const warnings: PluginEvent[] = [];

  events.subscribe("usage.budget_warned", (event) => {
    warnings.push(event);
  });

  let route: PluginRoute | undefined;
  let config: unknown = { prices, budgets };

  usage.register(
    fakeContext({
      store: memoryStore(usage.schema),
      events: { ...events, declared: () => [] },
      // Team work limited to named people that leaves Ana out.
      sessions: {
        ...fakeContext().sessions,
        sees: (id, person) => !(id === "limited" && person === "ana"),
      },
      config: {
        get: () => config,
        set: (value) => {
          config = value;
        },
        lockedIn: () => undefined,
        dir: "",
      },
      routes: {
        handle: (handler) => {
          route = served(handler);
        },
      },
    }),
  );

  if (route === undefined) {
    throw new Error("usage registered no route");
  }

  return {
    route,
    warnings,
    events,
    config: () => config,
    called: (fields) => {
      events.publish({
        type: "logins.model_called",
        owner: "team",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        ...fields,
      });
    },
  };
}

async function get(
  route: PluginRoute,
  path: string,
  caller = fakeUser({ id: "ana" }),
): Promise<unknown> {
  return (
    await route(new Request(`http://usage/${path}`), path, caller)
  ).json();
}

test("keeps the team's calls with no owner and a person's with their id", async () => {
  const store = memoryStore(usage.schema);

  const events = eventBus((_type, error) => {
    throw error;
  });

  let route: PluginRoute | undefined;

  usage.register(
    fakeContext({
      store,
      events: { ...events, declared: () => [] },
      routes: {
        handle: (handler) => {
          route = served(handler);
        },
      },
    }),
  );

  for (const owner of ["team", "person:ana"]) {
    events.publish({
      type: "logins.model_called",
      sessionId: "s1",
      owner,
      person: "ana",
      provider: "anthropic",
      input: 1,
      output: 1,
    });
  }

  expect(
    store.all("select owner_user_id from usage_calls order by id"),
  ).toEqual([{ owner_user_id: null }, { owner_user_id: "ana" }]);

  expect(
    route === undefined
      ? []
      : await get(route, "calls", fakeUser({ admin: true })),
  ).toMatchObject([{ owner: "person:ana" }, { owner: "team" }]);
});

test("prices each team model call from the admins' table, and leaves an unpriced model's cost out", async () => {
  const { route, called } = registered({
    "anthropic/claude-sonnet-4-5": { input: 3, output: 15 },
  });

  called({ sessionId: "s1", person: "ana", input: 1_000_000, output: 100_000 });

  called({
    sessionId: "s1",
    person: "ana",
    model: "other",
    input: 10,
    output: 5,
  });

  expect(await get(route, "calls")).toMatchObject([
    { model: "other", input: 10, output: 5, cost: null },
    {
      owner: "team",
      person: "ana",
      sessionId: "s1",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      cost: 4.5,
    },
  ]);
});

test("a person sees their own calls and the team's totals; an admin sees every call", async () => {
  const { route, called } = registered({
    "anthropic/claude-sonnet-4-5": { input: 1, output: 1 },
  });

  called({ sessionId: "s1", person: "ana", input: 500_000, output: 0 });
  called({ sessionId: "s2", person: "bo", input: 1_500_000, output: 0 });

  const anas = (await get(route, "calls")) as { person: string }[];

  const all = (await get(
    route,
    "calls",
    fakeUser({ id: "x", admin: true }),
  )) as {
    person: string;
  }[];

  expect(anas.map(({ person }) => person)).toEqual(["ana"]);
  expect(all.map(({ person }) => person)).toEqual(["bo", "ana"]);

  expect(await get(route, "totals")).toMatchObject({
    team: { input: 2_000_000, output: 0, cost: 2 },
    mine: { input: 500_000, output: 0, cost: 0.5 },
  });
});

test("warns once as the team's month reaches 80% and then 100% of its budget, and as a person reaches their cap", async () => {
  const { route, called, warnings } = registered(
    { "anthropic/claude-sonnet-4-5": { input: 1, output: 0 } },
    { team: 10, person: 5 },
  );

  const spend = (person: string, dollars: number) => {
    called({ sessionId: "s1", person, input: dollars * 1_000_000, output: 0 });
  };

  spend("ana", 3);
  spend("bo", 4);
  spend("ana", 1);
  spend("bo", 1);
  spend("ana", 2);

  expect(
    warnings.map(({ person, share, spent, limit }) => ({
      person,
      share,
      spent,
      limit,
    })),
  ).toEqual([
    { person: "bo", share: 80, spent: 4, limit: 5 },
    { person: null, share: 80, spent: 8, limit: 10 },
    { person: "ana", share: 80, spent: 4, limit: 5 },
    { person: "bo", share: 100, spent: 5, limit: 5 },
    { person: null, share: 100, spent: 11, limit: 10 },
    { person: "ana", share: 100, spent: 6, limit: 5 },
  ]);

  expect(await get(route, "totals")).toMatchObject({
    budgets: { team: 10, person: 5 },
  });
});

test("logs who started, stopped and archived team work, and each use of the team's key; a person sees their own, an admin exports all", async () => {
  const { route, called, events } = registered();
  const team = fakeSession({ id: "t1", ownedBy: "team", title: 'Fix, "now"' });

  events.publish({ type: "SessionCreated", session: team, actor: "user:ana" });

  events.publish({
    type: "SessionCreated",
    session: fakeSession({ id: "own" }),
    actor: "user:ana",
  });

  called({ sessionId: "t1", person: "ana", input: 1, output: 1 });
  events.publish({ type: "StopAsked", session: team, actor: "user:bo" });
  events.publish({ type: "SessionArchived", session: team, actor: "user:ana" });

  const anas = (await get(route, "audit")) as { action: string }[];

  expect(anas.map(({ action }) => action)).toEqual(["archived", "started"]);

  const admin = fakeUser({ id: "boss", admin: true });

  const exported = await route(
    new Request("http://usage/audit?format=csv"),
    "audit",
    admin,
  );

  expect(exported.headers.get("content-type")).toStartWith("text/csv");

  expect(
    (await exported.text())
      .split("\r\n")
      .map((line) => line.replace(/^"[^"]*",/, "")),
  ).toEqual([
    '"actor","sessionId","action","detail"',
    '"user:ana","t1","archived","Fix, ""now"""',
    '"user:bo","t1","stopped","Fix, ""now"""',
    '"","t1","used the team\'s key","anthropic/claude-sonnet-4-5"',
    '"user:ana","t1","started","Fix, ""now"""',
  ]);
});

test("only an admin sets the team's monthly budget and each person's cap, and an empty one means none", async () => {
  const { route, config } = registered({
    "anthropic/x": { input: 1, output: 1 },
  });

  const put = async (body: unknown, admin: boolean) =>
    route(
      new Request("http://usage/budgets", {
        method: "PUT",
        body: JSON.stringify(body),
      }),
      "budgets",
      fakeUser({ id: "ana", admin }),
    );

  expect((await put({ team: 50, person: 10 }, false)).status).toBe(403);

  expect((await put({ team: 50, person: 10 }, true)).status).toBe(204);

  expect(await get(route, "totals")).toMatchObject({
    budgets: { team: 50, person: 10 },
  });

  await put({ team: 80, person: null }, true);

  expect(config()).toMatchObject({ prices: { "anthropic/x": {} } });

  expect(await get(route, "totals")).toMatchObject({
    budgets: { team: 80, person: null },
  });

  expect((await put({ team: -1, person: null }, true)).status).toBe(422);
});

test("shows everyone what people did lately to the team work they can see", async () => {
  const { route, called, events } = registered();
  const team = fakeSession({ id: "t1", ownedBy: "team", title: "Release" });

  const moved = fakeSession({
    id: "t2",
    ownedBy: "team",
    title: "Handbook",
    access: { kind: "view" },
  });

  const limited = fakeSession({
    id: "limited",
    ownedBy: "team",
    title: "Budget",
  });

  events.publish({ type: "SessionCreated", session: team, actor: "user:ana" });
  called({ sessionId: "t1", person: "ana", input: 1, output: 1 });
  events.publish({ type: "StopAsked", session: team, actor: "user:bo" });
  events.publish({ type: "SessionCreated", session: moved, actor: "user:bo" });

  events.publish({
    type: "SessionMoved",
    session: moved,
    from: "own",
    actor: "user:bo",
  });

  events.publish({ type: "AccessChanged", session: moved, actor: "user:bo" });

  events.publish({
    type: "SessionCreated",
    session: limited,
    actor: "user:bo",
  });

  const seen = (await get(route, "activity")) as {
    actor: string;
    action: string;
    detail: string;
  }[];

  expect(
    seen.map(({ actor, action, detail }) => `${actor} ${action} ${detail}`),
  ).toEqual([
    "user:bo made view only Handbook",
    "user:bo moved to the team Handbook",
    "user:bo stopped Release",
    "user:ana started Release",
  ]);
});
