import { isObject } from "@pipoca/plugins";

interface Message {
  readonly role: string;
  readonly content: string | readonly Part[];
  readonly stopReason: string | undefined;
  readonly errorMessage: string | undefined;
}

interface Part {
  readonly type?: unknown;
  readonly text?: unknown;
  readonly name?: unknown;
}

// The model error a thread's last turn ended with, if it did.
export function turnError(transcript: readonly string[]): string | undefined {
  for (const line of transcript.toReversed()) {
    const message = messageOf(line);
    if (message?.role === "assistant") {
      return message.stopReason === "error"
        ? (message.errorMessage ?? "unknown error")
        : undefined;
    }
  }

  return undefined;
}

export function messagedCoordinator(transcript: readonly string[]): boolean {
  for (const line of transcript.toReversed()) {
    const message = messageOf(line);
    if (message?.role === "user") {
      return false;
    }

    if (
      message?.role === "assistant" &&
      typeof message.content !== "string" &&
      message.content.some(
        (part) =>
          part.type === "toolCall" && part.name === "message_coordinator",
      )
    ) {
      return true;
    }
  }

  return false;
}

export function messageText(line: string):
  | {
      readonly role: string;
      readonly text: string;
    }
  | undefined {
  const message = messageOf(line);
  if (message === undefined) {
    return undefined;
  }

  const { role, content } = message;

  const text =
    typeof content === "string"
      ? content
      : content
          .flatMap((part) =>
            part.type === "text" && typeof part.text === "string"
              ? part.text
              : [],
          )
          .join("");

  return text.trim() === "" ? undefined : { role, text: text.trim() };
}

export function lastReply(transcript: readonly string[]): string | undefined {
  for (const line of transcript.toReversed()) {
    const message = messageText(line);
    if (message?.role === "assistant") {
      return message.text;
    }
  }

  return undefined;
}

export interface RecentChat {
  // Pi's summary of what came before, when it compacted the context.
  readonly summary: string | undefined;
  readonly messages: readonly {
    readonly role: string;
    readonly text: string;
  }[];
}

// What a fresh coordinator needs from the one it replaces: Pi's latest
// compaction summary and the chat since.
export function recentChat(transcript: readonly string[]): RecentChat {
  const start = transcript.findLastIndex(
    (line) => compactionOf(line) !== undefined,
  );

  return {
    summary: start === -1 ? undefined : compactionOf(transcript[start] ?? ""),
    messages: transcript.slice(start + 1).flatMap((line) => {
      const message = messageText(line);

      return message?.role === "user" || message?.role === "assistant"
        ? [message]
        : [];
    }),
  };
}

export function compacted(transcript: readonly string[]): boolean {
  return transcript.some((line) => compactionOf(line) !== undefined);
}

function compactionOf(line: string): string | undefined {
  if (!line.includes('"compaction"')) {
    return undefined;
  }

  try {
    const entry: unknown = JSON.parse(line);

    return isObject(entry) &&
      entry["type"] === "compaction" &&
      typeof entry["summary"] === "string"
      ? entry["summary"]
      : undefined;
  } catch {
    return undefined;
  }
}

// Pi can leave a line cut short by a crash, and not every message it records
// has content.
function messageOf(line: string): Message | undefined {
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return undefined;
  }

  const message =
    isObject(entry) && entry["type"] === "message"
      ? entry["message"]
      : undefined;

  if (!isObject(message)) {
    return undefined;
  }

  const { role, content, stopReason, errorMessage } = message;
  if (
    typeof role !== "string" ||
    (typeof content !== "string" && !Array.isArray(content))
  ) {
    return undefined;
  }

  return {
    role,
    content: typeof content === "string" ? content : content.filter(isObject),
    stopReason: typeof stopReason === "string" ? stopReason : undefined,
    errorMessage: typeof errorMessage === "string" ? errorMessage : undefined,
  };
}
