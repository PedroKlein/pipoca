import { afterEach, expect, test } from "bun:test";
import { server as askServer } from "@pipoca/ask/server";
import { definePlugin, defineServer, type Questions } from "@pipoca/plugins";
import {
  type PluginTest,
  person,
  type TestPluginOptions,
  type TestSession,
  testPlugin,
  until,
} from "@pipoca/testing";
import type { ServerWebSocket } from "bun";
import type { slack } from "../plugin";
import { server } from "./server";

const people = [
  { id: "ana", name: "Ana", admin: true },
  { id: "bo", name: "Bo" },
];

const opened: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(opened.splice(0).map(async (close) => close()));
});

// Slack's Web API, which knows the bot tokens xoxb-*, and its Socket Mode
// WebSocket, which takes the app tokens xapp-*.
function fakeSlack() {
  const sockets: {
    readonly app: string;
    readonly socket: ServerWebSocket<string>;
  }[] = [];

  const acknowledged: string[] = [];
  const posted: unknown[] = [];

  const socketServer = Bun.serve<string>({
    port: 0,
    fetch: (request, served) =>
      served.upgrade(request, {
        data: new URL(request.url).searchParams.get("app") ?? "",
      })
        ? undefined
        : new Response("no", { status: 400 }),
    websocket: {
      open: (socket) => {
        sockets.push({ app: socket.data, socket });
        socket.send(JSON.stringify({ type: "hello" }));
      },
      message: (_socket, message) => {
        const { envelope_id: id } = JSON.parse(String(message)) as {
          envelope_id: string;
        };

        acknowledged.push(id);
      },
    },
  });

  opened.push(async () => socketServer.stop(true));

  const fetch = async (request: Request): Promise<Response> => {
    const method = new URL(request.url).pathname.replace("/api/", "");

    const token =
      request.headers.get("authorization")?.slice("Bearer ".length) ?? "";

    if (method === "auth.test") {
      return Response.json(
        token.startsWith("xoxb-")
          ? { ok: true, team: "Acme", user_id: "UBOT" }
          : { ok: false, error: "invalid_auth" },
      );
    }

    if (method === "apps.connections.open") {
      return Response.json(
        token.startsWith("xapp-")
          ? {
              ok: true,
              url: `ws://127.0.0.1:${String(socketServer.port)}/?app=${token}`,
            }
          : { ok: false, error: "invalid_auth" },
      );
    }

    if (method === "chat.postMessage") {
      posted.push(await request.json());

      return Response.json({ ok: true, channel: "C1", ts: "1700.0001" });
    }

    if (method === "conversations.members") {
      return Response.json({ ok: true, members: ["UBOT", "U1"] });
    }

    return Response.json({ ok: false, error: "unknown_method" });
  };

  let envelopes = 0;

  // Sends an event down the newest socket and waits for its acknowledgement.
  const sends = async (
    event: Readonly<Record<string, unknown>>,
  ): Promise<void> => {
    envelopes += 1;
    const id = `envelope-${String(envelopes)}`;

    sockets.at(-1)?.socket.send(
      JSON.stringify({
        envelope_id: id,
        type: "events_api",
        payload: { event },
      }),
    );

    await until(() => acknowledged.includes(id));
  };

  return { fetch, sockets, posted, sends };
}

async function started(
  fake: ReturnType<typeof fakeSlack>,
  config?: TestPluginOptions<typeof slack>["config"],
  plugins: TestPluginOptions["plugins"] = [],
): Promise<PluginTest> {
  return testPlugin(server, {
    people,
    fetch: fake.fetch,
    ...(config !== undefined && { config }),
    plugins,
  });
}

async function addBot(t: PluginTest, name: string): Promise<void> {
  await t.as("ana").post("bots", {
    name,
    appToken: `xapp-${name}`,
    botToken: `xoxb-${name}`,
  });
}

test("an admin adds a bot whose token Slack knows, and it connects", async () => {
  const fake = fakeSlack();
  await using t = await started(fake);

  const refused = await t.as("ana").raw("bots", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "team-bot",
      appToken: "xapp-1",
      botToken: "bad",
    }),
  });

  expect(refused.status).toBe(400);

  expect(await refused.text()).toContain(
    "Slack refused auth.test: invalid_auth",
  );

  expect((await t.as("bo").raw("bots", { method: "GET" })).status).toBe(403);

  await addBot(t, "team-bot");
  await until(() => fake.sockets.length === 1);

  expect(
    await until(
      async () => t.as("ana").get("bots"),
      (bots) => JSON.stringify(bots).includes('"connected":true'),
    ),
  ).toEqual([
    {
      name: "team-bot",
      team: "Acme",
      botUser: "UBOT",
      connected: true,
      error: null,
    },
  ]);

  expect(await t.as("ana").delete("bots/team-bot")).toEqual({
    removed: "team-bot",
  });

  expect(await t.as("ana").get("bots")).toEqual([]);
});

test("what a bot hears is an event for the people who use it, except its own", async () => {
  const fake = fakeSlack();
  await using t = await started(fake);

  await addBot(t, "team-bot");
  await until(() => fake.sockets.length === 1);

  await fake.sends({
    type: "app_mention",
    user: "UBOT",
    channel: "C1",
    ts: "1.0",
    text: "own",
  });

  await fake.sends({
    type: "message",
    subtype: "channel_join",
    user: "U1",
    channel: "C1",
    ts: "1.5",
  });

  await fake.sends({
    type: "app_mention",
    user: "U1",
    channel: "C1",
    ts: "2.0",
    text: "<@UBOT> how do I deploy?",
  });

  await fake.sends({
    type: "reaction_added",
    user: "U1",
    reaction: "eyes",
    item: { channel: "C1", ts: "2.0" },
  });

  expect(t.emitted("slack.mention")).toEqual([
    {
      fields: {
        bot: "team-bot",
        channel: "C1",
        user: "U1",
        ts: "2.0",
        text: "<@UBOT> how do I deploy?",
        threadTs: "",
      },
      to: [person("ana")],
    },
  ]);

  expect(t.emitted("slack.reaction")).toEqual([
    {
      fields: {
        bot: "team-bot",
        channel: "C1",
        user: "U1",
        ts: "2.0",
        reaction: "eyes",
      },
      to: [person("ana")],
    },
  ]);

  expect(t.emitted("slack.message")).toEqual([]);
});

test("a dropped connection is opened again, a second later at first", async () => {
  const fake = fakeSlack();
  await using t = await started(fake);

  await addBot(t, "team-bot");
  await until(() => fake.sockets.length === 1);

  fake.sockets[0]?.socket.close();

  await until(
    async () => t.as("ana").get("bots"),
    (bots) => JSON.stringify(bots).includes('"connected":false'),
  );

  await t.clock.advance(999);

  expect(fake.sockets).toHaveLength(1);

  await t.clock.advance(1);
  await until(() => fake.sockets.length === 2);
});

test("a bot edited by hand in pipoca.json connects again with its new token", async () => {
  process.env["PIPOCA_TEST_SLACK_APP"] = "xapp-first";
  process.env["PIPOCA_TEST_SLACK_BOT"] = "xoxb-first";
  process.env["PIPOCA_TEST_SLACK_APP_2"] = "xapp-second";

  const bot = {
    name: "team-bot",
    team: "Acme",
    botUser: "UBOT",
    appToken: { env: "PIPOCA_TEST_SLACK_APP" },
    botToken: { env: "PIPOCA_TEST_SLACK_BOT" },
  };

  const fake = fakeSlack();
  await using t = await started(fake, { bots: [bot] });

  await until(() => fake.sockets.length === 1);

  expect(fake.sockets.map(({ app }) => app)).toEqual(["xapp-first"]);
  expect(process.env["PIPOCA_TEST_SLACK_BOT"]).toBeUndefined();

  await t.editConfig({
    bots: [{ ...bot, appToken: { env: "PIPOCA_TEST_SLACK_APP_2" } }],
  });

  await t.clock.advance("2s");
  await until(() => fake.sockets.length === 2);

  expect(fake.sockets.map(({ app }) => app)).toEqual([
    "xapp-first",
    "xapp-second",
  ]);

  await until(() => fake.sockets[0]?.socket.readyState === 3);
});

test("a reply in a thread a Session posted to reaches it, even while it is offline", async () => {
  const fake = fakeSlack();
  await using t = await started(fake);

  await addBot(t, "team-bot");
  await until(() => fake.sockets.length === 1);

  const session = await t.session({ owner: person("ana") });

  expect(
    await t.tool(
      "slack_post",
      { channel: "C1", text: "Deploy is done." },
      { session },
    ),
  ).toEqual({
    text: "Posted to C1 as team-bot (ts 1700.0001). Replies in thread 1700.0001 come back here.",
    isError: false,
  });

  expect(fake.posted).toEqual([{ channel: "C1", text: "Deploy is done." }]);

  await session.online(false);

  await fake.sends({
    type: "message",
    user: "U2",
    channel: "C1",
    ts: "1700.0002",
    thread_ts: "1700.0001",
    channel_type: "channel",
    text: "Thanks! Which version?",
  });

  expect(session.queued()).toHaveLength(1);
  expect(t.emitted("slack.message")).toEqual([]);

  await session.online(true);

  const [reply] = await until(
    () => session.delivered(),
    (delivered) => delivered.length === 1,
  );

  expect(reply?.text).toEndWith("from <@U2>:\n\nThanks! Which version?");
  expect(reply?.turn).toBe(true);

  expect(reply?.notice).toMatchObject({
    kind: "slack_reply",
    data: { user: "U2" },
  });
});

test("slack_post names the bots the person may post as when it can't tell which", async () => {
  const fake = fakeSlack();
  await using t = await started(fake);

  await addBot(t, "alerts");
  await addBot(t, "team-bot");

  const own = await t.session({ owner: person("ana") });

  expect(
    await t.tool("slack_post", { channel: "C1", text: "Hi" }, { session: own }),
  ).toEqual({
    text: "name one of these bots: alerts, team-bot",
    isError: true,
  });

  expect(
    await t.tool(
      "slack_post",
      { channel: "C1", text: "Hi", bot: "nope" },
      { session: own },
    ),
  ).toEqual({
    text: "name one of these bots: alerts, team-bot",
    isError: true,
  });

  const others = await t.session({ owner: person("bo") });

  expect(
    t.tool("slack_post", { channel: "C1", text: "Hi" }, { session: others }),
  ).rejects.toThrow("slack_post isn't offered in this Session");
});

test("slack_post posts in team work only as bots the team uses, never a person's", async () => {
  const fake = fakeSlack();
  await using t = await started(fake);

  await addBot(t, "anas-bot");

  const team = await t.session({ owner: "team", startedBy: "ana" });

  expect(
    t.tool("slack_post", { channel: "C1", text: "Hi" }, { session: team }),
  ).rejects.toThrow("slack_post isn't offered in this Session");

  const { bots } = (await t.config()) as {
    bots: readonly Record<string, unknown>[];
  };

  await t.editConfig({
    bots: bots.map((bot) => ({ ...bot, users: ["team"] })),
  });

  expect(
    await t.tool(
      "slack_post",
      { channel: "C1", text: "Hi" },
      { session: team },
    ),
  ).toMatchObject({ isError: false });

  expect(fake.posted).toEqual([{ channel: "C1", text: "Hi" }]);
});

// A plugin that starts work from Slack's events, as routines do, so its
// Sessions' questions wait past the turn.
let waits: Questions | undefined;

const starter = defineServer(
  definePlugin({
    id: "starter",
    title: "Starter",
    description: "Starts work whose questions wait.",
  }),
  ({ questions }) => {
    waits = questions;
  },
);

test("a run's question goes back to the Slack thread its work came from, and a channel member's reply answers it", async () => {
  const fake = fakeSlack();
  await using t = await started(fake, undefined, [askServer, starter]);

  await addBot(t, "team-bot");
  await until(() => fake.sockets.length === 1);

  const session = await t.session({ owner: person("ana") });

  waits?.wait(session.id, {
    origin: {
      event: "slack.mention",
      fields: { bot: "team-bot", channel: "C1", ts: "2.0", threadTs: "" },
    },
    owner: "ana",
  });

  expect(
    await asks(session, {
      id: "why",
      prompt: "Which region?",
      type: "text",
      placeholder: null,
    }),
  ).toMatchObject({
    wait: "message",
  });

  await until(() => fake.posted.length === 1);

  expect(fake.posted).toEqual([
    {
      channel: "C1",
      thread_ts: "2.0",
      text: expect.stringMatching(
        /^Pi is waiting for an answer\.\n\n\*Which region\?\*\n\nIt waits until .+\n\nReply in this thread to answer\.$/,
      ) as unknown as string,
    },
  ]);

  const reply = (user: string, said: string) => ({
    type: "message",
    user,
    channel: "C1",
    ts: `3.${user}`,
    thread_ts: "2.0",
    channel_type: "channel",
    text: said,
  });

  await fake.sends(reply("U9", "us-east"));
  await until(() => t.emitted("slack.message").length === 1);

  await fake.sends(reply("U1", "eu-west"));

  const told = await until(
    () => session.delivered(),
    (delivered) => delivered.length === 1,
  );

  expect(told[0]?.text).toEndWith("from <@U1>:\n\neu-west");
  expect(t.emitted("slack.message")).toHaveLength(1);
});

// The Session asks, as the Ask plugin's Session part does for ask_user.
async function asks(
  session: TestSession,
  question: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  const asked = await session.api.raw(
    `/runner/sessions/${session.id}/ext/ask/questions`,
    {
      method: "POST",
      body: JSON.stringify({
        questions: [{ label: "Q1", context: null, ...question }],
        defaults: {},
      }),
    },
  );

  return asked.json();
}
