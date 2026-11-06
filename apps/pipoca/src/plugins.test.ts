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
  definePlugin,
  defineServer,
  HttpError,
  type KernelEvent,
  NotFound,
  type PluginDefinition,
  type Runners,
  type ServerContext,
  StringEnum,
  Type,
} from "@pipoca/plugins";
import type { ServerPart } from "@pipoca/plugins/host";
import type {
  Environment,
  PluginInfo,
  Session,
  SessionEvent,
} from "@pipoca/protocol";
import { protocolVersion, versionHeader } from "@pipoca/protocol";
import { runAgent } from "@pipoca/runner";
import { binary } from "./binary";
import { sessionParts } from "./session-parts";
import { closeServers, testServer, type TestServer } from "./testdata/harness";
import { until } from "@pipoca/testing/until";
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

const pool = {
  kind: { label: "Pool", icon: "cloud" },
  starts: () => false,
};

function plugin(
  id: string,
  register: (ctx: ServerContext) => void = () => undefined,
  definition: Partial<PluginDefinition> = {},
): ServerPart {
  return defineServer(
    definePlugin({ id, title: id, description: "", ...definition }),
    register,
  );
}

async function start(
  servers: readonly ServerPart[],
  disabledPlugins: readonly string[] = [],
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
    builtIns: false,
    servers,
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
  const response = await server.api(`/api/sessions/${sessionId}/events`);
  const events: SessionEvent[] = [];
  for await (const event of readSse(response)) {
    events.push(event as SessionEvent);
    if (done(events)) {
      break;
    }
  }

  return events;
}

const idle = (events: readonly SessionEvent[]): boolean =>
  events.at(-1)?.type === "session" &&
  events.some((e) => e.type === "session" && e.session.status === "idle");

const entriesInclude =
  (text: string) =>
  (events: readonly SessionEvent[]): boolean =>
    events.some((e) => e.type === "entry" && e.entry.includes(text));

async function toolsOf(
  session: Session,
  runners: Runners | undefined,
): Promise<unknown> {
  const token = runners?.token(session.environmentId, "local");

  const tools = await fetch(
    new URL(`/runner/sessions/${session.id}/tools?generation=1`, server.url),
    {
      headers: {
        [versionHeader]: String(protocolVersion),
        "content-type": "application/json",
        authorization: `Bearer ${token ?? ""}`,
      },
    },
  );

  await follow(session.id, idle);

  return tools.json();
}

test("serves a plugin's tools to the sessions they apply to and returns their result", async () => {
  const called: KernelEvent[] = [];
  let machines: Runners | undefined;

  await start([
    plugin("lookup", ({ tools, events, provide }) => {
      machines = provide.runners(pool);

      events.on("ToolCalled", (event) => {
        called.push(event);
      });

      tools.define({
        name: "lookup",
        description: "Looks a key up on the server",
        params: Type.Object({ key: Type.String() }),
        when: { available: (session) => session.systemPrompt === null },
        run: ({ key }, { session }) => `${key} is 42 for ${session.id}`,
      });
    }),
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
    body: { type: "message", text: "look it up" },
  });

  const events = await follow(session.id, entriesInclude('"done"'));

  expect(entriesInclude(`answer is 42 for ${session.id}`)(events)).toBe(true);

  expect(called).toMatchObject([
    { type: "ToolCalled", tool: "lookup", actor: `session:${session.id}` },
  ]);

  const toolless = await createSession({ systemPrompt: "No tools here." });

  expect(await toolsOf(toolless, machines)).toEqual([]);
});

test("repairs JSON-encoded tool arguments and names the allowed choices", async () => {
  const inputs: unknown[] = [];

  await start([
    plugin("states", ({ tools }) => {
      tools.define({
        name: "set_state",
        description: "Sets a state",
        params: Type.Object({
          state: StringEnum(["open", "done"]),
          tags: Type.Optional(Type.Array(Type.String())),
        }),
        run: (input) => {
          inputs.push(input);

          return "set";
        },
      });
    }),
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
    body: { type: "message", text: "set it" },
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
    plugin("notes", ({ routes }) => {
      routes.post("add", { auth: "person", changes: ["entries"] }, () => ({}));
    }),
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

  await server.api("/api/me/access-tokens", { body: { name: "laptop" } });
  await createSession();
  await server.api("/api/ext/notes/add", { body: {} });
  await reading;

  expect(topics).toContain("access-tokens");
  expect(topics).toContain("sessions");
  expect(topics.at(-1)).toBe("notes.entries");

  // The built-in runner's Environment, made at sign-up, may hear from its
  // runner meanwhile.
  expect(new Set(topics.filter((topic) => topic !== "environments"))).toEqual(
    new Set(["access-tokens", "sessions", "notes.entries"]),
  );
});

test("serves a tool's exposure and hints to its sessions", async () => {
  let machines: Runners | undefined;

  await start([
    plugin("keys", ({ tools, provide }) => {
      machines = provide.runners(pool);

      tools.define({
        name: "keys_list",
        description: "Lists the keys on the server",
        params: Type.Object({}),
        exposure: "deferred",
        annotations: { readOnly: true },
        run: () => "none",
      });
    }),
  ]);

  expect(await toolsOf(await createSession(), machines)).toMatchObject([
    {
      name: "keys_list",
      description: "Lists the keys on the server",
      exposure: "deferred",
      annotations: { readOnlyHint: true },
    },
  ]);
});

test("starts a plugin's own Sessions on the Profile it provides, and no others", async () => {
  await start([
    plugin("meta", ({ provide, routes, sessions }) => {
      const profile = provide.profile("assistant", {
        name: "Assistant",
        packages: [],
        agentsMd: "",
        systemMd: "",
        appendSystemMd: "You are the Pipoca assistant.",
        mcpServers: {},
        settings: {},
      });

      routes.post("again", { auth: "person" }, () => {
        const [last] = sessions.owned("chat");

        if (last === undefined) {
          throw new NotFound("no chat");
        }

        sessions.archive(last.id);
        sessions.unarchive(last.id);

        return sessions.get(last.id);
      });

      routes.post("start", { auth: "person" }, ({ caller }) =>
        sessions.start({
          actor: `user:${caller.person.id}`,
          workspace: { kind: "folder", path: root },
          profile,
          key: "chat",
        }),
      );
    }),
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
    await server.api("/api/ext/meta/start", { body: {} })
  ).json()) as Session;

  await follow(owned.id, idle);

  await server.api(`/api/sessions/${owned.id}/commands`, {
    body: { type: "message", text: "hello" },
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
    await server.api("/api/ext/meta/again", { body: {} })
  ).json()) as Session;

  const fork = await server.api("/api/sessions", {
    body: { from: { session: owned.id } },
  });

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

test("resets a plugin whose tables another version made, and starts it at the restart", async () => {
  const database = join(root, "server.db");

  const tally = (sql: string): ServerPart =>
    plugin(
      "tally",
      ({ routes, store }) => {
        routes.post("marks", { auth: "person" }, () => {
          store.run("insert into tally_marks (n) values (1)");

          return { ok: true };
        });

        routes.get("marks", { auth: "person" }, () =>
          store.all("select n from tally_marks"),
        );
      },
      { schema: sql },
    );

  const before = tally("create table tally_marks (n integer) strict");

  const after = tally(
    "create table tally_marks (n integer, m integer not null default 0) strict",
  );

  server = testServer({ database, builtIns: false, servers: [before] });
  await server.api("/api/ext/tally/marks", { body: {} });

  const cookie = await server.signedIn();
  await server.close();

  server = testServer({ database, cookie, builtIns: false, servers: [after] });

  expect(await (await server.api("/api/plugins")).json()).toMatchObject([
    {
      id: "tally",
      state: "failed",
      resettable: true,
      error:
        "its tables were made by another version of tally; its data is kept until an admin resets it",
    },
  ]);

  const reset = await server.api("/api/plugins/tally/data", {
    method: "DELETE",
  });

  expect(reset.status).toBe(200);

  expect(await reset.json()).toMatchObject({
    id: "tally",
    state: "failed",
    error: "its data was reset; it starts when the server restarts",
  });

  expect(
    (await server.api("/api/plugins/tally/data", { method: "DELETE" })).status,
  ).toBe(400);

  expect(
    (await server.api("/api/plugins/nobody/data", { method: "DELETE" })).status,
  ).toBe(404);

  await server.close();
  server = testServer({ database, cookie, builtIns: false, servers: [after] });

  expect(await (await server.api("/api/plugins")).json()).toMatchObject([
    { id: "tally", state: "on" },
  ]);

  expect(await (await server.api("/api/ext/tally/marks")).json()).toEqual([]);
});

test("keeps the data of a plugin that failed for another reason than its tables", async () => {
  const database = join(root, "server.db");
  let configured = true;

  const notes = plugin(
    "notes",
    ({ routes, store }) => {
      if (!configured) {
        throw new Error("notes needs a folder");
      }

      routes.post("items", { auth: "person" }, () => {
        store.run("insert into notes_items (text) values ('kept')");

        return {};
      });

      routes.get("items", { auth: "person" }, () =>
        store.all("select text from notes_items"),
      );
    },
    { schema: "create table notes_items (text text) strict" },
  );

  server = testServer({ database, builtIns: false, servers: [notes] });
  await server.api("/api/ext/notes/items", { body: {} });

  const cookie = await server.signedIn();
  await server.close();

  configured = false;
  server = testServer({ database, cookie, builtIns: false, servers: [notes] });

  const [listed] = (await (
    await server.api("/api/plugins")
  ).json()) as PluginInfo[];

  const reset = await server.api("/api/plugins/notes/data", {
    method: "DELETE",
  });

  await server.close();

  configured = true;
  server = testServer({ database, cookie, builtIns: false, servers: [notes] });

  expect(listed).toMatchObject({
    state: "failed",
    error: "notes needs a folder",
  });

  expect(listed?.resettable).toBeUndefined();
  expect(reset.status).toBe(400);

  expect(await (await server.api("/api/ext/notes/items")).json()).toEqual([
    { text: "kept" },
  ]);
});

test("answers the errors a plugin's route throws as the server's own", async () => {
  await start([
    plugin("notes", ({ routes }) => {
      routes.post(
        ":kind",
        {
          auth: "person",
          body: Type.Object({ text: Type.Optional(Type.Unknown()) }),
        },
        ({ params, body: { text } }) => {
          if (typeof text !== "string") {
            throw new BadRequest("text must be text");
          }

          throw params.kind === "full"
            ? new HttpError(409, "notes are full", "notes_full")
            : new NotFound(`no note ${text}`);
        },
      );
    }),
  ]);

  const answer = async (path: string, body: object): Promise<unknown[]> => {
    const response = await server.api(path, { body });

    return [response.status, await response.json()];
  };

  expect([
    await answer("/api/ext/notes/items", { text: 1 }),
    await answer("/api/ext/notes/items", { text: "a" }),
    await answer("/api/ext/notes/full", { text: "a" }),
  ]).toEqual([
    [400, { error: "bad_request", message: "text must be text" }],
    [404, { error: "not_found", message: "no note a" }],
    [409, { error: "notes_full", message: "notes are full" }],
  ]);
});

test("publishes kernel events and starts sessions for plugins", async () => {
  const seen: string[] = [];
  let started: Session | undefined;

  await start([
    plugin("starter", ({ events, sessions, routes }) => {
      for (const type of [
        "SessionCreated",
        "TurnStarted",
        "TurnEnded",
        "StopAsked",
        "SessionArchived",
      ] as const) {
        events.on(type, (event) => {
          const by = "actor" in event ? event.actor : undefined;

          seen.push(
            by === undefined
              ? event.type
              : `${event.type} by ${by.slice(0, by.indexOf(":"))}`,
          );
        });
      }

      routes.post("start", { auth: "person" }, () => {
        started = sessions.start({
          actor: "plugin:starter",
          workspace: { kind: "folder", path: root },
          systemPrompt: "You help the starter plugin.",
          firstMessage: "begin the work",
        });

        return started;
      });
    }),
  ]);

  faux.setResponses([fauxAssistantMessage([fauxText("working on it")])]);
  await environmentReady();

  await server.api("/api/ext/starter/start", { body: {} });
  const id = started?.id ?? "";
  const events = await follow(id, entriesInclude("working on it"));
  await follow(id, idle);
  await server.api(`/api/sessions/${id}/commands`, { body: { type: "abort" } });

  await server.api(`/api/sessions/${id}`, {
    method: "PATCH",
    body: { archived: true },
  });

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
  let context: ServerContext | undefined;
  const seen: string[] = [];

  await start([
    plugin("owner", (registered) => {
      context = registered;

      registered.events.on("SessionUnarchived", ({ archivedAt }) => {
        seen.push(archivedAt);
      });
    }),
  ]);

  await environmentReady();

  const request = {
    actor: "plugin:owner",
    workspace: { kind: "folder", path: root },
  } as const;

  const owned = context?.sessions.start({ ...request, key: "board" });
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

test("tells a plugin how many transcript lines a turn ended with", async () => {
  const ended: (number | undefined)[] = [];
  let transcript: ServerContext["transcript"] | undefined;

  await start([
    plugin("turns", (context) => {
      transcript = context.transcript;

      context.events.on("TurnEnded", ({ transcriptLength }) => {
        ended.push(transcriptLength);
      });
    }),
  ]);

  faux.setResponses([fauxAssistantMessage([fauxText("all done")])]);

  const session = await createSession();
  await follow(session.id, idle);

  await server.api(`/api/sessions/${session.id}/commands`, {
    body: { type: "message", text: "finish up" },
  });

  await follow(session.id, entriesInclude('"all done"'));
  await follow(session.id, idle);

  expect(ended).toEqual([transcript?.length(session.id)]);
  expect(transcript?.lastReply(session.id)?.text).toBe("all done");
});

test("leaves out plugins that are turned off", async () => {
  let registered = false;

  await start(
    [
      plugin("off", ({ routes }) => {
        registered = true;
        routes.get("anything", { auth: "person" }, () => ({}));
      }),
    ],
    ["off"],
  );

  expect(registered).toBe(false);

  expect(await (await server.api("/api/plugins")).json()).toMatchObject([
    { id: "off", state: "off" },
  ]);

  expect((await server.api("/api/ext/off/anything")).status).toBe(404);
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

  const named = (id: string): ServerPart =>
    plugin(id, () => {
      registered.push(id);
    });

  server = testServer({
    configDir,
    builtIns: false,
    servers: [named("quiet"), named("chatty"), named("team")],
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

test("a switch in pipoca.json that doesn't fit is logged and leaves the others alone", async () => {
  const configDir = join(root, "config");

  await mkdir(configDir);

  await writeFile(
    join(configDir, "pipoca.json"),
    JSON.stringify({
      plugins: {
        quiet: { personal: false },
        broken: { personal: "yes" },
        chatty: { team: false },
      },
    }),
  );

  const named = (id: string): ServerPart => plugin(id);

  server = testServer({
    configDir,
    builtIns: false,
    servers: [named("quiet"), named("broken"), named("chatty")],
  });

  expect(await (await server.api("/api/plugins")).json()).toMatchObject([
    { id: "quiet", state: "off", turnedOn: false },
    { id: "broken", state: "on", turnedOn: true },
    { id: "chatty", state: "on", turnedOn: true, teamWork: false },
  ]);

  expect(
    server.logs.filter((line) => line.startsWith("config field skipped")),
  ).toEqual([
    'config field skipped {"field":"broken","error":"personal must be boolean"}',
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

  return (await (
    await server.api("/api/environments", { body: { name: "pool" } })
  ).json()) as Environment;
}

test("lets a plugin start a runner for a Session no runner can take, until it revokes it", async () => {
  let machines: Runners | undefined;

  await start([
    plugin("machines", ({ provide }) => {
      machines = provide.runners(pool);
    }),
  ]);

  const environment = await poolEnvironment();
  faux.setResponses([fauxAssistantMessage([fauxText("hi from a pod")])]);

  const session = await createSession({
    environment: environment.id,
    workspace: { kind: "folder", path: root },
  });

  expect(machines?.unplaced(environment.id).map(({ id }) => id)).toEqual([
    session.id,
  ]);

  const pod = startRunner(
    "pod-1",
    machines?.token(environment.id, "pod-1") ?? "",
  );

  await follow(
    session.id,
    (events) =>
      idle(events) &&
      events.some((e) => e.type === "session" && e.session.runner === "pod-1"),
  );

  expect(machines?.unplaced(environment.id)).toEqual([]);

  await server.api(`/api/environments/${environment.id}/keys`, { body: {} });

  await new Promise((resolve) => setTimeout(resolve, 500));

  expect(
    pod.logs.filter((line) => line.includes("let this runner go")),
  ).toEqual([]);

  machines?.revoke(environment.id, "pod-1");

  const stopped = await pod.done.then(
    () => undefined,
    (error: unknown) => error,
  );

  expect(stopped).toEqual(new Error("the server let this runner go"));
});

test("stops a runner started to exit when idle once it runs no Session", async () => {
  let machines: Runners | undefined;

  await start([
    plugin("machines", ({ provide }) => {
      machines = provide.runners(pool);
    }),
  ]);

  const environment = await poolEnvironment();
  faux.setResponses([fauxAssistantMessage([fauxText("hi")])]);

  const session = await createSession({
    environment: environment.id,
    workspace: { kind: "folder", path: root },
  });

  const pod = startRunner(
    "pod-1",
    machines?.token(environment.id, "pod-1") ?? "",
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

  await server.api(`/api/sessions/${session.id}`, {
    method: "PATCH",
    body: { archived: true },
  });

  await pod.done;

  expect(pod.logs).toContain("no sessions for a while; stopping");
});

test("hosts an installed plugin's Session part the assignment names by hash", async () => {
  const asked: string[] = [];

  const { parts } = await sessionParts(
    {
      plugins: ["extra"],
      requiredPlugins: ["extra"],
      installedParts: { extra: "abc", unused: "def" },
    },
    async (name, hash) => {
      asked.push(`${name}@${hash}`);

      return Promise.resolve({
        plugin: definePlugin({ id: name, title: name, description: "" }),
        setup: () => undefined,
      });
    },
  );

  expect(asked).toEqual(["extra@abc"]);
  expect(parts.map(({ plugin: { id } }) => id)).toEqual(["extra"]);
});

test("refuses to host a Session part this runner doesn't have", () => {
  const parts = sessionParts(
    { plugins: ["changes", "newer"], requiredPlugins: ["newer"] },
    async () => Promise.reject(new Error("no installed parts here")),
  );

  expect(parts).rejects.toThrow("this runner has no newer plugin");
});
