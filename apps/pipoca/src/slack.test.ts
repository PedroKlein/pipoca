import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  protocolVersion,
  versionHeader,
  type Work,
  type WorkPoll,
} from "@pipoca/protocol";
import type { ServerWebSocket } from "bun";
import { readSse } from "@pipoca/protocol";
import { runnerCredentials } from "./testdata/runners";
import { testServer, type TestServer } from "./testdata/harness";

let configDir: string;
let server: TestServer;
let slack: ReturnType<typeof Bun.serve>;
let socket: ServerWebSocket<unknown> | undefined;
let acknowledged: string[];
let posted: Record<string, unknown>[];
let streams: AsyncGenerator[];

beforeEach(() => {
  acknowledged = [];
  posted = [];
  streams = [];
  socket = undefined;

  // Slack's Web API and its Socket Mode WebSocket, which know one bot.
  slack = Bun.serve({
    port: 0,
    fetch: async (request, served) => {
      const url = new URL(request.url);
      const token = request.headers.get("authorization");

      if (url.pathname === "/socket") {
        served.upgrade(request, { data: undefined });

        return undefined;
      }

      switch (url.pathname) {
        case "/api/auth.test":
          return Response.json(
            token === "Bearer xoxb-good"
              ? { ok: true, team: "Acme", user_id: "UBOT" }
              : { ok: false, error: "invalid_auth" },
          );
        case "/api/apps.connections.open":
          return Response.json(
            token === "Bearer xapp-good"
              ? { ok: true, url: `ws://127.0.0.1:${String(slack.port)}/socket` }
              : { ok: false, error: "invalid_auth" },
          );
        case "/api/chat.postMessage":
          posted.push((await request.json()) as Record<string, unknown>);

          return Response.json({ ok: true, channel: "C1", ts: "1700.0001" });
        default:
          return Response.json({ ok: false, error: "unknown_method" });
      }
    },
    websocket: {
      open: (opened) => {
        socket = opened;
        opened.send(JSON.stringify({ type: "hello" }));
      },
      message: (_from, message) => {
        const { envelope_id: id } = JSON.parse(String(message)) as {
          envelope_id: string;
        };

        acknowledged.push(id);
      },
    },
  });

  configDir = mkdtempSync(join(tmpdir(), "pipoca-config-"));

  writeFileSync(
    join(configDir, "pipoca.json"),
    JSON.stringify({
      slack: { api: `http://127.0.0.1:${String(slack.port)}/api` },
    }),
  );

  server = testServer({
    configDir,
    runners: { pollWaitMs: 0 },
  });
});

afterEach(async () => {
  await Promise.all(streams.map(async (stream) => stream.return(undefined)));
  await server.close();
  await slack.stop(true);
});

async function addBot(): Promise<void> {
  expect(
    (
      await server.api("/api/plugins/slack/bots", {
        body: {
          name: "team-bot",
          appToken: "xapp-good",
          botToken: "xoxb-good",
        },
      })
    ).status,
  ).toBe(201);

  for (let tries = 0; tries < 100 && socket === undefined; tries++) {
    await Bun.sleep(20);
  }
}

let envelopes = 0;

// Slack sends an event down the socket, and waits for its acknowledgement.
async function slackSends(event: Record<string, unknown>): Promise<void> {
  envelopes += 1;
  const id = `envelope-${String(envelopes)}`;

  socket?.send(
    JSON.stringify({
      envelope_id: id,
      type: "events_api",
      payload: { event },
    }),
  );

  for (let tries = 0; tries < 100 && !acknowledged.includes(id); tries++) {
    await Bun.sleep(10);
  }
}

const heard = (): readonly string[] =>
  server.logs.filter((line) => line.startsWith("routine heard an event"));

test("an admin adds a Slack bot, and its mentions reach routines", async () => {
  expect(
    (
      await server.api("/api/plugins/slack/bots", {
        body: {
          name: "team-bot",
          appToken: "xapp-good",
          botToken: "xoxb-bad",
        },
      })
    ).status,
  ).toBe(400);

  await addBot();

  const file = readFileSync(join(configDir, "pipoca.json"), "utf8");
  expect(file).not.toContain("xoxb-good");
  expect(file).not.toContain("xapp-good");

  expect(await (await server.api("/api/plugins/slack/bots")).json()).toEqual([
    {
      name: "team-bot",
      team: "Acme",
      botUser: "UBOT",
      connected: true,
      error: null,
    },
  ]);

  await server.api("/api/plugins/routines/routines/answer", {
    method: "PUT",
    body: {
      title: "Answer questions in #help",
      triggers: [{ event: "slack.mention", filter: { channel: "C1" } }],
      run: {
        prompt: "Answer the question.",
        workspace: { kind: "folder", path: "/srv/a" },
      },
      key: ["channel", "ts"],
    },
  });

  await slackSends({
    type: "app_mention",
    user: "UBOT",
    channel: "C1",
    ts: "1.0",
    text: "<@UBOT> my own",
  });

  await slackSends({
    type: "app_mention",
    user: "U1",
    channel: "C2",
    ts: "2.0",
    text: "<@UBOT> elsewhere",
  });

  expect(acknowledged).toHaveLength(2);
  expect(heard()).toEqual([]);

  await slackSends({
    type: "app_mention",
    user: "U1",
    channel: "C1",
    ts: "3.0",
    text: "<@UBOT> how do I deploy?",
  });

  expect(heard()).toHaveLength(1);
  expect(heard()[0]).toContain('"key":"C1/3.0"');
});

test("a bot written into pipoca.json by hand takes its tokens from the environment", async () => {
  await server.close();

  process.env["PIPOCA_TEST_SLACK_APP"] = "xapp-good";
  process.env["PIPOCA_TEST_SLACK_BOT"] = "xoxb-good";

  writeFileSync(
    join(configDir, "pipoca.json"),
    JSON.stringify({
      slack: {
        api: `http://127.0.0.1:${String(slack.port)}/api`,
        bots: [
          {
            name: "team-bot",
            team: "Acme",
            botUser: "UBOT",
            appToken: { env: "PIPOCA_TEST_SLACK_APP" },
            botToken: { env: "PIPOCA_TEST_SLACK_BOT" },
            users: [],
          },
        ],
      },
    }),
  );

  server = testServer({ configDir, runners: { pollWaitMs: 0 } });

  for (let tries = 0; tries < 100 && socket === undefined; tries++) {
    await Bun.sleep(20);
  }

  expect(await (await server.api("/api/plugins/slack/bots")).json()).toEqual([
    {
      name: "team-bot",
      team: "Acme",
      botUser: "UBOT",
      connected: true,
      error: null,
    },
  ]);

  expect(process.env["PIPOCA_TEST_SLACK_BOT"]).toBeUndefined();
});

test("a Session posts as the bot, and replies in its thread come back to it", async () => {
  await addBot();

  const token = await runnerCredentials(server, server.signedIn).token(
    "laptop",
    "laptops",
  );

  await server.api("/api/sessions", {
    body: {
      workspace: { kind: "folder", path: "/srv/a" },
    },
  });

  const agent = async (path: string, body?: unknown): Promise<Response> =>
    fetch(new URL(path, server.url), {
      method: body === undefined ? "GET" : "POST",
      headers: {
        [versionHeader]: String(protocolVersion),
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });

  const poll: WorkPoll = { running: [], folders: ["/srv/a"], models: [] };

  const work = (await (await agent("/agent/work", poll)).json()) as Work;
  const [started] = work.start;

  const session = `/agent/sessions/${started?.sessionId ?? ""}`;
  const generation = String(started?.generation ?? 0);

  const commands = readSse(
    await agent(`${session}/commands?generation=${generation}`),
    10_000,
  );

  streams.push(commands);

  const next = async (type: string): Promise<Record<string, unknown>> => {
    for (;;) {
      const read: IteratorResult<unknown> = await commands.next();

      if (read.done === true) {
        throw new Error(`no ${type} command`);
      }

      const command = read.value as Record<string, unknown>;

      if (command["type"] === type) {
        return command;
      }
    }
  };

  await agent(`${session}/tool-calls`, {
    generation: started?.generation,
    id: "call-1",
    name: "slack_post",
    input: { channel: "C1", text: "Deploy is done." },
  });

  expect((await next("tool_result"))["result"]).toEqual({
    text: "Posted to C1 as team-bot (ts 1700.0001). Replies in thread 1700.0001 come back here.",
    isError: false,
  });

  expect(posted).toEqual([{ channel: "C1", text: "Deploy is done." }]);

  await slackSends({
    type: "message",
    user: "U2",
    channel: "C1",
    ts: "1700.0002",
    thread_ts: "1700.0001",
    channel_type: "channel",
    text: "Thanks! Which version?",
  });

  const reply = await next("notice");

  expect(reply["text"]).toEndWith("from <@U2>:\n\nThanks! Which version?");

  expect(reply["notice"]).toMatchObject({
    plugin: "slack",
    kind: "slack_reply",
  });
}, 15_000);
