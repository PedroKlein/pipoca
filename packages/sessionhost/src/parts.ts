import type { Api, Model } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ExtensionFactory,
  type ExtensionToolContext,
  type InlineExtension,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type {
  SessionContext,
  SessionLogins,
  SessionPart,
  SessionTool,
  SessionToolCall,
} from "@pipoca/plugins";
import { pluginClient, toolAnswer, toolSpecOf } from "@pipoca/plugins/host";
import { piToolOf } from "./tools";

export type PartHost = Omit<
  SessionContext,
  "tools" | "extension" | "config" | "api" | "provide"
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
  readonly modelCredentials?: () => Promise<SessionLogins>;
}> {
  const { id } = part.plugin;
  const tools: SessionTool[] = [];
  const factories: ExtensionFactory[] = [];
  let modelCredentials: (() => Promise<SessionLogins>) | undefined;
  const marker = `/ext/${id}/`;

  await part.setup({
    ...host,
    tools: {
      define: (tool) => {
        if (tool.when !== undefined) {
          throw new Error(
            `${tool.name} has a when rule, which only a server tool takes`,
          );
        }

        tools.push(tool);
      },
    },
    extension: (factory) => {
      factories.push(factory);
    },
    provide: {
      modelCredentials: (logins) => {
        modelCredentials = logins;
      },
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
    ...(modelCredentials && { modelCredentials }),
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
  host: Pick<PartHost, "askPermission" | "log" | "clock">,
): ToolDefinition {
  return defineTool({
    ...piToolOf(toolSpecOf(tool)),
    execute: async (id, input, signal, _update, ctx) => {
      const model: Model<Api> | undefined = ctx.model;

      const call: SessionToolCall = {
        id,
        signal,
        cwd: ctx.cwd,
        ...(model && { complete: completion(ctx.modelRegistry, model, host) }),
      };

      const question = await tool.asks?.(input, call);

      if (
        question !== undefined &&
        (await host.askPermission(question, [], signal)) === "deny"
      ) {
        throw new Error("The person said no.");
      }

      const result = await toolAnswer(
        tool.name,
        async () => tool.run(input, call),
        host.log,
      );

      if (result.isError) {
        throw new Error(result.text);
      }

      return {
        content: [{ type: "text", text: result.text }],
        details: result.details ?? {},
      };
    },
  });
}

function completion(
  models: ExtensionToolContext["modelRegistry"],
  model: Model<Api>,
  host: Pick<PartHost, "clock">,
): NonNullable<SessionToolCall["complete"]> {
  return async ({ system, prompt }) => {
    const response = await models
      .streamSimple(model, {
        systemPrompt: system,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: prompt }],
            timestamp: host.clock.now(),
          },
        ],
      })
      .result();

    if (response.stopReason === "error" || response.stopReason === "aborted") {
      throw new Error(response.errorMessage ?? "the model did not answer");
    }

    return response.content
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n")
      .trim();
  };
}
