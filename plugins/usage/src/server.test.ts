import { expect, test } from "bun:test";
import { type PluginEvent, type PluginRoute, eventBus } from "@pipoca/plugins";
import { fakeContext, fakeUser, served } from "@pipoca/plugins/testing";
import { usage } from "./server";

function registered(
  prices: unknown = {},
  budgets: unknown = {},
): {
  readonly route: PluginRoute;
  readonly called: (fields: Record<string, unknown>) => void;
  readonly warnings: readonly PluginEvent[];
} {
  const events = eventBus((_type, error) => {
    throw error;
  });

  const warnings: PluginEvent[] = [];

  events.subscribe("usage.budget_warned", (event) => {
    warnings.push(event);
  });

  let route: PluginRoute | undefined;

  usage.register(
    fakeContext({
      events: { ...events, declared: () => [] },
      config: {
        get: () => ({ prices, budgets }),
        set: () => undefined,
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
