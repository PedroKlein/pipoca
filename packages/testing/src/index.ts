import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateToolArguments } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionToolContext,
  ToolDefinition,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { pluginTest } from "@pipoca/pipoca/plugin-test";
import {
  type ConfigValue,
  owners,
  type PluginDefinition,
  type SessionLogins,
  type Store,
  type TypedClient,
  type KernelEvent,
} from "@pipoca/plugins";
import {
  type ServerPart,
  sessionConfig,
  type SessionPart,
} from "@pipoca/plugins/host";
import {
  type ActsAs,
  type GitLogin,
  type Owner,
  type SessionAccess,
  type WorkspaceRequest,
  systemClock,
  systemTimer,
} from "@pipoca/protocol";
import { type PartHost, setUpPart } from "@pipoca/sessionhost";

export { until } from "./until";

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
  // The kernel's keys in pipoca.json, such as its templates.
  readonly kernelConfig?: Readonly<Record<string, unknown>>;
  readonly people?: readonly TestPerson[];
  // More plugins on the same kernel, by their server parts or, without one,
  // their definitions.
  readonly plugins?: readonly (ServerPart | PluginDefinition)[];
  // Answers the plugins' outbound HTTP; without it, any throws.
  readonly fetch?: (request: Request) => Response | Promise<Response>;
  readonly solo?: boolean;
  // What provide.runtime() names as the pipoca binary.
  readonly command?: readonly string[];
  // The environment variables the plugins read in place of the process's.
  readonly env?: Readonly<Record<string, string>>;
}

export interface ToolAnswer {
  readonly text: string;
  readonly isError: boolean;
  readonly details?: unknown;
  // Pi would stop after the call instead of going on.
  readonly endsTurn?: boolean;
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
  // Live events its host reports, such as a status or a prompt, which the
  // kernel acts on as it would a runner's.
  readonly report: (events: readonly unknown[]) => Promise<void>;
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
  readonly as: (personId: string) => TypedClient;
  // As a browser that is signed in to nothing.
  readonly public: () => TypedClient & {
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
    // A Profile of the starter's, by id, in place of their default.
    readonly profile?: string;
    readonly actsAs?: ActsAs;
    // Who steers team work, everyone in the team unless it says.
    readonly access?: SessionAccess;
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
  // Pi's event of this type, such as "agent_settled", through the part's
  // handlers, in Pi's working directory and the rest of the context given:
  // what each handler returned.
  readonly event: (
    type: string,
    fields?: Readonly<Record<string, unknown>>,
    context?: Readonly<Record<string, unknown>>,
  ) => Promise<readonly unknown[]>;
  // What the part pointed a model provider at, by its name.
  readonly provider: (name: string) => unknown;
  // The logins the part keeps for Pi, if it provides them.
  readonly modelCredentials: () => Promise<SessionLogins | undefined>;
  // A call Pi is about to make, of the part's tool or another's, such as an
  // MCP server's, through the part's tool_call hooks: the reason one blocks
  // it, or undefined when it may run.
  readonly toolCall: (
    tool: Pick<ToolInfo, "name" | "annotations">,
    input: Readonly<Record<string, unknown>>,
  ) => Promise<string | undefined>;
}

export type SessionFakes = Partial<Omit<PartHost, "config" | "clock">> & {
  // The plugin's key in pipoca.json, for a part defineSession made.
  readonly config?: Readonly<Record<string, unknown>>;
  // Pi's working directory for the part's tools.
  readonly cwd?: string;
};

// A Session part against a stand-in for Pi, set up as the Session host sets
// it up. What the test doesn't fake throws when called.
export async function testSession(
  part: SessionPart,
  fakes: SessionFakes = {},
): Promise<SessionTest> {
  const notFaked = (name: string) => (): never => {
    throw new Error(`${name} is not faked; pass it to testSession`);
  };

  const providers = new Map<string, unknown>();
  const tools: ToolDefinition[] = [];
  const { config, cwd, ...faked } = fakes;
  const { id, config: schema } = part.plugin;
  const others: Pick<ToolInfo, "name" | "annotations">[] = [];
  const hooks: ((event: unknown, ctx: unknown) => unknown)[] = [];

  const handlers: {
    readonly event: string;
    readonly run: (event: unknown, ctx: unknown) => unknown;
  }[] = [];

  const set = await setUpPart(part, {
    askQuestions: notFaked("askQuestions"),
    askPermission: notFaked("askPermission"),
    checkouts: [],
    folder: join(tmpdir(), `pipoca-part-${randomUUID()}`),
    request: notFaked("request"),
    log: () => undefined,
    startChild: notFaked("startChild"),
    publish: () => undefined,
    ...faked,
    config:
      schema === undefined
        ? {}
        : sessionConfig(schema, config ?? {}, faked.log ?? (() => undefined)),
    clock: systemClock,
    timer: faked.timer ?? systemTimer,
  });

  const pi = {
    registerTool: (tool: ToolDefinition) => {
      tools.push(tool);
    },
    registerCommand: () => undefined,
    registerProvider: (name: string, provider: unknown) => {
      providers.set(name, provider);
    },
    on: (event: string, hook: (event: unknown, ctx: unknown) => unknown) => {
      if (event === "tool_call") {
        hooks.push(hook);
      }

      handlers.push({ event, run: hook });
    },
    getAllTools: () => [...tools, ...others],
  };

  for (const extension of set.extensions) {
    if ("factory" in extension) {
      await extension.factory(pi as unknown as ExtensionAPI);
    }
  }

  tools.push(...set.tools);

  return {
    tool: async (toolName, input) => {
      const tool = tools.findLast((each) => each.name === toolName);

      if (tool === undefined) {
        throw new Error(`${id} has no tool ${toolName}`);
      }

      try {
        const args: unknown = validateToolArguments(tool, {
          type: "toolCall",
          id: "call-1",
          name: toolName,
          arguments: (tool.prepareArguments?.(input) ?? input) as never,
        });

        const { content, details, terminate } = await tool.execute(
          "call-1",
          args,
          undefined,
          undefined,
          { cwd: cwd ?? process.cwd() } as ExtensionToolContext,
        );

        return {
          text: content
            .flatMap((piece) => (piece.type === "text" ? [piece.text] : []))
            .join("\n"),
          isError: false,
          ...(details !== undefined && { details }),
          ...(terminate === true && { endsTurn: true }),
        };
      } catch (error) {
        return {
          text: error instanceof Error ? error.message : String(error),
          isError: true,
        };
      }
    },
    event: async (type, fields = {}, context = {}) => {
      const results: unknown[] = [];

      for (const handler of handlers.filter(({ event }) => event === type)) {
        results.push(
          await handler.run(
            { type, ...fields },
            { cwd: cwd ?? process.cwd(), ...context },
          ),
        );
      }

      return results;
    },
    provider: (named) => providers.get(named),
    modelCredentials: async () => set.modelCredentials?.(),
    toolCall: async (tool, input) => {
      others.push(tool);

      for (const hook of hooks) {
        const result = (await hook(
          {
            type: "tool_call",
            toolCallId: "call-1",
            toolName: tool.name,
            input,
          },
          { cwd: cwd ?? process.cwd() },
        )) as { block?: boolean; reason?: string } | undefined;

        if (result?.block === true) {
          return result.reason ?? "blocked";
        }
      }

      return undefined;
    },
  };
}
