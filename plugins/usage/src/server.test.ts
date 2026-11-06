import { expect, test } from "bun:test";
import { server as logins } from "@pipoca/logins/server";
import type { Session } from "@pipoca/protocol";
import {
  type PluginTest,
  type TestPluginOptions,
  type TestSession,
  testPlugin,
  until,
} from "@pipoca/testing";
import type { usage } from "../plugin";
import { server } from "./server";

const people = [
  { id: "admin", name: "Admin", admin: true },
  { id: "ana", name: "Ana" },
  { id: "bo", name: "Bo" },
];

// Anthropic, answering each call with the tokens its body asks for.
async function anthropic(request: Request): Promise<Response> {
  const { input, output } = (await request.json()) as {
    input: number;
    output: number;
  };

  const events = [
    { type: "message_start", message: { usage: { input_tokens: input } } },
    { type: "message_delta", usage: { output_tokens: output } },
  ];

  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

async function started(
  config: TestPluginOptions<typeof usage>["config"] = {},
): Promise<PluginTest> {
  const t = await testPlugin(server, {
    people,
    config,
    plugins: [logins],
    fetch: anthropic,
  });

  const saved = await t.as("admin").raw("/api/ext/logins/save", {
    method: "POST",
    body: JSON.stringify({
      provider: "anthropic",
      credential: { type: "api_key", key: "sk-team" },
      layer: "base",
    }),
  });

  expect(saved.status).toBe(200);

  return t;
}

interface Team {
  readonly session: TestSession;
  readonly token: string;
}

// A team Session started by the person, with its token for the proxy.
async function team(t: PluginTest, startedBy: string): Promise<Team> {
  const session = await t.session({ owner: "team", startedBy });

  // Pi's providers load in the background when logins registers.
  const { token } = await until(
    async () =>
      (await (
        await session.api.raw(`/runner/sessions/${session.id}/ext/logins/proxy`)
      ).json()) as {
        providers: readonly unknown[];
        token?: string;
      },
    ({ providers }) => providers.length > 0,
  );

  return { session, token: token ?? "" };
}

let spent = 0;

// One model call of the team's work through the logins proxy.
async function call(
  t: PluginTest,
  { token }: Team,
  tokens: { readonly model?: string; input: number; output: number },
): Promise<void> {
  const answered = await t
    .as("admin")
    .raw("/api/ext/logins/proxy/anthropic/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        model: tokens.model ?? "claude-sonnet-4-5",
        stream: true,
        ...tokens,
      }),
      headers: { "x-api-key": token },
    });

  expect(answered.status).toBe(200);
  await answered.text();

  spent += 1;
  const wanted = spent;

  await until(
    () => t.emitted("logins.model_called").length,
    (heard) => heard >= wanted,
  );

  await until(
    () =>
      t.store.get<{ count: number }>(
        "select count(*) as count from usage_calls",
      )?.count ?? 0,
    (count) => count >= t.emitted("logins.model_called").length,
  );
}

const sonnet = (input: number, output: number) => ({
  "anthropic/claude-sonnet-4-5": { input, output },
});

test("prices each team model call from the admins' table, and leaves an unpriced model's cost out", async () => {
  spent = 0;
  await using t = await started({ prices: sonnet(3, 15) });
  const work = await team(t, "ana");

  await call(t, work, { input: 1_000_000, output: 100_000 });
  await call(t, work, { model: "other", input: 10, output: 5 });

  expect(await t.as("admin").get("calls")).toMatchObject([
    { model: "other", input: 10, output: 5, cost: null },
    {
      owner: "team",
      person: "ana",
      sessionId: work.session.id,
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      cost: 4.5,
    },
  ]);
});

test("a person sees their own calls and the team's totals; an admin sees every call", async () => {
  spent = 0;

  await using t = await started({
    prices: sonnet(1, 1),
  });

  await call(t, await team(t, "ana"), { input: 500_000, output: 0 });
  await call(t, await team(t, "bo"), { input: 1_500_000, output: 0 });

  const askers = async (id: string) =>
    (await t.as(id).get<readonly { person: string }[]>("calls")).map(
      ({ person }) => person,
    );

  expect(await askers("ana")).toEqual(["ana"]);
  expect(await askers("admin")).toEqual(["bo", "ana"]);

  expect(await t.as("ana").get("totals")).toMatchObject({
    team: { input: 2_000_000, output: 0, cost: 2 },
    mine: { input: 500_000, output: 0, cost: 0.5 },
  });
});

test("warns once as the team's month reaches 80% and then 100% of its budget, and as a person reaches their cap", async () => {
  spent = 0;

  await using t = await started({
    prices: sonnet(1, 0),
    budgets: { team: 10, person: 5 },
  });

  const works = { ana: await team(t, "ana"), bo: await team(t, "bo") };

  const spend = async (who: "ana" | "bo", dollars: number) => {
    await call(t, works[who], { input: dollars * 1_000_000, output: 0 });
  };

  await spend("ana", 3);
  await spend("bo", 4);
  await spend("ana", 1);
  await spend("bo", 1);
  await spend("ana", 2);

  expect(t.emitted("usage.budget_warned")).toEqual([
    {
      fields: { person: "bo", share: 80, spent: 4, limit: 5 },
      to: ["person:bo", "team"],
    },
    { fields: { person: null, share: 80, spent: 8, limit: 10 }, to: ["team"] },
    {
      fields: { person: "ana", share: 80, spent: 4, limit: 5 },
      to: ["person:ana", "team"],
    },
    {
      fields: { person: "bo", share: 100, spent: 5, limit: 5 },
      to: ["person:bo", "team"],
    },
    {
      fields: { person: null, share: 100, spent: 11, limit: 10 },
      to: ["team"],
    },
    {
      fields: { person: "ana", share: 100, spent: 6, limit: 5 },
      to: ["person:ana", "team"],
    },
  ]);

  expect(await t.as("ana").get("totals")).toMatchObject({
    budgets: { team: 10, person: 5 },
  });
});

async function sessionOf(t: PluginTest, id: string): Promise<Session> {
  return (await (
    await t.as("admin").raw(`/api/sessions/${id}`, { method: "GET" })
  ).json()) as Session;
}

test("logs who started, stopped and archived team work, and each use of the team's key; a person sees their own, an admin exports all", async () => {
  spent = 0;
  await using t = await started();
  const work = await team(t, "ana");
  const { id } = work.session;

  await call(t, work, { input: 1, output: 1 });

  const session = { ...(await sessionOf(t, id)), title: 'Fix, "now"' };

  t.emit({ type: "StopAsked", session, actor: "user:bo" });
  t.emit({ type: "SessionArchived", session, actor: "user:ana" });

  const anas = await t.as("ana").get<readonly { action: string }[]>("audit");

  expect(anas.map(({ action }) => action)).toEqual(["archived", "started"]);

  const exported = await t
    .as("admin")
    .raw("audit?format=csv", { method: "GET" });

  expect(exported.headers.get("content-type")).toStartWith("text/csv");

  expect(
    (await exported.text())
      .split("\r\n")
      .map((line) => line.replace(/^"[^"]*",/, "")),
  ).toEqual([
    '"actor","sessionId","action","detail"',
    `"user:ana","${id}","archived","Fix, ""now"""`,
    `"user:bo","${id}","stopped","Fix, ""now"""`,
    `"","${id}","used the team's key","anthropic/claude-sonnet-4-5"`,
    `"user:ana","${id}","started",""`,
  ]);
});

test("only an admin sets the team's monthly budget and each person's cap, and an empty one means none", async () => {
  await using t = await started({ prices: sonnet(3, 15) });

  const put = async (id: string, body: unknown) =>
    t
      .as(id)
      .raw("budgets", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

  expect((await put("ana", { team: 50, person: 10 })).status).toBe(403);
  expect((await put("admin", { team: 50, person: 10 })).status).toBe(204);

  expect(await t.as("ana").get("totals")).toMatchObject({
    budgets: { team: 50, person: 10 },
  });

  await put("admin", { team: 80, person: null });

  expect(await t.config()).toMatchObject({
    prices: sonnet(3, 15),
    budgets: { team: 80, person: 0 },
  });

  expect(await t.as("ana").get("totals")).toMatchObject({
    budgets: { team: 80, person: null },
  });

  expect((await put("admin", { team: -1, person: null })).status).toBe(422);
});

test("shows everyone what people did lately to the team work they can see", async () => {
  spent = 0;
  await using t = await started();
  const release = await team(t, "ana");

  await call(t, release, { input: 1, output: 1 });

  const handbook = await t.session({ owner: "team", startedBy: "bo" });
  const limited = await t.session({ owner: "team", startedBy: "bo" });

  t.emit({
    type: "StopAsked",
    session: await sessionOf(t, release.session.id),
    actor: "user:bo",
  });

  t.emit({
    type: "SessionMoved",
    session: await sessionOf(t, handbook.id),
    from: "person:bo",
    actor: "user:bo",
  });

  const access = async (id: string, to: unknown) => {
    const changed = await t
      .as("bo")
      .raw(`/api/sessions/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ access: to }),
      });

    expect(changed.status).toBe(200);
  };

  await access(handbook.id, { kind: "view" });
  // Named people that leave Ana out.
  await access(limited.id, { kind: "named", people: ["bo"] });

  const seen = await t
    .as("ana")
    .get<readonly { actor: string; action: string; sessionId: string }[]>(
      "activity",
    );

  const names: Readonly<Record<string, string>> = {
    [release.session.id]: "release",
    [handbook.id]: "handbook",
    [limited.id]: "limited",
  };

  expect(
    seen.map(
      ({ actor, action, sessionId }) =>
        `${actor} ${action} ${names[sessionId] ?? sessionId}`,
    ),
  ).toEqual([
    "user:bo made view only handbook",
    "user:bo moved to the team handbook",
    "user:bo stopped release",
    "user:ana started release",
  ]);
});
