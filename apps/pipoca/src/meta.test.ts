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
import type {
  Assignment,
  Permission,
  Prompt,
  Session,
  SessionEvent,
  SlashCommand,
} from "@pipoca/protocol";
import { json, testServer, type TestServer } from "./testdata/harness";
import { until } from "@pipoca/plugins/testing";
import { runnerCredentials } from "./testdata/runners";
import { readSse } from "@pipoca/protocol";

let root: string;
let faux: ReturnType<typeof fauxProvider>;
let server: TestServer;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "pipoca-meta-")));
  faux = fauxProvider();

  const runtime = await ModelRuntime.create({
    authPath: join(root, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  });

  runtime.registerNativeProvider(faux.provider);

  server = testServer({
    runners: { pollWaitMs: 100, offlineAfterMs: 1000 },
    agent: {
      provider: "local",
      dataDir: join(root, "local"),
      extensionPaths: [],
      folders: [root],
      models: { runtime, model: faux.getModel() },
    },
    disabledPlugins: ["subagents"],
  });
});

afterEach(async () => {
  await server.close();
  await rm(root, { recursive: true, force: true });
});

async function environmentReady(): Promise<void> {
  await until(
    async () =>
      (await json<unknown[]>(server.api("/api/environments"))).length > 0,
  );
}

async function startMeta(text: string): Promise<Session> {
  await environmentReady();

  return json<Session>(
    server.api("/api/plugins/meta/sessions", { body: { text } }),
  );
}

async function follow(
  sessionId: string,
  done: (events: readonly SessionEvent[]) => boolean,
): Promise<SessionEvent[]> {
  const events: SessionEvent[] = [];
  for await (const event of readSse(
    await server.api(`/api/sessions/${sessionId}/events`),
  )) {
    events.push(event as SessionEvent);
    if (done(events)) {
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

test("starts a meta-session on the meta Profile and keeps it out of the Session list", async () => {
  faux.setResponses([
    (context) =>
      fauxAssistantMessage([
        fauxText(
          JSON.stringify(context.messages).includes("Pipoca's assistant")
            ? "the assistant answers"
            : "someone else answers",
        ),
      ]),
  ]);

  const session = await startMeta("What can you do?");
  await follow(session.id, entriesInclude("the assistant answers"));

  const listed = await json<Session[]>(server.api("/api/sessions"));
  const owned = await json<Session[]>(server.api("/api/plugins/meta/sessions"));

  expect(listed.map(({ id }) => id)).not.toContain(session.id);
  expect(owned.map(({ id }) => id)).toEqual([session.id]);
});

test("starts a meta-session as the person who asked for it", async () => {
  faux.setResponses([fauxAssistantMessage([fauxText("hello")])]);

  const session = await startMeta("What can you do?");

  const { user } = await json<{ user: { id: string } }>(
    server.api("/api/auth"),
  );

  expect(session.startedBy).toBe(user.id);
});

test("a meta-session belongs to the person who asked for it", async () => {
  faux.setResponses([fauxAssistantMessage([fauxText("hello")])]);

  const session = await startMeta("What can you do?");

  const { user } = await json<{ user: { id: string } }>(
    server.api("/api/auth"),
  );

  expect(session.ownedBy).toBe(`person:${user.id}`);
});

test("refuses a meta-session without a first message", async () => {
  await environmentReady();

  const response = await server.api("/api/plugins/meta/sessions", {
    body: { text: " " },
  });

  expect(response.status).toBe(400);
});

test("answers a method the meta-session list has no route for as not found", async () => {
  const response = await server.api("/api/plugins/meta/sessions", {
    method: "DELETE",
  });

  expect(response.status).toBe(404);

  expect(await response.json()).toEqual({
    error: "not_found",
    message: "no route sessions",
  });
});

async function environmentId(): Promise<string> {
  await environmentReady();

  const [environment] = await json<{ id: string }[]>(
    server.api("/api/environments"),
  );

  return environment?.id ?? "";
}

const rename = (id: string, name: string): ReturnType<typeof fauxToolCall> =>
  fauxToolCall("environments_update", { id, name });

// Environment changes are deferred, so the model loads them first.
const searched = fauxAssistantMessage(
  [fauxToolCall("tool_search", { query: "change an Environment" })],
  { stopReason: "toolUse" },
);

test("asks before a destructive call, names what it changes, runs it only when allowed, and never asks for reads", async () => {
  const environment = await environmentId();

  faux.setResponses([
    searched,
    fauxAssistantMessage(
      [fauxToolCall("sessions_list", {}), rename(environment, "first")],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage([rename(environment, "second")], {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage([fauxText("all done")]),
  ]);

  const session = await startMeta("Run something");

  const asked: Prompt[] = [];

  const answer = async (value: Permission): Promise<void> => {
    const events = await follow(session.id, (all) =>
      prompts(all).some(({ id }) => !asked.some((seen) => seen.id === id)),
    );

    const prompt = prompts(events).find(
      ({ id }) => !asked.some((seen) => seen.id === id),
    );

    asked.push(...(prompt ? [prompt] : []));

    await server.api(`/api/sessions/${session.id}/commands`, {
      body: {
        type: "answer",
        id: prompt?.id,
        value,
      },
    });
  };

  await answer("deny");
  await answer("once");

  const events = await follow(session.id, entriesInclude("all done"));

  const transcript = events
    .flatMap((e) => (e.type === "entry" ? [e.entry] : []))
    .join("\n");

  const names = (
    await json<{ name: string }[]>(server.api("/api/environments"))
  ).map(({ name }) => name);

  expect(asked.map(({ kind, title }) => [kind, title])).toEqual([
    ["permission", "Change the Environment “local”?"],
    ["permission", "Change the Environment “local”?"],
  ]);

  expect(transcript).toContain("The user didn't allow environments_update.");
  expect(names).toEqual(["second"]);
});

test("loads the meta-session's confirm only in meta-sessions", async () => {
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("bash", { command: "echo ran" })], {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage([fauxText("all done")]),
  ]);

  await environmentReady();

  const session = await json<Session>(
    server.api("/api/sessions", {
      body: {
        workspace: { kind: "folder", path: root },
        firstMessage: "Run something",
      },
    }),
  );

  const events = await follow(session.id, entriesInclude("all done"));

  expect(prompts(events)).toEqual([]);

  expect(
    events.some((e) => e.type === "entry" && e.entry.includes("ran\\n")),
  ).toBe(true);
});

const commandsOf = (
  events: readonly SessionEvent[],
): readonly SlashCommand[] | undefined =>
  events.flatMap((e) =>
    e.type === "live" && e.event.type === "commands" ? [e.event.commands] : [],
  )[0];

test("loads only the Session parts the meta plugin allows in a meta-session", async () => {
  faux.setResponses([
    fauxAssistantMessage([fauxText("hi")]),
    fauxAssistantMessage([fauxText("hi")]),
  ]);

  const metaSession = await startMeta("Hello");

  const ordinary = await json<Session>(
    server.api("/api/sessions", {
      body: { workspace: { kind: "folder", path: root } },
    }),
  );

  const names = async (id: string): Promise<string[]> =>
    (
      commandsOf(await follow(id, (all) => commandsOf(all) !== undefined)) ?? []
    ).map(({ name }) => name);

  expect(await names(ordinary.id)).toContain("pr");
  expect(await names(metaSession.id)).not.toContain("pr");
});

test("shows a destructive call's fields as labelled values, leaving out ids and empty ones", async () => {
  const id = await environmentId();

  faux.setResponses([
    searched,
    fauxAssistantMessage(
      [
        fauxToolCall("environments_update", {
          id,
          name: "",
          setupScript: `echo ${"x".repeat(900)}; echo the end`,
          variables: { API_URL: "https://example.test" },
        }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage([fauxText("all done")]),
  ]);

  const session = await startMeta("Run something");

  const [asked] = prompts(
    await follow(session.id, (all) => prompts(all).length > 0),
  );

  await server.api(`/api/sessions/${session.id}/commands`, {
    body: {
      type: "answer",
      id: asked?.id,
      value: "deny",
    },
  });

  expect(asked?.kind === "permission" && asked.details).toEqual([
    {
      label: "Setup script",
      value: `echo ${"x".repeat(900)}; echo the end`,
    },
    { label: "Variables", value: "API_URL: https://example.test" },
  ]);
});

test("stops asking about a tool the user allowed for the rest of the Session", async () => {
  const environment = await environmentId();

  faux.setResponses([
    searched,
    fauxAssistantMessage([rename(environment, "first")], {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage([rename(environment, "second")], {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage([fauxText("all done")]),
  ]);

  const session = await startMeta("Rename it twice");

  const [asked] = prompts(
    await follow(session.id, (all) => prompts(all).length > 0),
  );

  await server.api(`/api/sessions/${session.id}/commands`, {
    body: {
      type: "answer",
      id: asked?.id,
      value: "session",
    },
  });

  const events = await follow(session.id, entriesInclude("all done"));

  const names = (
    await json<{ name: string }[]>(server.api("/api/environments"))
  ).map(({ name }) => name);

  expect(prompts(events).filter(({ id }) => id !== asked?.id)).toEqual([]);
  expect(names).toEqual(["second"]);
});

test("asks the user questions without asking permission first", async () => {
  faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall("ask_user", {
          questions: [
            { id: "repo", label: "Repo", prompt: "Which one?", type: "text" },
          ],
        }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage([fauxText("all done")]),
  ]);

  const session = await startMeta("Ask me something");

  const [asked] = prompts(
    await follow(session.id, (all) => prompts(all).length > 0),
  );

  await server.api(`/api/sessions/${session.id}/commands`, {
    body: {
      type: "answer",
      id: asked?.id,
      value: null,
    },
  });

  expect(asked?.kind).toBe("questions");
});

test("stops a turn that waits on a confirm", async () => {
  const id = await environmentId();

  faux.setResponses([
    searched,
    fauxAssistantMessage([rename(id, "renamed")], { stopReason: "toolUse" }),
  ]);

  const session = await startMeta("Run something");
  await follow(session.id, (all) => prompts(all).length > 0);

  await server.api(`/api/sessions/${session.id}/commands`, {
    body: { type: "abort" },
  });

  await follow(session.id, (all) =>
    all.some((e) => e.type === "session" && e.session.status === "idle"),
  );
});

test("hands a runner only the allowed Session parts and requires the meta one", async () => {
  const bare = testServer({ runners: { pollWaitMs: 0 } });

  try {
    const runners = runnerCredentials(bare, bare.signedIn);
    const token = await runners.token("vm");

    const post = async (path: string, body: unknown): Promise<Session> =>
      json<Session>(bare.api(path, { body }));

    const metaSession = await post("/api/plugins/meta/sessions", {
      text: "Hello",
    });

    const ordinary = await post("/api/sessions", {
      workspace: { kind: "folder", path: "/work" },
    });

    const work = await json<{ start: Assignment[] }>(
      fetch(new URL("/agent/work", bare.url), {
        method: "POST",
        headers: {
          "pipoca-protocol": "4",
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ running: [], folders: ["/work"], models: [] }),
      }),
    );

    const of = (id: string): Assignment | undefined =>
      work.start.find(({ sessionId }) => sessionId === id);

    expect(of(metaSession.id)?.plugins).toEqual([
      "ask",
      "models",
      "meta",
      "logins",
    ]);

    expect(of(metaSession.id)?.requiredPlugins).toEqual(["meta"]);
    expect(of(ordinary.id)?.plugins).not.toContain("meta");
    expect(of(ordinary.id)?.requiredPlugins).toEqual([]);
  } finally {
    await bare.close();
  }
});
