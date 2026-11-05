export interface ToolResultEntry<D = unknown> {
  readonly callId: string;
  readonly line: number;
  readonly input: unknown;
  readonly details: D;
  readonly isError: boolean;
}

export interface Transcript {
  readonly toolResults: <D = unknown>(
    sessionId: string,
    tool: string,
  ) => readonly ToolResultEntry<D>[];
  readonly messages: (
    sessionId: string,
    o?: { readonly sinceLine?: number },
  ) => readonly {
    readonly line: number;
    readonly role: "user" | "assistant";
    readonly text: string;
  }[];
  readonly lastReply: (
    sessionId: string,
  ) => { readonly line: number; readonly text: string } | undefined;
  readonly length: (sessionId: string) => number;
}

interface Message {
  readonly role?: unknown;
  readonly content?: unknown;
  readonly toolCallId?: unknown;
  readonly toolName?: unknown;
  readonly details?: unknown;
  readonly isError?: unknown;
}

interface Part {
  readonly type?: unknown;
  readonly text?: unknown;
  readonly id?: unknown;
  readonly arguments?: unknown;
}

// The one reader of Pi's session entries. Pi can leave a line cut short by
// a crash, which reads as no entry.
export function transcriptReader(
  linesOf: (sessionId: string) => readonly string[],
): Transcript {
  const messages = (sessionId: string): (Message & { line: number })[] =>
    linesOf(sessionId).flatMap((line, i) => {
      const message = messageOf(line);

      return message === undefined ? [] : [{ ...message, line: i }];
    });

  const texts = (
    sessionId: string,
  ): { line: number; role: "user" | "assistant"; text: string }[] =>
    messages(sessionId).flatMap(({ role, content, line }) => {
      const text = textOf(content);

      return (role === "user" || role === "assistant") && text !== ""
        ? [{ line, role, text }]
        : [];
    });

  return {
    toolResults: <D>(sessionId: string, tool: string) => {
      const inputs = new Map<unknown, unknown>();
      const results: ToolResultEntry<D>[] = [];

      for (const message of messages(sessionId)) {
        if (message.role === "assistant") {
          for (const part of partsOf(message.content)) {
            if (part.type === "toolCall") {
              inputs.set(part.id, part.arguments);
            }
          }
        }

        if (
          message.role === "toolResult" &&
          message.toolName === tool &&
          typeof message.toolCallId === "string"
        ) {
          results.push({
            callId: message.toolCallId,
            line: message.line,
            input: inputs.get(message.toolCallId),
            details: message.details as D,
            isError: message.isError === true,
          });
        }
      }

      return results;
    },
    messages: (sessionId, { sinceLine = 0 } = {}) =>
      texts(sessionId).filter(({ line }) => line >= sinceLine),
    lastReply: (sessionId) => {
      const reply = texts(sessionId).findLast(
        ({ role }) => role === "assistant",
      );

      return reply && { line: reply.line, text: reply.text };
    },
    length: (sessionId) => linesOf(sessionId).length,
  };
}

function messageOf(line: string): Message | undefined {
  try {
    const entry = JSON.parse(line) as {
      readonly type?: unknown;
      readonly message?: unknown;
    } | null;

    return entry?.type === "message" &&
      typeof entry.message === "object" &&
      entry.message !== null
      ? entry.message
      : undefined;
  } catch {
    return undefined;
  }
}

function partsOf(content: unknown): readonly Part[] {
  return Array.isArray(content)
    ? content.filter(
        (part): part is Part => typeof part === "object" && part !== null,
      )
    : [];
}

function textOf(content: unknown): string {
  return typeof content === "string"
    ? content.trim()
    : partsOf(content)
        .flatMap(({ type, text }) =>
          type === "text" && typeof text === "string" ? [text] : [],
        )
        .join("")
        .trim();
}
