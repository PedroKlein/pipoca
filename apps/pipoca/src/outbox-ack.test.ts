import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Assignment,
  type Environment,
  protocolVersion,
  readSseEvents,
  type Session,
  versionHeader,
} from "@pipoca/protocol";
import { runnerCredentials } from "./testdata/runners";
import { json, testServer, type TestServer } from "./testdata/harness";

let root: string;
let server: TestServer;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "outbox-ack-"));

  server = testServer({
    database: join(root, "server.db"),
    configDir: join(root, "config"),
    runners: { pollWaitMs: 0 },
  });
});

afterEach(async () => {
  await server.close();
  await rm(root, { recursive: true, force: true });
});

const runnerHeaders = (token: string): Record<string, string> => ({
  [versionHeader]: String(protocolVersion),
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
});

async function claimed(): Promise<{
  readonly token: string;
  readonly assigned: Assignment;
}> {
  const token = await runnerCredentials(server, server.signedIn).token(
    "laptop",
  );

  const environments = await json<Environment[]>(
    server.api("/api/environments"),
  );

  await json<Session>(
    server.api("/api/sessions", {
      body: {
        environment: environments.find(({ name }) => name === "laptop")?.id,
        workspace: { kind: "folder", path: root },
      },
    }),
  );

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

  return { token, assigned };
}

async function call(
  token: string,
  { sessionId, generation }: Assignment,
  path: string,
  body: object,
): Promise<void> {
  const response = await fetch(
    new URL(`/runner/sessions/${sessionId}/${path}`, server.url),
    {
      method: "POST",
      headers: runnerHeaders(token),
      body: JSON.stringify({ generation, ...body }),
    },
  );

  if (!response.ok) {
    throw new Error(`${path} answered ${String(response.status)}`);
  }
}

// The first command a new stream of the Session's commands brings.
async function firstOn(
  token: string,
  { sessionId, generation }: Assignment,
): Promise<{ readonly id?: string; readonly data: unknown }> {
  const stream = await fetch(
    new URL(
      `/runner/sessions/${sessionId}/commands?generation=${String(generation)}`,
      server.url,
    ),
    { headers: runnerHeaders(token) },
  );

  for await (const event of readSseEvents(stream, 3000)) {
    return event;
  }

  throw new Error("the stream ended");
}

test("sends a tool result again on the next stream until the host acknowledges it", async () => {
  const { token, assigned } = await claimed();

  const lost = firstOn(token, assigned);

  await call(token, assigned, "tool-calls", {
    id: "c1",
    name: "gone",
    input: {},
  });

  const written = await lost;

  const again = await firstOn(token, assigned);

  await call(token, assigned, "acks", { seq: Number(again.id) });
  const next = firstOn(token, assigned);

  await call(token, assigned, "tool-calls", {
    id: "c2",
    name: "gone",
    input: {},
  });

  expect(again).toEqual(written);

  expect(written.data).toMatchObject({
    type: "tool_result",
    id: "c1",
    result: { isError: true },
  });

  expect((await next).data).toMatchObject({ type: "tool_result", id: "c2" });
});
