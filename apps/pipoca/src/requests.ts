import { isObject } from "@pipoca/plugins";

// The web sends null, and an empty prompt or start point, for what it leaves
// out of a new Session or fork.
export function blanksDropped(body: unknown): unknown {
  if (!isObject(body)) {
    return body;
  }

  const { workspace } = body;

  return {
    ...present(body, ["systemPrompt", "firstMessage"]),
    ...(isObject(workspace) && {
      workspace: {
        ...present(workspace, ["startPoint"]),
        ...(Array.isArray(workspace["repositories"]) && {
          repositories: workspace["repositories"].map((checkout: unknown) =>
            isObject(checkout) ? present(checkout, ["startPoint"]) : checkout,
          ),
        }),
      },
    }),
  };
}

function present(
  fields: Readonly<Record<string, unknown>>,
  emptyAsAbsent: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).filter(
      ([key, value]) =>
        value !== null && !(value === "" && emptyAsAbsent.includes(key)),
    ),
  );
}

export function lineAfter(lastEventId: string | null): number {
  const line = Number(lastEventId ?? "");

  return lastEventId !== null && Number.isSafeInteger(line) && line >= 0
    ? line + 1
    : 0;
}
