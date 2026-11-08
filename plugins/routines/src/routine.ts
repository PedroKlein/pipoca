import { matchesGlob } from "node:path";
import { type Static, Type } from "@pipoca/plugins";
import type { DeclaredEvent } from "@pipoca/protocol";
import { Value } from "typebox/value";
import { cronSchedule } from "./cron";

const scalar = Type.Union([Type.String(), Type.Number(), Type.Boolean()]);

// Inputs a trigger fills, as plain text with {{event.<field>}} in it.
const triggerInputs = Type.Optional(Type.Record(Type.String(), scalar));

const field = Type.String({ minLength: 1 });

const condition = Type.Union([
  Type.Object({ field, is: scalar }, { additionalProperties: false }),
  Type.Object({ field, isNot: scalar }, { additionalProperties: false }),
  Type.Object(
    { field, oneOf: Type.Array(scalar, { minItems: 1 }) },
    { additionalProperties: false },
  ),
  Type.Object({ field, contains: scalar }, { additionalProperties: false }),
  Type.Object(
    { field, startsWith: Type.String() },
    { additionalProperties: false },
  ),
  Type.Object(
    { field, matches: Type.String({ minLength: 1 }) },
    { additionalProperties: false },
  ),
]);

const trigger = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("schedule"),
      cron: Type.String(),
      timeZone: Type.String(),
      inputs: triggerInputs,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal("once"), at: Type.String(), inputs: triggerInputs },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("event"),
      event: Type.String({ pattern: "^[a-z0-9-]+\\.[a-z0-9_]+$" }),
      where: Type.Optional(Type.Array(condition, { maxItems: 20 })),
      inputs: triggerInputs,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal("webhook"), inputs: triggerInputs },
    { additionalProperties: false },
  ),
]);

const described = {
  description: Type.Optional(Type.String()),
  required: Type.Optional(Type.Boolean()),
};

const input = Type.Union([
  Type.Object(
    {
      type: Type.Literal("string"),
      default: Type.Optional(Type.String()),
      ...described,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("number"),
      default: Type.Optional(Type.Number()),
      ...described,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("boolean"),
      default: Type.Optional(Type.Boolean()),
      ...described,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("oneOf"),
      values: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
      default: Type.Optional(Type.String()),
      ...described,
    },
    { additionalProperties: false },
  ),
]);

const startPoint = Type.Optional(Type.String());

const workspace = Type.Union([
  Type.Object({ kind: Type.Literal("folder"), path: Type.String() }),
  Type.Object({
    kind: Type.Literal("worktree"),
    path: Type.String(),
    startPoint,
  }),
  Type.Object({
    kind: Type.Literal("clone"),
    repository: Type.String(),
    startPoint,
  }),
  Type.Object({
    kind: Type.Literal("repositories"),
    repositories: Type.Array(
      Type.Object({ repository: Type.String(), startPoint }),
      { minItems: 1 },
    ),
  }),
  // A clone of the repository the event names.
  Type.Object({ kind: Type.Literal("event-repository"), startPoint }),
]);

const prompt = Type.String({ minLength: 1 });

const work = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("session"),
      prompt,
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
    { kind: Type.Literal("message"), prompt, session: Type.String() },
    { additionalProperties: false },
  ),
]);

// A routine as its JSON file holds it (ADR 0075). Its name is the file's.
export const routineSchema = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: 120 }),
    when: Type.Array(trigger, { minItems: 1, maxItems: 10 }),
    inputs: Type.Optional(Type.Record(Type.String(), input)),
    sameWork: Type.Optional(
      Type.Object(
        {
          // Event fields that make one piece of work, such as a repository
          // and an issue number. Without it the routine is one piece.
          key: Type.Optional(Type.Array(field, { minItems: 1, maxItems: 5 })),
          whileRunning: Type.Optional(
            Type.Union([
              Type.Literal("tell"),
              Type.Literal("skip"),
              Type.Literal("queue"),
            ]),
          ),
        },
        { additionalProperties: false },
      ),
    ),
    do: work,
    limits: Type.Optional(
      Type.Object(
        {
          // Runs that go at once, across all pieces of work.
          maxRunning: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export type Routine = Static<typeof routineSchema>;
export type Trigger = Routine["when"][number];
export type Condition = NonNullable<
  Extract<Trigger, { kind: "event" }>["where"]
>[number];
export type Inputs = Readonly<Record<string, string | number | boolean>>;
export type WhileRunning = "tell" | "skip" | "queue";

export const namePattern = /^[a-z0-9][a-z0-9-]{0,62}$/;

const inputName = /^[a-zA-Z][a-zA-Z0-9_]{0,40}$/;

// The routine the value describes, or an Error naming what is wrong. A file
// in the ADR 0059 shape is read as the routine it would be now.
export function routineOf(value: unknown): Routine {
  const routine = checked(isFirstShape(value) ? fromFirstShape(value) : value);

  for (const each of routine.when) {
    if (each.kind === "schedule") {
      cronSchedule(each.cron, each.timeZone);
    } else if (each.kind === "once" && !isZonedTime(each.at)) {
      throw new Error(`${each.at} must be an ISO 8601 time with a time zone`);
    }
  }

  for (const [name, each] of Object.entries(routine.inputs ?? {})) {
    if (!inputName.test(name)) {
      throw new Error(
        `inputs.${name}: a name is letters, digits and _, starting with a letter`,
      );
    }

    if (
      each.type === "oneOf" &&
      each.default !== undefined &&
      !each.values.includes(each.default)
    ) {
      throw new Error(`inputs.${name}.default must be one of its values`);
    }
  }

  if (
    routine.do.kind === "session" &&
    routine.do.model !== undefined &&
    !/^[^/\s]+\/\S+$/.test(routine.do.model)
  ) {
    throw new Error("do.model must be provider/id, such as openai/gpt-5");
  }

  const declared = new Set(Object.keys(routine.inputs ?? {}));

  for (const [index, each] of routine.when.entries()) {
    for (const name of Object.keys(each.inputs ?? {})) {
      if (!declared.has(name)) {
        throw new Error(`when.${String(index)}.inputs: no input ${name}`);
      }
    }
  }

  for (const text of [
    routine.do.prompt,
    JSON.stringify("workspace" in routine.do ? routine.do.workspace : ""),
  ]) {
    for (const [, root = "", name = ""] of text.matchAll(placeholder)) {
      if (root !== "event" && root !== "inputs") {
        throw new Error(`{{${root}.${name}}}: use {{event.…}} or {{inputs.…}}`);
      }

      if (root === "inputs" && !declared.has(name)) {
        throw new Error(`{{inputs.${name}}}: no input ${name}`);
      }
    }
  }

  return routine;
}

function checked(value: unknown): Routine {
  if (!Value.Check(routineSchema, value)) {
    const [error] = Value.Errors(routineSchema, value);
    const at = error?.instancePath.slice(1).replaceAll("/", ".") ?? "";

    throw new Error(
      `${at === "" ? "routine" : at} ${error?.message ?? "doesn't fit"}`,
    );
  }

  return value;
}

// Each event trigger names an event an enabled plugin declares, and its
// conditions name that event's fields with values that fit them.
export function checkEvents(
  routine: Routine,
  declared: readonly DeclaredEvent[],
): void {
  for (const [index, each] of routine.when.entries()) {
    if (each.kind !== "event") {
      continue;
    }

    const known = declared.find(({ type }) => type === each.event);

    if (known === undefined) {
      throw new Error(`when.${String(index)}: no event ${each.event}`);
    }

    for (const [at, where] of (each.where ?? []).entries()) {
      const misfit = misfitOf(where, known.fields);

      if (misfit !== undefined) {
        throw new Error(`when.${String(index)}.where.${String(at)}: ${misfit}`);
      }
    }
  }
}

type FieldKind = "string" | "number" | "boolean" | "unknown";

function misfitOf(
  where: Condition,
  fields: Readonly<Record<string, unknown>>,
): string | undefined {
  let schema: unknown = fields;

  for (const part of where.field.split(".")) {
    const properties = propertyOf(schema, "properties");

    if (properties === undefined) {
      return undefined;
    }

    schema = propertyOf(properties, part);

    if (schema === undefined) {
      return `the event has no field ${where.field}`;
    }
  }

  const type = propertyOf(schema, "type");
  const list = type === "array";
  const kind = kindOf(list ? propertyOf(schema, "items") : schema);
  const values = valuesOf(where);

  if ("contains" in where && !list && kind !== "string") {
    return `${where.field} is neither a list nor text`;
  }

  if (("startsWith" in where || "matches" in where) && kind !== "string") {
    return `${where.field} isn't text`;
  }

  const wrong = values.find(
    (value) => kind !== "unknown" && typeof value !== kind,
  );

  return wrong === undefined
    ? undefined
    : `${where.field} holds ${list ? `a list of ${kind}s` : `a ${kind}`}, not ${JSON.stringify(wrong)}`;
}

function kindOf(schema: unknown): FieldKind {
  const type = propertyOf(schema, "type");

  switch (type) {
    case "string":
    case "boolean":
      return type;
    case "number":
    case "integer":
      return "number";
    default:
      return "unknown";
  }
}

function propertyOf(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null && name in value
    ? (value as Record<string, unknown>)[name]
    : undefined;
}

function valuesOf(where: Condition): readonly unknown[] {
  if ("oneOf" in where) {
    return where.oneOf;
  }

  if ("is" in where) {
    return [where.is];
  }

  if ("isNot" in where) {
    return [where.isNot];
  }

  return "contains" in where ? [where.contains] : [];
}

// When the trigger fires next, strictly after the time.
export function nextFiring(each: Trigger, after: number): number | undefined {
  if (each.kind === "schedule") {
    return cronSchedule(each.cron, each.timeZone).next(after);
  }

  if (each.kind !== "once") {
    return undefined;
  }

  const at = Date.parse(each.at);

  return at > after ? at : undefined;
}

export function isZonedTime(text: string): boolean {
  return !Number.isNaN(Date.parse(text)) && /(Z|[+-]\d\d:?\d\d)$/i.test(text);
}

// What a routine hears: another plugin's event, or a webhook's delivery,
// with the inputs its trigger filled.
export interface Heard {
  readonly type: string;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly inputs?: Readonly<Record<string, unknown>>;
}

// Every condition holds. A field that is a list holds a condition when one
// of its items does, and isNot when none is the value.
export function matches(
  event: Heard,
  where: readonly Condition[] = [],
): boolean {
  return where.every((each) => {
    const value = fieldOf(event.fields, each.field);

    if ("contains" in each) {
      return Array.isArray(value)
        ? value.includes(each.contains)
        : typeof value === "string" && value.includes(String(each.contains));
    }

    const items: readonly unknown[] = Array.isArray(value) ? value : [value];

    if ("isNot" in each) {
      return !items.includes(each.isNot);
    }

    return items.some((item) => holds(each, item));
  });
}

function holds(each: Condition, item: unknown): boolean {
  if ("is" in each) {
    return item === each.is;
  }

  if ("oneOf" in each) {
    return each.oneOf.some((value) => value === item);
  }

  if (typeof item !== "string") {
    return false;
  }

  if ("startsWith" in each) {
    return item.startsWith(each.startsWith);
  }

  return "matches" in each && matchesGlob(item, each.matches);
}

export function keyOf(event: Heard, paths: readonly string[] = []): string {
  return paths
    .map((path) => {
      const value = fieldOf(event.fields, path);

      return typeof value === "string" || typeof value === "number"
        ? String(value)
        : JSON.stringify(value ?? "");
    })
    .join("/");
}

export function whileRunningOf(routine: Routine): WhileRunning {
  return (
    routine.sameWork?.whileRunning ??
    (routine.sameWork?.key === undefined ? "skip" : "tell")
  );
}

function fieldOf(fields: unknown, path: string): unknown {
  let value = fields;

  for (const part of path.split(".")) {
    value = propertyOf(value, part);
  }

  return value;
}

const placeholder = /\{\{\s*([a-zA-Z]+)\.([a-zA-Z0-9_.]+)\s*\}\}/g;

interface Values {
  readonly event?: Readonly<Record<string, unknown>> | undefined;
  readonly inputs?: Readonly<Record<string, unknown>>;
}

// Fills {{event.<field>}} and {{inputs.<name>}} in the text. Nothing else
// is evaluated. A value the routine doesn't hold is empty.
export function fill(
  text: string,
  values: Values,
  mark: (value: string, root: "event" | "inputs") => string = (value) => value,
): string {
  return text.replaceAll(placeholder, (_, root: string, path: string) => {
    if (root !== "event" && root !== "inputs") {
      return "";
    }

    const value = fieldOf(values[root], path);

    return value === undefined || value === null
      ? ""
      : mark(typeof value === "string" ? value : JSON.stringify(value), root);
  });
}

// Fills every text in a workspace, so a path or repository can name an
// event's field or an input.
export function fillAll<T>(value: T, values: Values): T {
  return JSON.parse(
    JSON.stringify(value, (_, each: unknown) =>
      typeof each === "string" ? fill(each, values) : each,
    ),
  ) as T;
}

// What a run gets for each declared input: what it was given, made to fit
// the input's type, or its default. An Error names what doesn't fit.
export function inputsOf(
  routine: Routine,
  given: Readonly<Record<string, unknown>> = {},
): Inputs {
  const declared = routine.inputs ?? {};
  const unknown = Object.keys(given).find((name) => !(name in declared));

  if (unknown !== undefined) {
    throw new Error(`the routine has no input ${unknown}`);
  }

  const filled: Record<string, string | number | boolean> = {};

  for (const [name, each] of Object.entries(declared)) {
    const value = given[name] ?? each.default;

    if (value === undefined) {
      if (each.required === true) {
        throw new Error(`inputs.${name} is required`);
      }

      continue;
    }

    const fitted = fit(each, value);

    if (fitted === undefined) {
      throw new Error(
        `inputs.${name} must be ${each.type === "oneOf" ? `one of ${each.values.join(", ")}` : `a ${each.type}`}`,
      );
    }

    filled[name] = fitted;
  }

  return filled;
}

type Input = NonNullable<Routine["inputs"]>[string];

function fit(
  each: Input,
  value: unknown,
): string | number | boolean | undefined {
  const text =
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
      ? String(value)
      : undefined;

  switch (each.type) {
    case "string":
      return text;
    case "number": {
      const number = typeof value === "number" ? value : Number(text ?? "");

      return text?.trim() === "" || !Number.isFinite(number)
        ? undefined
        : number;
    }

    case "boolean":
      return text === "true" || text === "false" ? text === "true" : undefined;
    case "oneOf":
      return text !== undefined && each.values.includes(text)
        ? text
        : undefined;
  }
}

const maxEventLength = 4000;

export function eventsText(events: readonly Heard[]): string {
  return events
    .map((event) => {
      const json = JSON.stringify(event.fields, null, 2);

      return `Event ${event.type}, outside input:\n\`\`\`json\n${json.length > maxEventLength ? `${json.slice(0, maxEventLength)}\n…` : json}\n\`\`\``;
    })
    .join("\n\n");
}

// A file in the ADR 0059 shape, which guessed a trigger's kind from its
// fields and kept overlap, key and maxRunning at the top.
interface FirstShape {
  readonly title?: unknown;
  readonly triggers?: readonly Record<string, unknown>[];
  readonly run?: Record<string, unknown>;
  readonly overlap?: WhileRunning;
  readonly key?: readonly string[];
  readonly maxRunning?: number;
}

function isFirstShape(value: unknown): value is FirstShape {
  return (
    typeof value === "object" &&
    value !== null &&
    !("when" in value) &&
    ("triggers" in value || "run" in value)
  );
}

function fromFirstShape(old: FirstShape): unknown {
  const { run = {} } = old;

  const sameWork = {
    ...(old.key !== undefined && { key: old.key }),
    ...(old.key === undefined &&
      old.overlap !== undefined && { whileRunning: old.overlap }),
  };

  return {
    title: old.title,
    when: (old.triggers ?? []).map(triggerOfFirstShape),
    ...(Object.keys(sameWork).length > 0 && { sameWork }),
    do: { kind: "session" in run ? "message" : "session", ...run },
    ...(old.maxRunning !== undefined && {
      limits: { maxRunning: old.maxRunning },
    }),
  };
}

function triggerOfFirstShape(old: Readonly<Record<string, unknown>>): unknown {
  if ("cron" in old) {
    return { kind: "schedule", ...old };
  }

  if ("at" in old) {
    return { kind: "once", ...old };
  }

  if (!("event" in old)) {
    return { kind: "webhook" };
  }

  const { filter = {}, ...rest } = old as { filter?: object };

  return {
    kind: "event",
    ...rest,
    ...(Object.keys(filter).length > 0 && {
      where: Object.entries(filter).map(([path, wanted]: [string, unknown]) =>
        Array.isArray(wanted)
          ? { field: path, oneOf: wanted }
          : { field: path, is: wanted },
      ),
    }),
  };
}
