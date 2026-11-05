import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  BadRequest,
  fieldsOf,
  HttpError,
  type KernelEvent,
  NotFound,
  readBody,
  type ServerPlugin,
  type ServerPluginContext,
  Type,
} from "@pipoca/plugins";
import {
  capabilities,
  type Environment,
  type PluginInfo,
  type PluginManifest,
  type Session,
  type SessionEvent,
} from "@pipoca/protocol";
import { runAgent } from "@pipoca/runner";
import { binary } from "./binary";
import { sessionParts } from "./session-parts";
import { closeServers, testServer, type TestServer } from "./testdata/harness";
import { until } from "@pipoca/plugins/testing";
import { readSse } from "@pipoca/protocol";

let root: string;
let faux: ReturnType<typeof fauxProvider>;
let server: TestServer;
let runtime: ModelRuntime;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "pipoca-plugins-")));
  faux = fauxProvider();
});

afterEach(async () => {
  await closeServers();
  await rm(root, { recursive: true, force: true });
});

async function start(
  plugins: readonly ServerPlugin[],
  disabledPlugins: readonly string[] = [],
  events: Readonly<Record<string, PluginManifest["events"]>> = {},
): Promise<void> {
  runtime = await ModelRuntime.create({
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
    plugins,
    manifests: plugins.map(({ name }) => ({
      id: name,
      title: name,
      description: "",
      capabilities,
      ...(events[name] !== undefined && { events: events[name] }),
    })),
    disabledPlugins,
  });
}

async function environmentReady(): Promise<void> {
  await until(
    async () =>
      ((await (await server.api("/api/environments")).json()) as unknown[])
        .length > 0,
  );
}

async function createSession(body: object = {}): Promise<Session> {
  await environmentReady();

  return (await (
    await server.api("/api/sessions", {
      body: {
        workspace: { kind: "folder", path: root },
        ...body,
      },
    })
  ).json()) as Session;
}

async function follow(
  sessionId: string,
  done: (events: readonly SessionEvent[]) => boolean,
): Promise<SessionEvent[]> {
  const controller = new AbortController();
  const response = await server.api(`/api/sessions/${sessionId}/events`);
  const events: SessionEvent[] = [];
  for await (const event of readSse(response)) {
    events.push(event as SessionEvent);
    if (done(events)) {
      break;
    }
  }

  controller.abort();

  return events;
}

const idle = (events: readonly SessionEvent[]): boolean =>
  events.at(-1)?.type === "session" &&
  events.some((e) => e.type === "session" && e.session.status === "idle");

const entriesInclude =
  (text: string) =>
  (events: readonly SessionEvent[]): boolean =>
    events.some((e) => e.type === "entry" && e.entry.includes(text));

test("serves a plugin's tools to the sessions they apply to and returns their result", async () => {
  const called: KernelEvent[] = [];
  let machines: ServerPluginContext["environments"] | undefined;

  await start([
    {
      name: "lookup",
      register: ({ tools, events, environments }) => {
        machines = environments;

        events.subscribe("ToolCalled", (event) => {
          called.push(event);
        });

        tools.register({
          name: "lookup",
          description: "Looks a key up on the server",
          parameters: {
            type: "object",
            properties: { key: { type: "string" } },
            required: ["key"],
          },
          appliesTo: (session) => session.systemPrompt === null,
          run: async (input, caller) =>
            Promise.resolve({
              text: `${(input as { key: string }).key} is 42 for ${caller.actor}`,
              isError: false,
            }),
        });
      },
    },
  ]);

  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("lookup", { key: "answer" })], {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage([fauxText("done")]),
  ]);

  const session = await createSession();
  await follow(session.id, idle);

  await server.api(`/api/sessions/${session.id}/commands`, {
    body: {
      type: "message",
      text: "look it up",
    },
  });

  const events = await follow(session.id, entriesInclude('"done"'));

  expect(entriesInclude(`answer is 42 for session:${session.id}`)(events)).toBe(
    true,
  );

  expect(called).toMatchObject([
    { type: "ToolCalled", tool: "lookup", actor: `session:${session.id}` },
  ]);

  const toolless = await createSession({ systemPrompt: "No tools here." });
  const token = machines?.runnerToken(toolless.environmentId, "local");

  const tools = await fetch(
    new URL(`/agent/sessions/${toolless.id}/tools?generation=1`, server.url),
    {
      headers: {
        "pipoca-protocol": "4",
        authorization: `Bearer ${token ?? ""}`,
      },
    },
  );

  await follow(toolless.id, idle);

  expect(await tools.json()).toEqual([]);
});

test("repairs JSON-encoded tool arguments and names the allowed choices", async () => {
  const inputs: unknown[] = [];

  await start([
    {
      name: "states",
      register: ({ tools }) => {
        tools.register({
          name: "set_state",
          description: "Sets a state",
          parameters: {
            type: "object",
            properties: {
              state: { type: "string", enum: ["open", "done"] },
              tags: { type: "array", items: { type: "string" } },
            },
            required: ["state"],
          },
          appliesTo: () => true,
          run: async (input) => {
            inputs.push(input);

            return Promise.resolve({ text: "set", isError: false });
          },
        });
      },
    },
  ]);

  faux.setResponses([
    fauxAssistantMessage(
      [fauxToolCall("set_state", { state: '"done"', tags: '["a"]' })],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage([fauxToolCall("set_state", { state: "closed" })], {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage([fauxText("finished")]),
  ]);

  const session = await createSession();
  await follow(session.id, idle);

  await server.api(`/api/sessions/${session.id}/commands`, {
    body: {
      type: "message",
      text: "set it",
    },
  });

  const events = await follow(session.id, entriesInclude('"finished"'));

  expect(inputs).toEqual([{ state: "done", tags: ["a"] }]);

  expect(
    entriesInclude(
      String.raw`state must be one of \"open\", \"done\", not \"closed\"`,
    )(events),
  ).toBe(true);
});

test("tells open pages which kind of thing changed, never what", async () => {
  await start([
    {
      name: "notes",
      register: ({ routes, changes }) => {
        routes.handle(() => {
          changes.publish("entries");

          return new Response(null, { status: 204 });
        });
      },
    },
  ]);

  const response = await server.api("/api/changes");
  const topics: string[] = [];

  const reading = (async () => {
    for await (const event of readSse(response)) {
      topics.push((event as { topic: string }).topic);
      if (topics.includes("notes.entries")) {
        break;
      }
    }
  })();

  await server.api("/api/mcp-tokens", { body: { name: "laptop" } });
  await createSession();
  await server.api("/api/plugins/notes/add", { body: {} });
  await reading;

  expect(topics).toContain("mcp-tokens");
  expect(topics).toContain("sessions");
  expect(topics.at(-1)).toBe("notes.entries");

  // The built-in runner's Environment, made at sign-up, may hear from its
  // runner meanwhile.
  expect(new Set(topics.filter((topic) => topic !== "environments"))).toEqual(
    new Set(["mcp-tokens", "sessions", "notes.entries"]),
  );
});

test("serves a tool's exposure, namespace and hints to its sessions", async () => {
  const spec = {
    name: "keys_list",
    description: "Lists the keys on the server",
    parameters: { type: "object", properties: {} },
    exposure: "deferred",
    namespace: { name: "keys", description: "Keys on the server" },
    annotations: { readOnlyHint: true },
  } as const;

  let machines: ServerPluginContext["environments"] | undefined;

  await start([
    {
      name: "keys",
      register: ({ tools, environments }) => {
        machines = environments;

        tools.register({
          ...spec,
          appliesTo: () => true,
          run: async () => Promise.resolve({ text: "none", isError: false }),
        });
      },
    },
  ]);

  const session = await createSession();
  const token = machines?.runnerToken(session.environmentId, "local");

  const tools = await fetch(
    new URL(`/agent/sessions/${session.id}/tools?generation=1`, server.url),
    {
      headers: {
        "pipoca-protocol": "4",
        authorization: `Bearer ${token ?? ""}`,
      },
    },
  );

  await follow(session.id, idle);

  expect(await tools.json()).toEqual([spec]);
});

test("starts a plugin's own Sessions on the Profile it provides, and no others", async () => {
  await start([
    {
      name: "meta",
      register: ({ profiles, routes, sessions }) => {
        const profile = profiles.provide("assistant", {
          name: "Assistant",
          packages: [],
          agentsMd: "",
          systemMd: "",
          appendSystemMd: "You are the Pipoca assistant.",
          mcpServers: {},
          settings: {},
        });

        routes.handle((_request, path, caller) => {
          const [last] = sessions.owned("chat");

          if (path === "again" && last !== undefined) {
            sessions.archive(last.id);
            sessions.unarchive(last.id);

            return Response.json(sessions.get(last.id));
          }

          return Response.json(
            sessions.start(
              {
                actor: caller.actor,
                workspace: { kind: "folder", path: root },
                profile,
              },
              "chat",
            ),
          );
        });
      },
    },
  ]);

  faux.setResponses([
    (context) =>
      fauxAssistantMessage([
        fauxText(
          JSON.stringify(context.messages).includes(
            "You are the Pipoca assistant.",
          )
            ? "on the assistant Profile"
            : "on another Profile",
        ),
      ]),
  ]);

  await environmentReady();

  const owned = (await (
    await server.api("/api/plugins/meta/start", { body: {} })
  ).json()) as Session;

  await follow(owned.id, idle);

  await server.api(`/api/sessions/${owned.id}/commands`, {
    body: {
      type: "message",
      text: "hello",
    },
  });

  await follow(owned.id, entriesInclude("on the assistant Profile"));

  const anyone = await server.api("/api/sessions", {
    body: {
      workspace: { kind: "folder", path: root },
      profile: owned.profileId,
    },
  });

  const listed = (await (await server.api("/api/profiles")).json()) as {
    id: string;
  }[];

  const again = (await (
    await server.api("/api/plugins/meta/again", { body: {} })
  ).json()) as Session;

  const fork = await server.api(`/api/sessions/${owned.id}/fork`, { body: {} });

  const profiles = (await (await server.api("/api/profiles")).json()) as {
    id: string;
    isDefault: boolean;
  }[];

  expect(((await fork.json()) as Session).profileId).toBe(
    profiles.find(({ isDefault }) => isDefault)?.id ?? "",
  );

  expect(again.archivedAt).toBeNull();
  expect(anyone.status).toBe(400);
  expect(listed.map(({ id }) => id)).not.toContain(owned.profileId);
});

test("routes requests to a plugin that keeps its own tables", async () => {
  await start([
    {
      name: "notes",
      schema: "create table notes_items (text text) strict",
      register: ({ routes, store }) => {
        routes.handle(async (request, path) => {
          if (request.method === "POST" && path === "items") {
            const { text } = (await request.json()) as { text: string };
            store.run("insert into notes_items (text) values (?)", text);

            return new Response(null, { status: 204 });
          }

          return path === "items"
            ? Response.json(store.all("select text from notes_items"))
            : Response.json({ error: "not_found" }, { status: 404 });
        });
      },
    },
    {
      name: "copier",
      schema: "create table sessions_copy (id text)",
      register: () => undefined,
    },
  ]);

  const added = await server.api("/api/plugins/notes/items", {
    body: { text: "hello" },
  });

  const items = await server.api("/api/plugins/notes/items");
  const unknown = await server.api("/api/plugins/nobody/items");

  expect(added.status).toBe(204);
  expect(await items.json()).toEqual([{ text: "hello" }]);
  expect(unknown.status).toBe(404);

  expect(await (await server.api("/api/plugins")).json()).toMatchObject([
    { id: "notes", state: "on" },
    {
      id: "copier",
      state: "failed",
      error: "plugin copier may only create copier_ tables",
    },
  ]);
});

test("resets a plugin whose tables another version made, once an admin asks", async () => {
  const database = join(root, "server.db");

  const notes = (sql: string): ServerPlugin => ({
    name: "notes",
    schema: sql,
    register: ({ routes, store }) => {
      routes.handle(async (request) => {
        if (request.method === "POST") {
          const { text } = (await request.json()) as { text: string };
          store.run("insert into notes_items (text) values (?)", text);

          return new Response(null, { status: 204 });
        }

        return Response.json(store.all("select * from notes_items"));
      });
    },
  });

  const manifests = [
    { id: "notes", title: "Notes", description: "", capabilities },
  ];

  server = testServer({
    database,
    plugins: [notes("create table notes_items (text text) strict")],
    manifests,
  });

  await server.api("/api/plugins/notes/items", { body: { text: "old" } });

  const cookie = await server.signedIn();
  await server.close();

  server = testServer({
    database,
    cookie,
    plugins: [
      notes(
        "create table notes_items (text text, pinned integer not null default 0) strict",
      ),
    ],
    manifests,
  });

  expect(await (await server.api("/api/plugins")).json()).toMatchObject([
    {
      id: "notes",
      state: "failed",
      resettable: true,
      error:
        "its tables were made by another version of notes; its data is kept until an admin resets it",
    },
  ]);

  const reset = await server.api("/api/plugin-resets/notes", {
    method: "POST",
  });

  expect(reset.status).toBe(200);
  expect(await reset.json()).toMatchObject({ id: "notes", state: "on" });

  expect(await (await server.api("/api/plugins/notes/items")).json()).toEqual(
    [],
  );

  await server.api("/api/plugins/notes/items", { body: { text: "new" } });

  expect(await (await server.api("/api/plugins/notes/items")).json()).toEqual([
    { text: "new", pinned: 0 },
  ]);

  const again = await server.api("/api/plugin-resets/notes", {
    method: "POST",
  });

  expect(again.status).toBe(400);

  expect(
    (await server.api("/api/plugin-resets/nobody", { method: "POST" })).status,
  ).toBe(404);
});

test("keeps the data of a plugin that failed for another reason than its tables", async () => {
  const database = join(root, "server.db");
  let configured = true;

  const notes: ServerPlugin = {
    name: "notes",
    schema: "create table notes_items (text text) strict",
    register: ({ routes, store }) => {
      if (!configured) {
        throw new Error("notes needs a folder");
      }

      routes.handle((request) => {
        if (request.method === "POST") {
          store.run("insert into notes_items (text) values ('kept')");

          return new Response(null, { status: 204 });
        }

        return Response.json(store.all("select text from notes_items"));
      });
    },
  };

  const manifests = [
    { id: "notes", title: "Notes", description: "", capabilities },
  ];

  server = testServer({ database, plugins: [notes], manifests });
  await server.api("/api/plugins/notes/items", { body: {} });

  const cookie = await server.signedIn();
  await server.close();

  configured = false;
  server = testServer({ database, cookie, plugins: [notes], manifests });

  const [listed] = (await (
    await server.api("/api/plugins")
  ).json()) as PluginInfo[];

  const reset = await server.api("/api/plugin-resets/notes", {
    method: "POST",
  });

  await server.close();

  configured = true;
  server = testServer({ database, cookie, plugins: [notes], manifests });

  expect(listed).toMatchObject({
    state: "failed",
    error: "notes needs a folder",
  });

  expect(listed?.resettable).toBeUndefined();
  expect(reset.status).toBe(400);

  expect(await (await server.api("/api/plugins/notes/items")).json()).toEqual([
    { text: "kept" },
  ]);
});

test("answers the errors a plugin's route throws as the server's own", async () => {
  await start([
    {
      name: "notes",
      register: ({ routes }) => {
        routes.handle(async (request, path) => {
          const { text } = fieldsOf(await readBody(request, Type.Unknown()));

          if (typeof text !== "string") {
            throw new BadRequest("text must be text");
          }

          throw path === "full"
            ? new HttpError(409, "notes are full", "notes_full")
            : new NotFound(`no note ${text}`);
        });
      },
    },
  ]);

  const answer = async (
    response: Promise<Response>,
  ): Promise<readonly unknown[]> => {
    const { status } = await response;

    return [status, await (await response).json()];
  };

  const answers = [
    await answer(server.api("/api/plugins/notes/items", { body: { text: 1 } })),
    await answer(
      server.api("/api/plugins/notes/items", { body: { text: "a" } }),
    ),
    await answer(
      server.api("/api/plugins/notes/full", { body: { text: "a" } }),
    ),
    await answer(
      fetch(new URL("/api/plugins/notes/items", server.url), {
        method: "POST",
        headers: { cookie: await server.signedIn() },
        body: "{not json",
      }),
    ),
  ];

  expect(answers).toEqual([
    [400, { error: "bad_request", message: "text must be text" }],
    [404, { error: "not_found", message: "no note a" }],
    [409, { error: "notes_full", message: "notes are full" }],
    [400, { error: "bad_request", message: "body must be JSON" }],
  ]);
});

test("publishes kernel events and starts sessions for plugins", async () => {
  const seen: string[] = [];
  let started: Session | undefined;

  await start([
    {
      name: "starter",
      register: ({ events, sessions, routes }) => {
        for (const type of [
          "SessionCreated",
          "TurnStarted",
          "TurnEnded",
          "StopAsked",
          "SessionArchived",
        ] as const) {
          events.subscribe(type, (event) => {
            const by = "actor" in event ? event.actor : undefined;

            seen.push(
              by === undefined
                ? event.type
                : `${event.type} by ${by.slice(0, by.indexOf(":"))}`,
            );
          });
        }

        routes.handle(() => {
          started = sessions.start({
            actor: "plugin:starter",
            workspace: { kind: "folder", path: root },
            systemPrompt: "You help the starter plugin.",
            firstMessage: "begin the work",
          });

          return Response.json(started);
        });
      },
    },
  ]);

  faux.setResponses([fauxAssistantMessage([fauxText("working on it")])]);
  await environmentReady();

  await server.api("/api/plugins/starter/start", { body: {} });
  const id = started?.id ?? "";
  const events = await follow(id, entriesInclude("working on it"));
  await follow(id, idle);
  await server.api(`/api/sessions/${id}/commands`, { body: { type: "abort" } });
  await server.api(`/api/sessions/${id}/archive`, { body: {} });

  expect(entriesInclude("begin the work")(events)).toBe(true);

  expect(entriesInclude("You help the starter plugin.")(events)).toBe(true);

  expect(seen).toEqual([
    "SessionCreated by plugin",
    "TurnStarted",
    "TurnEnded",
    "StopAsked by user",
    "SessionArchived by user",
  ]);
});

test("lets a plugin archive and bring back only the Sessions it owns", async () => {
  let context: ServerPluginContext | undefined;
  const seen: string[] = [];

  await start([
    {
      name: "owner",
      register: (registered) => {
        context = registered;

        registered.events.subscribe("SessionUnarchived", ({ archivedAt }) => {
          seen.push(archivedAt);
        });
      },
    },
  ]);

  await environmentReady();

  const request = {
    actor: "plugin:owner",
    workspace: { kind: "folder", path: root },
  } as const;

  const owned = context?.sessions.start(request, "board");
  const other = context?.sessions.start(request);

  context?.sessions.archive(owned?.id ?? "");
  const archivedAt = context?.sessions.get(owned?.id ?? "")?.archivedAt;
  context?.sessions.unarchive(owned?.id ?? "");

  expect(archivedAt).toBeString();
  expect(seen).toEqual([archivedAt ?? ""]);
  expect(context?.sessions.get(owned?.id ?? "")?.archivedAt).toBeNull();

  expect(() => context?.sessions.archive(other?.id ?? "")).toThrow(
    "isn't owned by owner",
  );
});

test("tells a plugin why a message did not reach a session", async () => {
  let sessions: ServerPluginContext["sessions"] | undefined;

  await start([
    {
      name: "sender",
      register: (context) => {
        sessions = context.sessions;
      },
    },
  ]);

  const session = await createSession();
  await follow(session.id, idle);
  const reached = sessions?.notify(session.id, "a note", "plugin:sender");

  await server.api(`/api/sessions/${session.id}/archive`, { body: {} });
  const archived = sessions?.send(session.id, "hello", "plugin:sender");
  const unknown = sessions?.send("missing", "hello", "plugin:sender");

  expect([reached, archived, unknown]).toEqual([
    { ok: true },
    { ok: false, reason: "archived" },
    { ok: false, reason: "not_found" },
  ]);
});

test("tells a plugin how many lines a session's transcript has", async () => {
  let sessions: ServerPluginContext["sessions"] | undefined;

  await start([
    {
      name: "counter",
      register: (context) => {
        sessions = context.sessions;
      },
    },
  ]);

  faux.setResponses([fauxAssistantMessage([fauxText("counted")])]);

  const session = await createSession();
  await follow(session.id, idle);

  await server.api(`/api/sessions/${session.id}/commands`, {
    body: {
      type: "message",
      text: "count with me",
    },
  });

  await follow(session.id, entriesInclude('"counted"'));
  const lines = sessions?.transcript(session.id) ?? [];

  expect(lines.some((line) => line.includes('"counted"'))).toBe(true);
  expect(sessions?.transcriptLength(session.id)).toBe(lines.length);
  expect(sessions?.transcriptLength("missing")).toBe(0);
});

test("tells a plugin how many transcript lines a turn ended with", async () => {
  const ended: (number | undefined)[] = [];
  let sessions: ServerPluginContext["sessions"] | undefined;

  await start([
    {
      name: "turns",
      register: (context) => {
        sessions = context.sessions;

        context.events.subscribe("TurnEnded", ({ transcriptLength }) => {
          ended.push(transcriptLength);
        });
      },
    },
  ]);

  faux.setResponses([fauxAssistantMessage([fauxText("all done")])]);

  const session = await createSession();
  await follow(session.id, idle);

  await server.api(`/api/sessions/${session.id}/commands`, {
    body: {
      type: "message",
      text: "finish up",
    },
  });

  await follow(session.id, entriesInclude('"all done"'));
  await follow(session.id, idle);

  expect(ended).toEqual([sessions?.transcriptLength(session.id)]);
  expect(sessions?.transcript(session.id).at(-1)).toContain('"all done"');
});

test("tells a plugin the events that enabled plugins declare", async () => {
  let declared: ServerPluginContext["events"]["declared"] | undefined;

  const pull = {
    title: "A pull request changed",
    fields: { type: "object", properties: { url: { type: "string" } } },
  };

  await start(
    [
      {
        name: "listener",
        register: ({ events }) => {
          declared = events.declared;
        },
      },
      { name: "hosts", register: () => undefined },
      { name: "off", register: () => undefined },
    ],
    ["off"],
    {
      hosts: { pull_request: pull },
      off: { ignored: { title: "Never", fields: {} } },
    },
  );

  expect(declared?.()).toEqual([{ type: "hosts.pull_request", ...pull }]);
});

test("leaves out plugins that are turned off", async () => {
  let registered = false;

  await start(
    [
      {
        name: "off",
        register: () => {
          registered = true;
        },
      },
    ],
    ["off"],
  );

  expect(registered).toBe(false);

  expect(await (await server.api("/api/plugins")).json()).toMatchObject([
    { id: "off", state: "off" },
  ]);

  expect((await server.api("/api/plugins/off/anything")).status).toBe(404);
});

test("turns plugins on and off, and in team work, under plugins in pipoca.json", async () => {
  const registered: string[] = [];
  const configDir = join(root, "config");
  const file = join(configDir, "pipoca.json");

  await mkdir(configDir);

  await writeFile(
    file,
    JSON.stringify({ plugins: { quiet: { personal: false } } }),
  );

  const plugin = (name: string): ServerPlugin => ({
    name,
    register: () => {
      registered.push(name);
    },
  });

  server = testServer({
    configDir,
    plugins: [plugin("quiet"), plugin("chatty"), plugin("team")],
    manifests: ["quiet", "chatty", "team"].map((id) => ({
      id,
      title: id,
      description: "",
      works: ["personal", "team"],
    })),
  });

  const listed = async (): Promise<unknown> =>
    (await server.api("/api/plugins")).json();

  expect(await listed()).toMatchObject([
    { id: "quiet", state: "off", turnedOn: false },
    { id: "chatty", state: "on", turnedOn: true, teamWork: true },
    {
      id: "team",
      state: "failed",
      error:
        "team is a key the kernel keeps in pipoca.json, so no plugin can have it",
    },
  ]);

  expect(registered).toEqual(["chatty"]);

  const switched = await server.api("/api/plugins/chatty", {
    method: "PATCH",
    body: { teamWork: false },
  });

  expect(await switched.json()).toMatchObject({ teamWork: false });

  expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
    plugins: { quiet: { personal: false }, chatty: { team: false } },
  });

  await writeFile(
    file,
    JSON.stringify({ plugins: { chatty: { team: true } } }),
  );

  expect(await listed()).toMatchObject([
    { id: "quiet" },
    { id: "chatty", teamWork: true },
    { id: "team" },
  ]);
});

// A runner a plugin started, such as a pod, with the token the plugin gave it.
function startRunner(
  name: string,
  token: string,
  exitWhenIdleMs?: number,
): { readonly done: Promise<void>; readonly logs: string[] } {
  const logs: string[] = [];

  const done = runAgent({
    binary,
    server: server.url.href,
    provider: name,
    credential: { token },
    ...(exitWhenIdleMs !== undefined && { exitWhenIdleMs }),
    dataDir: join(root, name),
    extensionPaths: [],
    folders: [root],
    models: { runtime, model: faux.getModel() },
    log: (message) => {
      logs.push(message);
    },
    signal: AbortSignal.timeout(30_000),
  });

  return { done, logs };
}

async function poolEnvironment(): Promise<Environment> {
  await environmentReady();

  return (
    (await (
      await server.api("/api/environments", { body: { name: "pool" } })
    ).json()) as {
      environment: Environment;
    }
  ).environment;
}

test("lets a plugin start a runner for a Session no runner can take, until it revokes it", async () => {
  let context: ServerPluginContext | undefined;

  await start([
    {
      name: "machines",
      register: (registered) => {
        context = registered;
      },
    },
  ]);

  const environment = await poolEnvironment();
  faux.setResponses([fauxAssistantMessage([fauxText("hi from a pod")])]);

  const session = await createSession({
    environment: environment.id,
    workspace: { kind: "folder", path: root },
  });

  expect(
    context?.environments.unplaced(environment.id).map(({ id }) => id),
  ).toEqual([session.id]);

  const pod = startRunner(
    "pod-1",
    context?.environments.runnerToken(environment.id, "pod-1") ?? "",
  );

  await follow(
    session.id,
    (events) =>
      idle(events) &&
      events.some((e) => e.type === "session" && e.session.runner === "pod-1"),
  );

  expect(context?.environments.unplaced(environment.id)).toEqual([]);

  await server.api(`/api/environments/${environment.id}/key`, { body: {} });

  await new Promise((resolve) => setTimeout(resolve, 500));

  expect(
    pod.logs.filter((line) => line.includes("let this runner go")),
  ).toEqual([]);

  context?.environments.revokeRunner(environment.id, "pod-1");

  const stopped = await pod.done.then(
    () => undefined,
    (error: unknown) => error,
  );

  expect(stopped).toEqual(new Error("the server let this runner go"));
});

test("stops a runner started to exit when idle once it runs no Session", async () => {
  let context: ServerPluginContext | undefined;

  await start([
    {
      name: "machines",
      register: (registered) => {
        context = registered;
      },
    },
  ]);

  const environment = await poolEnvironment();
  faux.setResponses([fauxAssistantMessage([fauxText("hi")])]);

  const session = await createSession({
    environment: environment.id,
    workspace: { kind: "folder", path: root },
  });

  const pod = startRunner(
    "pod-1",
    context?.environments.runnerToken(environment.id, "pod-1") ?? "",
    300,
  );

  await follow(
    session.id,
    (events) =>
      idle(events) &&
      events.some((e) => e.type === "session" && e.session.runner === "pod-1"),
  );

  await new Promise((resolve) => setTimeout(resolve, 600));

  expect(pod.logs).not.toContain("no sessions for a while; stopping");

  await server.api(`/api/sessions/${session.id}/archive`, { body: {} });
  await pod.done;

  expect(pod.logs).toContain("no sessions for a while; stopping");
});

test("hosts an installed plugin's Session part the assignment names by hash", async () => {
  const asked: string[] = [];

  const { plugins, pluginSettings } = await sessionParts(
    {
      plugins: ["ask", "extra"],
      requiredPlugins: ["extra"],
      installedParts: { extra: "abc", unused: "def" },
      pluginSettings: { extra: { greeting: "hi" } },
    },
    async (name, hash) => {
      asked.push(`${name}@${hash}`);

      return Promise.resolve({ name });
    },
  );

  expect(asked).toEqual(["extra@abc"]);
  expect(plugins.map(({ name }) => name)).toEqual(["ask", "extra"]);
  expect(pluginSettings["extra"]).toEqual({ greeting: "hi" });
});

test("refuses to host a Session part this runner doesn't have", () => {
  const parts = sessionParts(
    { plugins: ["ask", "newer"], requiredPlugins: ["newer"] },
    async () => Promise.reject(new Error("no installed parts here")),
  );

  expect(parts).rejects.toThrow("this runner has no newer plugin");
});
