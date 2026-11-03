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
]);

const run = Type.Union([
  Type.Object(
    {
      prompt: Type.String({ minLength: 1 }),
      workspace,
      environment: Type.Optional(Type.String()),
      profile: Type.Optional(Type.String()),
      model: Type.Optional(Type.String()),
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
    } else if (!isZonedTime(each.at)) {
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

  const at = Date.parse(each.at);

  return at > after ? at : undefined;
}

export function isZonedTime(text: string): boolean {
  return !Number.isNaN(Date.parse(text)) && /(Z|[+-]\d\d:?\d\d)$/i.test(text);
}
