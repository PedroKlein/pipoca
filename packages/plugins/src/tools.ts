import type { Log, ToolResult, ToolSpec } from "@pipoca/protocol";
import { isHttpError, isToolError } from "./http";
import type { ToolDef, ToolOutput } from "./server";

// A tool as the Session's Pi is told about it, wherever it runs.
export function toolSpecOf(
  tool: Pick<
    ToolDef,
    | "name"
    | "label"
    | "description"
    | "params"
    | "exposure"
    | "annotations"
    | "prompt"
    | "sequential"
  >,
): ToolSpec {
  const { annotations, prompt } = tool;

  return {
    name: tool.name,
    description: tool.description,
    parameters: { ...tool.params },
    ...(tool.label !== undefined && { label: tool.label }),
    ...(tool.exposure !== undefined && { exposure: tool.exposure }),
    ...(annotations && {
      annotations: {
        ...(annotations.readOnly !== undefined && {
          readOnlyHint: annotations.readOnly,
        }),
        ...(annotations.destructive !== undefined && {
          destructiveHint: annotations.destructive,
        }),
      },
    }),
    ...(prompt && {
      prompt: {
        snippet: prompt.snippet,
        ...(prompt.guidelines && { guidelines: [...prompt.guidelines] }),
      },
    }),
    ...(tool.sequential === true && { sequential: true }),
  };
}

// What a run gives the model. Only a ToolError's or an HttpError's message
// reaches it; any other failure is logged.
export async function toolAnswer(
  name: string,
  run: () => ToolOutput | Promise<ToolOutput>,
  log: Log,
): Promise<ToolResult> {
  try {
    const output = await run();

    return typeof output === "string"
      ? { text: output, isError: false }
      : {
          text: output.text,
          isError: false,
          ...(output.details !== undefined && { details: output.details }),
          ...(output.endsTurn === true && { endsTurn: true }),
        };
  } catch (error) {
    if (isToolError(error) || isHttpError(error)) {
      return { text: error.message, isError: true };
    }

    log("tool failed", {
      tool: name,
      error: error instanceof Error ? error.message : String(error),
    });

    return { text: "The tool failed", isError: true };
  }
}
