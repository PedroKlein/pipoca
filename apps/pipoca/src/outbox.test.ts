import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  definePlugin,
  defineServer,
  type ServerContext,
  type ToolOutput,
  Type,
} from "@pipoca/plugins";
import {
  type Assignment,
  type Command,
  type Environment,
  readSse,
  type Session,
} from "@pipoca/protocol";
import { runnerCredentials } from "./testdata/runners";
import { json, testServer, type TestServer } from "./testdata/harness";

let root: string;
let server: TestServer;
let sender: ServerContext["sessions"];
let other: ServerContext["sessions"];
let answer: (result: ToolOutput) => void;

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
    builtIns: false,
    servers: [
      defineServer(
        definePlugin({ id: "sender", title: "Sender", description: "" }),
        (context) => {
          sender = context.sessions;

          context.tools.define({
            name: "slow",
            description: "Answers when the test says",
            params: Type.Object({}),
            run: async () =>
              new Promise<ToolOutput>((resolve) => {
                answer = resolve;
              }),
          });
        },
      ),
      defineServer(
        definePlugin({ id: "other", title: "Other", description: "" }),
        (context) => {
          other = context.sessions;
        },
      ),
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

  expect(sender.send(session.id, { text: "First", turn: true })).toBe("queued");

  sender.send(session.id, { text: "Some context", turn: false });

  sender.send(session.id, {
    text: "Build failed",
    turn: false,
    notice: { kind: "build", data: { id: 7 } },
  });

  sender.send(session.id, { text: "Second", turn: true });

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

  sender.send(session.id, { text: "Before the restart", turn: true });

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

  sender.send(session.id, { text: "Too late", turn: true });

  await server.api(`/api/sessions/${session.id}`, {
    method: "PATCH",
    body: { archived: true },
  });

  const refused = sender.send(session.id, { text: "Later still", turn: true });

  await server.api(`/api/sessions/${session.id}`, {
    method: "PATCH",
    body: { archived: false },
  });

  const assigned = await claim(token);
  sender.send(session.id, { text: "Back again", turn: true });

  expect(refused).toBe("gone");

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

test("loses nothing sent to a host whose stream falls behind, and sends the rest once it reconnects", async () => {
  const { token, session } = await laptop();
  const assigned = await claim(token);

  const behind = await fetch(
    new URL(
      `/runner/sessions/${session.id}/commands?generation=${String(assigned.generation)}`,
      server.url,
    ),
    { headers: runnerHeaders(token) },
  );

  const sent = Array.from({ length: 6 }, (_, at) => String(at + 1));

  for (const n of sent) {
    sender.send(session.id, {
      text: `${n} ${"x".repeat(500_000)}`,
      turn: true,
    });
  }

  const texts = (commands: readonly unknown[]): string[] =>
    commands.map((command) =>
      (command as Command).type === "message"
        ? ((command as { text: string }).text.split(" ")[0] ?? "")
        : "",
    );

  const first: unknown[] = [];

  try {
    for await (const command of readSse(behind, 3000)) {
      first.push(command);
    }
  } catch {
    // The stream ends when it falls behind.
  }

  const rest = await received(token, assigned, sent.length - first.length);

  expect([...texts(first), ...texts(rest)]).toEqual(sent);
});

test("sends a message with a dedupe key once while it waits", async () => {
  const { token, session } = await laptop();

  for (let i = 0; i < 2; i += 1) {
    sender.send(session.id, {
      text: "Checks failed",
      turn: true,
      dedupe: "pr-1",
    });
  }

  sender.send(session.id, { text: "Merged", turn: true });

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

  answer("too late");
  await Bun.sleep(0);
  sender.send(session.id, { text: "Next", turn: true });

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
