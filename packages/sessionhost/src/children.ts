import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type AgentSession,
  createMcpExtension,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionHandler,
  type InlineExtension,
  type McpExtensionOptions,
  type McpServerConfig,
  type McpServerEntry,
  type SessionStartEvent,
  type ToolDefinition,
  type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import type { ChildOptions } from "@pipoca/plugins/host";

export interface ChildTools {
  // As Pi's tools option takes them.
  readonly tools: readonly string[];
  readonly extensionPaths: readonly string[];
  readonly extensionFactories: readonly InlineExtension[];
}

// How long a child's first call to an MCP tool waits for its server.
const connectMs = 60_000;

// What a child loads for the tools it names: only the parent's extensions
// that registered one of them, as fresh instances, and an MCP extension with
// only the Profile's servers it names (ADR 0075).
export async function childTools(
  parent: AgentSession,
  agentDir: string,
  child: Pick<ChildOptions, "tools" | "mcp">,
  mcp: McpExtensionOptions,
): Promise<ChildTools> {
  const servers =
    (child.mcp?.length ?? 0) > 0 ||
    child.tools.some((tool) => tool.startsWith("mcp__"))
      ? await profileServers(agentDir)
      : [];

  const tools = [
    ...child.tools,
    ...servers
      .filter(({ name }) => child.mcp?.includes(name) === true)
      .map(({ name }) => `${toolPrefix(name)}*`),
  ];

  const named = matcher(tools);

  const extensionPaths = parent.resourceLoader
    .getExtensions()
    .extensions.filter(
      ({ path, tools: registered }) =>
        !path.startsWith("<") &&
        !path.startsWith("builtin:") &&
        [...registered.keys()].some(named),
    )
    .map(({ resolvedPath }) => resolvedPath);

  const serverOf = (name: string): McpServerEntry | undefined =>
    servers.find((server) => name.startsWith(toolPrefix(server.name)));

  const offered = parent
    .getAllTools()
    .filter(
      ({ name }) =>
        named(name) &&
        serverOf(name) !== undefined &&
        parent.getToolDefinition(name)?.exposure !== "hidden",
    );

  const used = servers.filter((server) =>
    offered.some(({ name }) => serverOf(name) === server),
  );

  return {
    tools,
    extensionPaths,
    extensionFactories:
      used.length === 0
        ? []
        : [
            {
              name: "mcp",
              factory: lazyMcp(
                createMcpExtension({
                  ...mcp,
                  loadConfig: () => ({ servers: used, errors: [] }),
                }),
                offered,
              ),
            },
          ],
  };
}

// The Profile's MCP servers, offering their tools to the model directly.
async function profileServers(
  agentDir: string,
): Promise<readonly McpServerEntry[]> {
  const source = join(agentDir, "mcp.json");

  const file = await readFile(source, "utf8").then(
    (text) =>
      JSON.parse(text) as {
        readonly mcpServers?: Readonly<Record<string, McpServerConfig>>;
      },
    () => ({ mcpServers: undefined }),
  );

  return Object.entries(file.mcpServers ?? {}).flatMap(([name, config]) => {
    const { toolExposure: _, ...rest } = config;

    return config.enabled === false
      ? []
      : [
          {
            name,
            config: { ...rest, exposure: "direct" as const },
            source,
            scope: "global" as const,
          },
        ];
  });
}

// Pi's MCP extension connects its servers when the session starts. Here it
// starts on the first call to one of the offered tools, which are declared
// from the parent's schemas until then and run the extension's own tools.
function lazyMcp(
  mcp: (pi: ExtensionAPI) => void | Promise<void>,
  offered: readonly ToolInfo[],
): (pi: ExtensionAPI) => Promise<void> {
  return async (pi) => {
    const starts: ExtensionHandler<SessionStartEvent>[] = [];
    const arrivals = new Map(offered.map(({ name }) => [name, waitable()]));
    let begin: (() => void) | undefined;

    const failed = (message: string): void => {
      for (const arrival of arrivals.values()) {
        arrival.reject(new Error(message));
      }
    };

    const held: Partial<ExtensionAPI> = {
      on: ((event: string, handler: ExtensionHandler<SessionStartEvent>) => {
        if (event !== "session_start") {
          return pi.on(event as "session_start", handler);
        }

        starts.push(handler);

        return () => undefined;
      }) as ExtensionAPI["on"],
      registerTool: (tool) => {
        const arrival = arrivals.get(tool.name);

        if (arrival === undefined) {
          pi.registerTool(tool);
        } else {
          arrival.resolve(tool as ToolDefinition);
        }
      },
    };

    await mcp(Object.assign(Object.create(pi) as ExtensionAPI, held));

    pi.on("session_start", (event, ctx) => {
      begin = () => {
        for (const start of starts) {
          void start(event, watched(ctx, failed));
        }
      };
    });

    for (const { name, description, parameters, promptGuidelines } of offered) {
      pi.registerTool({
        name,
        label: name,
        description,
        parameters,
        ...(promptGuidelines !== undefined && { promptGuidelines }),
        execute: async (id, params, signal, onUpdate, ctx) => {
          begin?.();
          begin = undefined;

          const tool = await within(
            arrivals.get(name)?.promise ?? Promise.reject(new Error(name)),
            signal,
            `The MCP tool ${name} didn't become available.`,
          );

          return tool.execute(id, params, signal, onUpdate, ctx);
        },
      });
    }
  };
}

// The context the extension starts with, which reports a server that failed
// or needs a sign-in as a warning.
function watched(
  ctx: ExtensionContext,
  failed: (message: string) => void,
): ExtensionContext {
  const notify = (
    message: string,
    type?: "info" | "warning" | "error",
  ): void => {
    if (type === "warning" || type === "error") {
      failed(message);
    }

    ctx.ui.notify(message, type);
  };

  const ui: unknown = Object.create(ctx.ui, { notify: { value: notify } });

  return Object.create(ctx, { ui: { value: ui } }) as ExtensionContext;
}

interface Waitable<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
}

function waitable(): Waitable<ToolDefinition> {
  let resolve: (value: ToolDefinition) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;

  const promise = new Promise<ToolDefinition>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });

  promise.catch(() => undefined);

  return { promise, resolve, reject };
}

async function within<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  timedOut: string,
): Promise<T> {
  const ends = AbortSignal.any([
    AbortSignal.timeout(connectMs),
    ...(signal ? [signal] : []),
  ]);

  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      ends.addEventListener("abort", () => {
        reject(new Error(signal?.aborted === true ? "Aborted." : timedOut));
      });
    }),
  ]);
}

// Pi's names for a server's tools start with this.
function toolPrefix(server: string): string {
  return `mcp__${server.replace(/[^A-Za-z0-9_]/g, "_")}__`;
}

// As Pi matches its tools option, where * matches any characters.
function matcher(entries: readonly string[]): (name: string) => boolean {
  const patterns = entries.map(
    (entry) =>
      new RegExp(
        `^${entry
          .split("*")
          .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
          .join(".*")}$`,
      ),
  );

  return (name) => patterns.some((pattern) => pattern.test(name));
}
