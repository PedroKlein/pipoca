import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ExtensionFactory,
  type InlineExtension,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  isHttpError,
  isToolError,
  pluginClient,
  type SessionContext,
  type SessionPart,
  type SessionTool,
  type ToolOutput,
} from "@pipoca/plugins";
import type { Log } from "@pipoca/protocol";
import { repairArguments } from "./arguments";

export type PartHost = Omit<
  SessionContext,
  "tools" | "extension" | "config" | "api"
> & {
  readonly config: unknown;
  readonly request: (path: string, init?: RequestInit) => Promise<Response>;
};

// A Session part's tools and extensions, as Pi takes them. Its replaceable
// tools load as an extension of their own, which a user's tool of the same
// name leaves out.
export async function setUpPart(
  part: SessionPart,
  host: PartHost,
): Promise<{
  readonly tools: readonly ToolDefinition[];
  readonly extensions: readonly InlineExtension[];
}> {
  const { id } = part.plugin;
  const tools: SessionTool[] = [];
  const factories: ExtensionFactory[] = [];
  const marker = `/ext/${id}/`;

  await part.setup({
    ...host,
    tools: {
      define: (tool) => {
        tools.push(tool);
      },
    },
    extension: (factory) => {
      factories.push(factory);
    },
    config: host.config as SessionContext["config"],
    api: pluginClient(part.plugin, {
      session: "this",
      fetch: async (url, init) =>
        host.request(url.slice(url.indexOf(marker) + marker.length), init),
    }),
  });

  const piTools = (replaceable: boolean): ToolDefinition[] =>
    tools
      .filter((tool) => (tool.replaceable === true) === replaceable)
      .map((tool) => piTool(tool, host));

  const replaceable = piTools(true);

  return {
    tools: piTools(false),
    extensions: [
      ...(factories.length === 0
        ? []
        : [
            {
              name: id,
              factory: async (pi: Parameters<ExtensionFactory>[0]) => {
                for (const factory of factories) {
                  await factory(pi);
                }
              },
            },
          ]),
      ...(replaceable.length === 0
        ? []
        : [
            {
              name: `${id}:tools`,
              replaceable: true,
              factory: (pi: Parameters<ExtensionFactory>[0]) => {
                for (const tool of replaceable) {
                  pi.registerTool(tool);
                }
              },
            },
          ]),
    ],
  };
}

function piTool(
  tool: SessionTool,
  host: Pick<PartHost, "askPermission" | "log">,
): ToolDefinition {
  const schema = tool.params as unknown as Readonly<Record<string, unknown>>;

  return defineTool({
    name: tool.name,
    label: tool.label ?? tool.name,
    description: tool.description,
    parameters: Type.Unsafe<unknown>(schema),
    prepareArguments: (args) => repairArguments(args, schema),
    ...(tool.exposure && { exposure: tool.exposure }),
    ...(tool.annotations && {
      annotations: {
        ...(tool.annotations.readOnly !== undefined && {
          readOnlyHint: tool.annotations.readOnly,
        }),
        ...(tool.annotations.destructive !== undefined && {
          destructiveHint: tool.annotations.destructive,
        }),
      },
    }),
    execute: async (id, input, signal) => {
      const question = await tool.asks?.(input);

      if (
        question !== undefined &&
        (await host.askPermission(question, [], signal)) === "deny"
      ) {
        throw new Error("The person said no.");
      }

      const output = await ran(tool, input, { id, signal }, host.log);

      return typeof output === "string"
        ? { content: [{ type: "text", text: output }], details: {} }
        : {
            content: [{ type: "text", text: output.text }],
            details: output.details ?? {},
          };
    },
  });
}

async function ran(
  tool: SessionTool,
  input: unknown,
  call: { readonly id: string; readonly signal: AbortSignal | undefined },
  log: Log,
): Promise<ToolOutput> {
  try {
    return await tool.run(input, call);
  } catch (error) {
    if (isToolError(error) || isHttpError(error)) {
      throw new Error(error.message, { cause: error });
    }

    log("tool failed", { tool: tool.name, error: String(error) });

    throw new Error("The tool failed", { cause: error });
  }
}
