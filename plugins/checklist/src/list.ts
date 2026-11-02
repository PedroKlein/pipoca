export const toolName = "update_checklist";

export const statuses = ["pending", "in_progress", "completed"] as const;

export interface Item {
  readonly text: string;
  readonly status: (typeof statuses)[number];
}

// The list a transcript line sets, when it is a checklist call's result. An
// empty list clears it.
export function listOf(line: string): readonly Item[] | undefined {
  if (!line.includes(`"${toolName}"`)) {
    return undefined;
  }

  let entry: {
    readonly type?: string;
    readonly message?: {
      readonly role?: string;
      readonly toolName?: string;
      readonly isError?: boolean;
      readonly details?: { readonly items?: unknown };
    };
  };

  try {
    entry = JSON.parse(line) as typeof entry;
  } catch {
    return undefined;
  }

  const message = entry.type === "message" ? entry.message : undefined;

  if (
    message?.role !== "toolResult" ||
    message.toolName !== toolName ||
    message.isError === true
  ) {
    return undefined;
  }

  const items = message.details?.items;

  return Array.isArray(items) ? items.filter(isItem) : undefined;
}

function isItem(value: unknown): value is Item {
  const item = value as Partial<Item> | null;

  return (
    typeof item?.text === "string" &&
    statuses.some((status) => status === item.status)
  );
}

export function isOpen(items: readonly Item[]): boolean {
  return items.some(({ status }) => status !== "completed");
}
