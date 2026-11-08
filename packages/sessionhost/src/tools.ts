import { randomUUID } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ToolResult, ToolSpec } from "@pipoca/protocol";
import { repairArguments } from "./arguments";

interface ServerToolCalls {
  readonly tools: readonly ToolDefinition[];
  readonly result: (id: string, result: ToolResult) => void;
  readonly cancelAll: () => void;
}

// The server can lose a tool_result, for example when it restarts during the
// call, so a call gives up instead of keeping the turn running forever.
const resultTimeoutMs = 5 * 60_000;

// A tool's spec as Pi takes it, for the server's tools and a Session part's.
export function piToolOf(
  spec: ToolSpec,
): Omit<ToolDefinition, "execute" | "renderCall" | "renderResult"> {
  // Pi shows a namespace's instructions only to codemode scripts, so they go
  // in the rules the prompt lists for declared tools.
  const guidelines = [
    ...(spec.namespace?.instructions === undefined
      ? []
      : [spec.namespace.instructions]),
    ...(spec.prompt?.guidelines ?? []),
  ];

  return {
    name: spec.name,
    label: spec.label ?? spec.name,
    description: spec.description,
    parameters: Type.Unsafe<unknown>(spec.parameters),
    prepareArguments: (args) => repairArguments(args, spec.parameters),
    ...(spec.exposure && { exposure: spec.exposure }),
    ...(spec.namespace && { namespace: spec.namespace }),
    ...(spec.prompt && { promptSnippet: spec.prompt.snippet }),
    ...(guidelines.length > 0 && { promptGuidelines: guidelines }),
    ...(spec.sequential === true && { executionMode: "sequential" }),
    ...(spec.annotations && { annotations: spec.annotations }),
  };
}

// Tools served by server plugins (ADR 0015): a call goes up the stream and
// its result comes back as a tool_result command.
export function serverTools(
  specs: readonly ToolSpec[],
  call: (id: string, name: string, input: unknown) => Promise<void>,
  // Whether the person lets a call of a tool that asks run.
  allowed: (
    name: string,
    input: unknown,
    signal: AbortSignal | undefined,
  ) => Promise<boolean>,
  timeoutMs = resultTimeoutMs,
): ServerToolCalls {
  const pending = new Map<
    string,
    { resolve: (result: ToolResult) => void; reject: (error: Error) => void }
  >();

  const tools = specs.map((spec) =>
    defineTool({
      ...piToolOf(spec),
      async execute(_toolCallId, input, signal) {
        if (spec.asks === true && !(await allowed(spec.name, input, signal))) {
          throw new Error("The person said no.");
        }

        const id = randomUUID();

        const abort = () => {
          pending.get(id)?.reject(new Error("tool call aborted"));
        };

        const timer = setTimeout(() => {
          pending
            .get(id)
            ?.reject(
              new Error(
                `no result from the server for ${spec.name} after ${String(timeoutMs / 1000)} s; it may still have run, so check before retrying`,
              ),
            );
        }, timeoutMs);

        try {
          const result = await new Promise<ToolResult>((resolve, reject) => {
            pending.set(id, { resolve, reject });
            signal?.addEventListener("abort", abort, { once: true });

            call(id, spec.name, input).catch((error: unknown) => {
              reject(
                new Error(
                  `could not confirm the server received ${spec.name} (${String(error)}); it may still have run, so check before retrying`,
                ),
              );
            });
          });

          if (result.isError) {
            throw new Error(result.text);
          }

          return {
            content: [{ type: "text", text: result.text }],
            details: result.opened
              ? { opened: result.opened }
              : (result.details ?? {}),
            ...(result.endsTurn === true && { terminate: true }),
          };
        } finally {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          pending.delete(id);
        }
      },
    }),
  );

  return {
    tools,
    result: (id, result) => {
      pending.get(id)?.resolve(result);
      pending.delete(id);
    },
    cancelAll: () => {
      for (const { reject } of pending.values()) {
        reject(new Error("session stopped"));
      }

      pending.clear();
    },
  };
}
