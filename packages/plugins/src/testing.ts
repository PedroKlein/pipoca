import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { validateToolArguments } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionFactory,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  type Method,
  type Owner,
  type Session,
  systemClock,
  systemTimer,
} from "@pipoca/protocol";
import type { TypedClient } from "./client";
import { sessionConfig } from "./config";
import type { PluginDefinition } from "./definition";
import { eventBus } from "./events";
import { isHttpError } from "./http";
import { owners } from "./owners";
import type {
  KernelEvent,
  PluginRoute,
  PluginStore,
  RouteCaller,
  ServerPluginContext,
  SessionCloud,
  SessionPlugin,
} from "./plugin";
import { envSecrets, secretRefs } from "./secrets";
import type { Store } from "./server";
import type { SessionPart } from "./session";

export interface TestPerson {
  readonly id: string;
  readonly name?: string;
  readonly admin?: boolean;
}

export interface TestPluginOptions {
  // The plugin's key in pipoca.json.
  readonly config?: Readonly<Record<string, unknown>>;
  readonly people?: readonly TestPerson[];
  // More plugins on the same kernel.
  readonly plugins?: readonly PluginDefinition[];
  // Answers the plugins' outbound HTTP; without it, any throws.
  readonly fetch?: (request: Request) => Response | Promise<Response>;
  readonly solo?: boolean;
}

export interface ToolAnswer {
  readonly text: string;
  readonly isError: boolean;
  readonly details?: unknown;
}

export type Duration = number | `${number}${"s" | "m" | "h" | "d"}`;

export interface TestSession {
  readonly id: string;
  readonly environmentId: string;
  // The plugin's routes, called as its Session part calls them.
  readonly api: TypedClient;
  // Connects or drops its host, which takes what the outbox holds.
  readonly online: (on: boolean) => Promise<void>;
  // What reached its host, which arrives a moment after it is sent.
  readonly delivered: () => readonly {
    readonly text: string;
    readonly turn: boolean;
    readonly notice?: unknown;
  }[];
  readonly queued: () => readonly { readonly text: string }[];
  // A person's message to Pi, as one of the test's people sends it.
  readonly send: (personId: string, text: string) => Promise<void>;
  readonly transcript: (lines: readonly unknown[]) => Promise<void>;
  readonly archive: () => Promise<void>;
}

export interface PluginTest {
  readonly as: (personId: string) => TypedClient & {
    readonly raw: (
      method: Method,
      path: string,
      init?: RequestInit,
    ) => Promise<Response>;
  };
  readonly public: () => {
    readonly raw: (
      method: Method,
      path: string,
      init?: RequestInit,
    ) => Promise<Response>;
    readonly webhook: (
      path: string,
      body: string,
      secret: string,
    ) => Promise<Response>;
  };
  readonly session: (o: {
    readonly owner: Owner;
    readonly startedBy?: string;
    readonly key?: string;
    readonly plugin?: string;
  }) => Promise<TestSession>;
  readonly tool: (
    name: string,
    input: unknown,
    o: { readonly session: TestSession; readonly answer?: "allow" | "deny" },
  ) => Promise<ToolAnswer>;
  readonly emit: (event: KernelEvent) => void;
  readonly emitted: (type: string) => readonly {
    readonly fields: unknown;
    readonly to: readonly Owner[];
  }[];
  readonly clock: {
    readonly now: () => number;
    readonly advance: (by: Duration) => Promise<void>;
  };
  // Stops the server and starts a new one on the same database.
  readonly restart: () => Promise<void>;
  readonly store: Store;
  readonly topics: readonly string[];
  readonly log: readonly {
    readonly message: string;
    readonly fields?: unknown;
  }[];
  readonly close: () => Promise<void>;
}

type Kernel = (
  plugin: PluginDefinition,
  o: TestPluginOptions,
) => Promise<PluginTest>;

// Set by the repository's test setup, since the kernel is the server's.
const kernelKey = Symbol.for("pipoca.test-kernel");

// The plugin on the real server, its tables in an SQLite database of its
// own, with a clock that moves only when the test says.
export async function testPlugin(
  plugin: PluginDefinition,
  o: TestPluginOptions = {},
): Promise<PluginTest> {
  const kernel = (globalThis as Record<symbol, unknown>)[kernelKey] as
    (() => Promise<Kernel>) | undefined;

  if (kernel === undefined) {
    throw new Error(
      "testPlugin needs the Pipoca server; run bun test from the repository's root",
    );
  }

  return (await kernel())(plugin, o);
}

export function person(id: string): Owner {
  return owners.of(id);
}

export interface SessionTest {
  readonly tool: (name: string, input: unknown) => Promise<ToolAnswer>;
  readonly published: (key: string) => unknown;
}

export type SessionFakes = Partial<SessionCloud> & {
  // The plugin's key in pipoca.json, for a part defineSession made.
  readonly config?: Readonly<Record<string, unknown>>;
};

type PartSetUp = (
  part: SessionPart,
  host: unknown,
) => Promise<{
  readonly tools: readonly ToolDefinition[];
  readonly extensions: readonly { readonly factory: ExtensionFactory }[];
}>;

// Set by the repository's test setup, since the Session host sets parts up.
const sessionHostKey = Symbol.for("pipoca.test-session-host");

// A Session part against a stand-in for Pi, set up as the Session host sets
// it up. Members of the cloud the test doesn't pass throw when called,
// except publish, which it records.
export async function testSession(
  plugin: SessionPlugin | PluginDefinition,
  cloud: SessionFakes = {},
): Promise<SessionTest> {
  const notFaked = (name: string) => (): never => {
    throw new Error(`${name} is not faked; pass it to testSession`);
  };

  const published = new Map<string, unknown>();
  const tools: ToolDefinition[] = [];

  const given: SessionCloud = {
    askQuestions: notFaked("askQuestions"),
    askPermission: notFaked("askPermission"),
    checkouts: [],
    settings: {},
    request: notFaked("request"),
    log: () => undefined,
    startChild: notFaked("startChild"),
    ...cloud,
    publish: (key, data, options) => {
      published.set(key, data);
      cloud.publish?.(key, data, options);
    },
  };

  const pi = {
    registerTool: (tool: ToolDefinition) => {
      tools.push(tool);
    },
    registerCommand: () => undefined,
    on: () => undefined,
  };

  if ("id" in plugin) {
    const part = (await plugin.session?.())?.default as SessionPart | undefined;

    if (part?.plugin !== plugin) {
      throw new Error(
        `the Session part of ${plugin.id} isn't one defineSession made for it`,
      );
    }

    const setUp = await partSetUp();

    const { settings: _settings, ...host } = {
      ...given,
      config:
        plugin.config === undefined
          ? {}
          : sessionConfig(plugin.config, cloud.config ?? {}, given.log),
      clock: systemClock,
      timer: systemTimer,
    };

    const { tools: direct, extensions } = await setUp(part, host);

    for (const { factory } of extensions) {
      await factory(pi as unknown as ExtensionAPI);
    }

    tools.push(...direct);
  } else {
    await plugin.extension?.(given)(pi as unknown as ExtensionAPI);
    tools.push(...((await plugin.tools?.(given)) ?? []));
  }

  const name = "id" in plugin ? plugin.id : plugin.name;

  return {
    tool: async (toolName, input) => {
      const tool = tools.findLast((each) => each.name === toolName);

      if (tool === undefined) {
        throw new Error(`${name} has no tool ${toolName}`);
      }

      try {
        const args: unknown = validateToolArguments(tool, {
          type: "toolCall",
          id: "call-1",
          name: toolName,
          arguments: (tool.prepareArguments?.(input) ?? input) as never,
        });

        const { content, details } = await tool.execute(
          "call-1",
          args,
          undefined,
          undefined,
          {} as ExtensionToolContext,
        );

        return {
          text: content
            .flatMap((part) => (part.type === "text" ? [part.text] : []))
            .join("\n"),
          isError: false,
          ...(details !== undefined && { details }),
        };
      } catch (error) {
        return {
          text: error instanceof Error ? error.message : String(error),
          isError: true,
        };
      }
    },
    published: (key) => published.get(key),
  };
}

async function partSetUp(): Promise<PartSetUp> {
  const load = (globalThis as Record<symbol, unknown>)[sessionHostKey] as
    (() => Promise<PartSetUp>) | undefined;

  if (load === undefined) {
    throw new Error(
      "testSession needs the Session host; run bun test from the repository's root",
    );
  }

  return load();
}

// A store in memory with the plugin's tables, for a plugin's tests. It seals
// nothing, and has no kernel tables for the plugin's to reference.
export function memoryStore(schema?: string): PluginStore {
  const db = new DatabaseSync(":memory:");
  db.exec("pragma foreign_keys = off");

  if (schema !== undefined) {
    db.exec(schema);
  }

  return {
    all: (sql, ...params) =>
      db.prepare(sql).all(...(params as SQLInputValue[])),
    run: (sql, ...params) => {
      db.prepare(sql).run(...(params as SQLInputValue[]));
    },
    transaction: (fn) => {
      db.exec("savepoint test");

      try {
        const result = fn();
        db.exec("release test");

        return result;
      } catch (error) {
        db.exec("rollback to test; release test");
        throw error;
      }
    },
    seal: (text) => text,
    open: (sealed) => sealed,
  };
}

// A context for calling a server plugin's register in a test. Members the
// test doesn't pass throw when called, except the ones every plugin gets,
// which do nothing or keep to memory.
export function fakeContext(
  members: Partial<ServerPluginContext> = {},
): ServerPluginContext {
  const notFaked = (name: string) => (): never => {
    throw new Error(`${name} is not faked; pass it to fakeContext`);
  };

  return {
    tools: { register: notFaked("tools.register") },
    toolsets: {
      register: notFaked("toolsets.register"),
      loadInOwnSessions: notFaked("toolsets.loadInOwnSessions"),
      asks: notFaked("toolsets.asks"),
      call: notFaked("toolsets.call"),
    },
    events: {
      ...eventBus((_type, error) => {
        throw error;
      }),
      declared: () => [],
    },
    changes: { publish: () => undefined },
    sessions: {
      start: notFaked("sessions.start"),
      get: notFaked("sessions.get"),
      owned: notFaked("sessions.owned"),
      loadOnly: notFaked("sessions.loadOnly"),
      archive: notFaked("sessions.archive"),
      unarchive: notFaked("sessions.unarchive"),
      send: notFaked("sessions.send"),
      notify: notFaked("sessions.notify"),
      bind: notFaked("sessions.bind"),
      boundTo: notFaked("sessions.boundTo"),
      unbind: notFaked("sessions.unbind"),
      transcript: notFaked("sessions.transcript"),
      transcriptLength: notFaked("sessions.transcriptLength"),
      sees: notFaked("sessions.sees"),
    },
    environments: {
      list: notFaked("environments.list"),
      unplaced: notFaked("environments.unplaced"),
      runnerToken: notFaked("environments.runnerToken"),
      revokeRunner: notFaked("environments.revokeRunner"),
      startsRunners: notFaked("environments.startsRunners"),
      templates: () => [],
      templateConfig: {
        get: () => undefined,
        set: notFaked("environments.templateConfig.set"),
      },
    },
    profiles: {
      provide: notFaked("profiles.provide"),
      mcpServers: () => [],
      buildsOn: () => [],
    },
    routes: { handle: notFaked("routes.handle") },
    auth: {
      offer: notFaked("auth.offer"),
      handlePublic: notFaked("auth.handlePublic"),
      userOf: notFaked("auth.userOf"),
      users: notFaked("auth.users"),
      createUser: notFaked("auth.createUser"),
      setAdmin: notFaked("auth.setAdmin"),
      invited: notFaked("auth.invited"),
      acceptInvite: notFaked("auth.acceptInvite"),
      passwordLogin: notFaked("auth.passwordLogin"),
      startSession: notFaked("auth.startSession"),
      gitLogins: notFaked("auth.gitLogins"),
    },
    models: { offer: notFaked("models.offer") },
    store: memoryStore(),
    secretRefs: secretRefs(memoryStore(), envSecrets({})),
    settings: { get: () => ({}) },
    schedule: {
      every: notFaked("schedule.every"),
      at: notFaked("schedule.at"),
      on: notFaked("schedule.on"),
      cancel: notFaked("schedule.cancel"),
      cancelPrefix: notFaked("schedule.cancelPrefix"),
      pending: notFaked("schedule.pending"),
    },
    config: {
      get: () => undefined,
      set: () => undefined,
      lockedIn: () => undefined,
      dir: "",
    },
    clock: systemClock,
    signal: new AbortController().signal,
    log: () => undefined,
    ...members,
  };
}

export function fakeSession(fields: Partial<Session> = {}): Session {
  return {
    id: "session-1",
    environmentId: "environment-1",
    owner: null,
    provider: "local",
    runner: null,
    profileId: "profile-1",
    workspace: { kind: "folder", path: "/work" },
    model: null,
    thinking: null,
    systemPrompt: null,
    firstMessage: null,
    title: null,
    status: "idle",
    generation: 1,
    createdAt: "2026-10-22T00:00:00.000Z",
    interruptedAt: null,
    error: null,
    archivedAt: null,
    workspaceRemoval: null,
    workspaceKeptReason: null,
    startedBy: null,
    actsAs: null,
    ownedBy: "person:owner",
    access: { kind: "team" },
    online: true,
    waiting: false,
    ...fields,
  };
}

// A signed-in user calling a route, the owner of fakeSession unless the test
// names another. Not an admin unless the test says.
export function fakeUser({
  id = "owner",
  admin = false,
}: { readonly id?: string; readonly admin?: boolean } = {}): RouteCaller {
  return { kind: "user", actor: `user:${id}`, admin };
}

// A plugin's route that answers what it throws as the server does, for a
// test that calls the route itself.
export function served(route: PluginRoute): PluginRoute {
  return async (...request) => {
    try {
      return await route(...request);
    } catch (error) {
      if (isHttpError(error)) {
        return Response.json(
          { ...error.details, error: error.code, message: error.message },
          { status: error.status },
        );
      }

      throw error;
    }
  };
}

// Reads until done says the value is ready, for what a test waits on.
export async function until<T>(
  read: () => T | Promise<T>,
  done: (value: T) => boolean = Boolean,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const value = await read();
    if (done(value)) {
      return value;
    }

    if (Date.now() > deadline) {
      throw new Error(`not done after ${String(timeoutMs)} ms`);
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
