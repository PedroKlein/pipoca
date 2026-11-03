import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Prompt, Session, SessionEvent } from "@pipoca/protocol";
import { serve } from "./serve";
import { firstUser } from "./testdata/sign-in";
import { readSse } from "./sse";

let root: string;
let faux: ReturnType<typeof fauxProvider>;
let server: ReturnType<typeof serve>;
let signedIn: () => Promise<string>;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "pipoca-routines-")));
  faux = fauxProvider();

  const runtime = await ModelRuntime.create({
    authPath: join(root, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  });

  runtime.registerNativeProvider(faux.provider);
  const logs: string[] = [];

  server = serve({
    port: 0,
    database: ":memory:",
    sessions: { pollWaitMs: 100, offlineAfterMs: 1000 },
    agent: {
      provider: "local",
      dataDir: join(root, "local"),
      extensionPaths: [],
      folders: [root],
      models: { runtime, model: faux.getModel() },
    },
    disabledPlugins: ["subagents"],
    log: (message, fields) => {
      logs.push(`${message} ${JSON.stringify(fields)}`);
    },
  });

  signedIn = firstUser(server, logs);
});

afterEach(async () => {
  await server.stop();
  await rm(root, { recursive: true, force: true });
});

async function api(path: string, body?: unknown): Promise<Response> {
  return fetch(new URL(path, server.url), {
    method: body === undefined ? "GET" : "POST",
    headers: {
      cookie: await signedIn(),
      ...(body !== undefined && { "content-type": "application/json" }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}

async function json<T>(response: Promise<Response>): Promise<T> {
  return (await (await response).json()) as T;
}

async function environmentReady(): Promise<void> {
  while ((await json<unknown[]>(api("/api/environments"))).length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function createSession(): Promise<Session> {
  await environmentReady();

  return json<Session>(
    api("/api/sessions", { workspace: { kind: "folder", path: root } }),
  );
}

async function follow(
  sessionId: string,
  until: (events: readonly SessionEvent[]) => boolean,
): Promise<SessionEvent[]> {
  const events: SessionEvent[] = [];
  for await (const event of readSse(
    await api(`/api/sessions/${sessionId}/events`),
  )) {
    events.push(event as SessionEvent);
    if (until(events)) {
      break;
    }
  }

  return events;
}

const entriesInclude =
  (text: string) =>
  (events: readonly SessionEvent[]): boolean =>
    events.some((e) => e.type === "entry" && e.entry.includes(text));

const prompts = (events: readonly SessionEvent[]): Prompt[] =>
  events.flatMap((e) =>
    e.type === "live" && e.event.type === "prompt" ? [e.event.prompt] : [],
  );

// A routine's run answers as a run; the Session that made it, as itself.
const reply = (asRun: string, asSelf: string) =>
  ((context) =>
    fauxAssistantMessage([
      fauxText(
        JSON.stringify(context).includes("You are running the routine")
          ? asRun
          : asSelf,
      ),
    ])) satisfies Parameters<typeof faux.setResponses>[0][number];

test("a Session makes a routine after the user allows it, and the routine runs once as a test", async () => {
  const routine = {
    title: "Summarise new issues",
    triggers: [{ cron: "0 8 * * 1-5", timeZone: "Europe/Berlin" }],
    run: {
      prompt: "Summarise the new issues.",
      workspace: { kind: "folder", path: root },
    },
  };

  faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall("routines", {
          action: "create",
          name: "daily-issues",
          routine,
          summary: "Every weekday at 08:00 Berlin time, summarise new issues.",
        }),
      ],
      { stopReason: "toolUse" },
    ),
    reply("two new issues", "made it"),
    reply("two new issues", "made it"),
  ]);

  const session = await createSession();

  await api(`/api/sessions/${session.id}/commands`, {
    type: "message",
    text: "every weekday morning, summarise new issues",
  });

  const asked = prompts(
    await follow(session.id, (all) => prompts(all).length > 0),
  );

  expect(asked.map(({ kind, title }) => [kind, title])).toEqual([
    ["permission", "Create the routine “daily-issues”?"],
  ]);

  await api(`/api/sessions/${session.id}/commands`, {
    type: "answer",
    id: asked[0]?.id,
    value: "once",
  });

  const events = await follow(session.id, entriesInclude("made it"));
  expect(entriesInclude("ran it once as a test")(events)).toBe(true);

  const [listed] = await json<
    { name: string; lastRun: { sessionId: string } }[]
  >(api("/api/plugins/routines/routines"));

  expect(listed?.name).toBe("daily-issues");

  await follow(
    listed?.lastRun.sessionId ?? "",
    entriesInclude("two new issues"),
  );
}, 30_000);

test("a Session can't make a routine the user doesn't allow", async () => {
  faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall("routines", {
          action: "create",
          name: "nightly",
          routine: {},
          summary: "Every night.",
        }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage([fauxText("fine")]),
  ]);

  const session = await createSession();

  await api(`/api/sessions/${session.id}/commands`, {
    type: "message",
    text: "every night",
  });

  const asked = prompts(
    await follow(session.id, (all) => prompts(all).length > 0),
  );

  await api(`/api/sessions/${session.id}/commands`, {
    type: "answer",
    id: asked[0]?.id,
    value: "deny",
  });

  const events = await follow(session.id, entriesInclude("fine"));

  expect(
    entriesInclude("The user didn't allow creating the routine.")(events),
  ).toBe(true);

  expect(await json(api("/api/plugins/routines/routines"))).toEqual([]);
}, 30_000);
