import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerPluginContext } from "@pipoca/plugins";
import {
  type Assignment,
  type Command,
  type Environment,
  readSse,
  type Session,
  type ToolResult,
} from "@pipoca/protocol";
import { runnerCredentials } from "./testdata/runners";
import { json, testServer, type TestServer } from "./testdata/harness";

let root: string;
let server: TestServer;
let sender: ServerPluginContext["sessions"];
let other: ServerPluginContext["sessions"];
let answer: (result: ToolResult) => void;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "outbox-"));
  server = start();
});

afterEach(async () => {
  await server.close();
  await rm(root, { recursive: true, force: true });
});

function start(cookie?: string): TestServer {
  return testServer({
    database: join(root, "server.db"),
    configDir: join(root, "config"),
    runners: { pollWaitMs: 0 },
    ...(cookie !== undefined && { cookie }),
    plugins: [
      {
        name: "sender",
        register: (context) => {
          sender = context.sessions;

          context.tools.register({
            name: "slow",
            description: "Answers when the test says",
            parameters: { type: "object", properties: {} },
            appliesTo: () => true,
            run: async () =>
              new Promise<ToolResult>((resolve) => {
                answer = resolve;
              }),
          });
        },
      },
      {
        name: "other",
        register: (context) => {
          other = context.sessions;
        },
      },
    ],
    manifests: [
      {
        id: "sender",
        title: "Sender",
        description: "",
        capabilities: ["sessions", "tools"],
      },
      {
        id: "other",
        title: "Other",
        description: "",
        capabilities: ["sessions"],
      },
    ],
  });
}

const runnerHeaders = (token: string): Record<string, string> => ({
  "pipoca-protocol": "4",
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
});

async function laptop(): Promise<{
  readonly token: string;
  readonly session: Session;
}> {
  const token = await runnerCredentials(server, server.signedIn).token(
    "laptop",
  );

  const environments = await json<Environment[]>(
    server.api("/api/environments"),
  );

  const session = await json<Session>(
    server.api("/api/sessions", {
      body: {
        environment: environments.find(({ name }) => name === "laptop")?.id,
        workspace: { kind: "folder", path: root },
      },
    }),
  );

  return { token, session };
}

// A poll that runs nothing, so it takes the Session in a new attempt.
async function claim(token: string): Promise<Assignment> {
  const {
    start: [assigned],
  } = await json<{ start: readonly Assignment[] }>(
    fetch(new URL("/runner/work", server.url), {
      method: "POST",
      headers: runnerHeaders(token),
      body: JSON.stringify({ running: [], folders: [], models: [] }),
    }),
  );

  if (assigned === undefined) {
    throw new Error("no Session was assigned");
  }

  return assigned;
}

async function received(
  token: string,
  { sessionId, generation }: Assignment,
  count: number,
): Promise<readonly Command[]> {
  const stream = await fetch(
    new URL(
      `/runner/sessions/${sessionId}/commands?generation=${String(generation)}`,
      server.url,
    ),
    { headers: runnerHeaders(token) },
  );

  const commands: Command[] = [];

  for await (const command of readSse(stream, 3000)) {
    commands.push(command as Command);

    if (commands.length === count) {
      break;
    }
  }

  return commands;
}

test("delivers what a plugin sends a Session before its runner connects, in order", async () => {
  const { token, session } = await laptop();

  expect(sender.send(session.id, "First", "plugin:sender")).toEqual({
    ok: true,
  });

  sender.notify(session.id, "Some context", "plugin:sender");

  sender.notify(session.id, "Build failed", "plugin:sender", {
    kind: "build",
    data: { id: 7 },
  });

  sender.send(session.id, "Second", "plugin:sender");

  const assigned = await claim(token);

  expect(await received(token, assigned, 4)).toEqual([
    {
      actor: "plugin:sender",
      type: "message",
      text: "First",
      delivery: "followUp",
    },
    { actor: "plugin:sender", type: "context", text: "Some context" },
    {
      actor: "plugin:sender",
      type: "notice",
      text: "Build failed",
      notice: { plugin: "sender", kind: "build", data: { id: 7 } },
      turn: false,
    },
    {
      actor: "plugin:sender",
      type: "message",
      text: "Second",
      delivery: "followUp",
    },
  ]);
});

test("keeps what a plugin sends a Session through a restart of the server", async () => {
  const { token, session } = await laptop();

  sender.send(session.id, "Before the restart", "plugin:sender");

  const cookie = await server.signedIn();
  await server.close();
  server = start(cookie);

  const assigned = await claim(token);

  expect(await received(token, assigned, 1)).toEqual([
    {
      actor: "plugin:sender",
      type: "message",
      text: "Before the restart",
      delivery: "followUp",
    },
  ]);
});

test("drops what waits for a Session once it is archived", async () => {
  const { token, session } = await laptop();

  sender.send(session.id, "Too late", "plugin:sender");

  await server.api(`/api/sessions/${session.id}`, {
    method: "PATCH",
    body: { archived: true },
  });

  const refused = sender.send(session.id, "Later still", "plugin:sender");

  await server.api(`/api/sessions/${session.id}`, {
    method: "PATCH",
    body: { archived: false },
  });

  const assigned = await claim(token);
  sender.send(session.id, "Back again", "plugin:sender");

  expect(refused).toEqual({ ok: false, reason: "archived" });

  expect(server.logs).toContainEqual(
    `message to a Session dropped ${JSON.stringify({
      sessionId: session.id,
      plugin: "sender",
      kind: "message",
      reason: "archived",
    })}`,
  );

  expect(await received(token, assigned, 1)).toEqual([
    expect.objectContaining({ text: "Back again" }),
  ]);
});

test("sends a message with a dedupe key once while it waits", async () => {
  const { token, session } = await laptop();

  sender.send(session.id, "Checks failed", "plugin:sender", undefined, "pr-1");
  sender.send(session.id, "Checks failed", "plugin:sender", undefined, "pr-1");
  sender.send(session.id, "Merged", "plugin:sender");

  const assigned = await claim(token);

  expect(
    (await received(token, assigned, 2)).map((command) =>
      command.type === "message" ? command.text : command.type,
    ),
  ).toEqual(["Checks failed", "Merged"]);
});

test("drops a tool result that finishes after its attempt ended", async () => {
  const { token, session } = await laptop();
  const first = await claim(token);
  const generation = first.generation;

  await fetch(
    new URL(`/runner/sessions/${session.id}/tool-calls`, server.url),
    {
      method: "POST",
      headers: runnerHeaders(token),
      body: JSON.stringify({
        generation,
        id: "call-1",
        name: "slow",
        input: {},
      }),
    },
  );

  const second = await claim(token);

  answer({ text: "too late", isError: false });
  await Bun.sleep(0);
  sender.send(session.id, "Next", "plugin:sender");

  expect(second.generation).toBe(generation + 1);

  expect(server.logs).toContainEqual(
    `message to a Session dropped ${JSON.stringify({
      sessionId: session.id,
      plugin: "sender",
      kind: "tool_result",
      generation,
      callId: "call-1",
      reason: "stale_generation",
    })}`,
  );

  expect(await received(token, second, 1)).toEqual([
    expect.objectContaining({ type: "message", text: "Next" }),
  ]);
});

test("binds an external thread to a Session per plugin until the Session is gone", async () => {
  const { session } = await laptop();
  const { session: another } = await laptop();

  sender.bind("C1:1712.3", session.id);
  other.bind("C1:1712.3", another.id);
  sender.bind("C2:1800.1", another.id);
  sender.unbind("C2:1800.1");

  const bound = [
    sender.boundTo("C1:1712.3"),
    other.boundTo("C1:1712.3"),
    sender.boundTo("C2:1800.1"),
  ];

  for (const id of [session.id, another.id]) {
    await server.api(`/api/sessions/${id}`, {
      method: "PATCH",
      body: { archived: true },
    });
  }

  await server.api(`/api/environments/${session.environmentId}`, {
    method: "DELETE",
  });

  expect(bound).toEqual([session.id, another.id, undefined]);
  expect(sender.boundTo("C1:1712.3")).toBeUndefined();

  expect(() => {
    sender.bind("C3:1900.2", session.id);
  }).toThrow("not_found");
});
