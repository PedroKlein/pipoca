import { type Static, Type } from "@pipoca/plugins";
import { Value } from "typebox/value";
import { cronSchedule } from "./cron";

const workspace = Type.Union([
  Type.Object({ kind: Type.Literal("folder"), path: Type.String() }),
  Type.Object({
    kind: Type.Literal("worktree"),
    path: Type.String(),
    startPoint: Type.Optional(Type.String()),
  }),
  Type.Object({
    kind: Type.Literal("clone"),
    repository: Type.String(),
    startPoint: Type.Optional(Type.String()),
  }),
  Type.Object({
    kind: Type.Literal("repositories"),
    repositories: Type.Array(
      Type.Object({
        repository: Type.String(),
        startPoint: Type.Optional(Type.String()),
      }),
      { minItems: 1 },
    ),
  }),
]);

const trigger = Type.Union([
  Type.Object(
    { cron: Type.String(), timeZone: Type.String() },
    { additionalProperties: false },
  ),
  Type.Object({ at: Type.String() }, { additionalProperties: false }),
  Type.Object({ webhook: Type.Literal(true) }, { additionalProperties: false }),
  Type.Object(
    {
      event: Type.String({ pattern: "^[a-z0-9-]+\\.[a-z0-9_]+$" }),
      filter: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    },
    { additionalProperties: false },
  ),
]);

const run = Type.Union([
  Type.Object(
    {
      prompt: Type.String({ minLength: 1 }),
      workspace,
      environment: Type.Optional(Type.String()),
      profile: Type.Optional(Type.String()),
      model: Type.Optional(Type.String()),
      // A technical user the run's git acts as instead of the person
      // (ADR 0060).
      as: Type.Optional(Type.String({ minLength: 1 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { prompt: Type.String({ minLength: 1 }), session: Type.String() },
    { additionalProperties: false },
  ),
]);

// A routine as its JSON file holds it (ADR 0059). Its name is the file's.
export const routineSchema = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: 120 }),
    triggers: Type.Array(trigger, { minItems: 1, maxItems: 10 }),
    run,
    overlap: Type.Optional(
      Type.Union([Type.Literal("skip"), Type.Literal("queue")]),
    ),
    // Event fields that name what the work is about, such as a repository
    // and a pull request: an event whose key has a Session goes to it.
    key: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 5 })),
    // How many keyed runs go at once. The others wait their turn (ADR 0061).
    maxRunning: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
  },
  { additionalProperties: false },
);

export type Routine = Static<typeof routineSchema>;
export type Trigger = Routine["triggers"][number];

export const namePattern = /^[a-z0-9][a-z0-9-]{0,62}$/;

// The routine the value describes, or an Error naming what is wrong.
export function routineOf(value: unknown): Routine {
  if (!Value.Check(routineSchema, value)) {
    const [error] = Value.Errors(routineSchema, value);
    const field = error?.instancePath.slice(1).replaceAll("/", ".") ?? "";

    throw new Error(
      `${field === "" ? "routine" : field} ${error?.message ?? "doesn't fit"}`,
    );
  }

  for (const each of value.triggers) {
    if ("cron" in each) {
      cronSchedule(each.cron, each.timeZone);
    } else if ("at" in each && !isZonedTime(each.at)) {
      throw new Error(`${each.at} must be an ISO 8601 time with a time zone`);
    }
  }

  if ("model" in value.run && !/^[^/\s]+\/\S+$/.test(value.run.model)) {
    throw new Error("run.model must be provider/id, such as openai/gpt-5");
  }

  return value;
}

// When the trigger fires next, strictly after the time.
export function nextFiring(each: Trigger, after: number): number | undefined {
  if ("cron" in each) {
    return cronSchedule(each.cron, each.timeZone).next(after);
  }

  if (!("at" in each)) {
    return undefined;
  }

  const at = Date.parse(each.at);

  return at > after ? at : undefined;
}

export function isZonedTime(text: string): boolean {
  return !Number.isNaN(Date.parse(text)) && /(Z|[+-]\d\d:?\d\d)$/i.test(text);
}

// What a routine hears: another plugin's event, or a webhook's delivery.
export interface Heard {
  readonly type: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

// Each filter field, a dotted path, must equal its value or be one of a list
// of values. A field that is a list, such as labels, needs to hold it.
export function matches(
  event: Heard,
  filter: Readonly<Record<string, unknown>> = {},
): boolean {
  return Object.entries(filter).every(([path, wanted]) => {
    const value = fieldOf(event, path);
    const allowed = Array.isArray(wanted) ? wanted : [wanted];

    return Array.isArray(value)
      ? value.some((each) => allowed.includes(each))
      : allowed.includes(value);
  });
}

export function keyOf(event: Heard, paths: readonly string[] = []): string {
  return paths
    .map((path) => {
      const value = fieldOf(event, path);

      return typeof value === "string" || typeof value === "number"
        ? String(value)
        : JSON.stringify(value ?? "");
    })
    .join("/");
}

function fieldOf(event: Heard, path: string): unknown {
  let value: unknown = event.fields;

  for (const part of path.split(".")) {
    value =
      typeof value === "object" && value !== null
        ? (value as Record<string, unknown>)[part]
        : undefined;
  }

  return value;
}

const maxEventLength = 4000;

export function eventsText(events: readonly Heard[]): string {
  return events
    .map((event) => {
      const json = JSON.stringify(event.fields, null, 2);

      return `Event ${event.type}:\n\`\`\`json\n${json.length > maxEventLength ? `${json.slice(0, maxEventLength)}\n…` : json}\n\`\`\``;
    })
    .join("\n\n");
}
