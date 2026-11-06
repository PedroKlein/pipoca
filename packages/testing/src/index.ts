import { validateToolArguments } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { pluginTest } from "@pipoca/pipoca/plugin-test";
import {
  type ConfigValue,
  owners,
  type PluginDefinition,
  type SessionCloud,
  type SessionPart,
  type SessionPlugin,
  type Store,
  type ServerPart,
  type TypedClient,
  type KernelEvent,
} from "@pipoca/plugins";
import { sessionConfig } from "@pipoca/plugins/host";
import {
  type ActsAs,
  type GitLogin,
  type Method,
  type Owner,
  type WorkspaceRequest,
  systemClock,
  systemTimer,
} from "@pipoca/protocol";
import { setUpPart } from "@pipoca/sessionhost";

export { until } from "@pipoca/plugins/testing";

export interface TestPerson {
  readonly id: string;
  readonly name?: string;
  readonly admin?: boolean;
}

// A config value as pipoca.json holds it: any field may be left to its
// default, and a secret may name an environment variable.
type InFile<T> = T extends string
  ? T | { readonly env: string }
  : T extends readonly (infer I)[]
    ? readonly InFile<I>[]
    : T extends object
      ? { readonly [K in keyof T]?: InFile<T[K]> }
      : T;

export interface TestPluginOptions<
  P extends PluginDefinition = PluginDefinition,
> {
  // The plugin's key in pipoca.json.
  readonly config?: InFile<ConfigValue<P>>;
  readonly people?: readonly TestPerson[];
  // More plugins on the same kernel, by their server parts or, without one,
  // their definitions.
  readonly plugins?: readonly (ServerPart | PluginDefinition)[];
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
  // Connects or drops its host. Connected, it has taken what the outbox
  // held once this settles.
  readonly online: (on: boolean) => Promise<void>;
  readonly delivered: () => readonly {
    readonly text: string;
    readonly turn: boolean;
    readonly notice?: unknown;
  }[];
  readonly queued: () => readonly { readonly text: string }[];
  // What its runner signed git in with when it last took the Session.
  readonly gitLogins: () => readonly GitLogin[];
  // A person's message to Pi, as one of the test's people sends it. It has
  // reached the host, when the host is online, once this settles.
  readonly send: (personId: string, text: string) => Promise<void>;
  readonly transcript: (lines: readonly unknown[]) => Promise<void>;
  // A turn of Pi's that writes these lines and ends. Its host says where the
  // turn ended, and with uploaded false, the lines reach the server only
  // with a later transcript call.
  readonly turn: (
    lines: readonly unknown[],
    o?: { readonly uploaded?: boolean },
  ) => Promise<void>;
  readonly archive: () => Promise<void>;
}

export interface PluginTest {
  readonly as: (personId: string) => TypedClient & {
    readonly raw: (
      method: Method,
      path: string,
      init?: RequestInit,
    ) => Promise<Response>;
    // The kernel's own routes, such as /api/profiles, as the person.
    // A body is sent as JSON.
    readonly kernel: (
      method: Method,
      path: string,
      body?: unknown,
      headers?: Readonly<Record<string, string>>,
    ) => Promise<Response>;
  };
  readonly public: () => {
    readonly raw: (
      method: Method,
      path: string,
      init?: RequestInit,
    ) => Promise<Response>;
    // The kernel's own routes, as a browser that sends only these headers.
    readonly kernel: (
      method: Method,
      path: string,
      headers?: Readonly<Record<string, string>>,
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
    readonly actsAs?: ActsAs;
    // A folder of the test's own unless it says.
    readonly workspace?: WorkspaceRequest;
  }) => Promise<TestSession>;
  // An Environment whose runner hosts the Sessions started in it, such as
  // the ones the plugin starts itself.
  readonly environment: (o: {
    readonly owner: Owner;
  }) => Promise<{ readonly id: string }>;
  // Hosts a Session the plugin started in one of the test's Environments.
  readonly attach: (sessionId: string) => Promise<TestSession>;
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
  // Writes the plugin's key in pipoca.json, as someone editing the file.
  readonly editConfig: (
    config: Readonly<Record<string, unknown>>,
  ) => Promise<void>;
  // Stops the server and starts a new one on the same database.
  readonly restart: () => Promise<void>;
  readonly store: Store;
  // The plugin's key in pipoca.json as the file holds it, secrets sealed.
  readonly config: () => Promise<unknown>;
  readonly topics: readonly string[];
  readonly log: readonly {
    readonly message: string;
    readonly fields?: unknown;
  }[];
  readonly close: () => Promise<void>;
  readonly [Symbol.asyncDispose]: () => Promise<void>;
}

// The plugin on the real server, its tables in an SQLite database of its
// own, with a clock that moves only when the test says.
export async function testPlugin<P extends PluginDefinition>(
  plugin: ServerPart<P> | P,
  o: TestPluginOptions<P> = {},
): Promise<PluginTest> {
  return pluginTest(plugin, o);
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
  // Pi's working directory for the part's tools.
  readonly cwd?: string;
};

// A Session part against a stand-in for Pi, set up as the Session host sets
// it up. Members of the cloud the test doesn't pass throw when called,
// except publish, which it records.
export async function testSession(
  plugin: SessionPlugin | SessionPart,
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

  if ("setup" in plugin) {
    const { config } = plugin.plugin;

    const { settings: _settings, ...host } = {
      ...given,
      config:
        config === undefined
          ? {}
          : sessionConfig(config, cloud.config ?? {}, given.log),
      clock: systemClock,
      timer: systemTimer,
    };

    const { tools: direct, extensions } = await setUpPart(plugin, host);

    for (const extension of extensions) {
      if ("factory" in extension) {
        await extension.factory(pi as unknown as ExtensionAPI);
      }
    }

    tools.push(...direct);
  } else {
    await plugin.extension?.(given)(pi as unknown as ExtensionAPI);
    tools.push(...((await plugin.tools?.(given)) ?? []));
  }

  const name = "setup" in plugin ? plugin.plugin.id : plugin.name;

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
          { cwd: cloud.cwd ?? process.cwd() } as ExtensionToolContext,
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
