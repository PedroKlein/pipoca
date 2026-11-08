import { matchesGlob } from "node:path";
import { type Static, Type } from "@pipoca/plugins";
import type { DeclaredAction, DeclaredEvent } from "@pipoca/protocol";
import { Value } from "typebox/value";
import { cronSchedule, dayAfter, timeWindow } from "./cron";

const scalar = Type.Union([Type.String(), Type.Number(), Type.Boolean()]);

// Inputs a trigger fills, as plain text with {{event.<field>}} in it.
const triggerInputs = Type.Optional(Type.Record(Type.String(), scalar));

// An agent file or a saved workflow of the run's Profile, by name (ADR 0075).
const named = Type.Optional(
  Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$" }),
);

// When a trigger may fire, in its time zone: a schedule's own, or else the
// window's or the server's. Outside every window a firing waits for the
// next one or is dropped (ADR 0076).
const window = Type.Object(
  {
    days: Type.String({ minLength: 1, description: "Such as mon-fri or *" }),
    from: Type.String({ pattern: "^\\d\\d:\\d\\d$" }),
    to: Type.String({ pattern: "^\\d\\d:\\d\\d$" }),
    outside: Type.Optional(
      Type.Union([Type.Literal("wait"), Type.Literal("skip")]),
    ),
    timeZone: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

// What a trigger fills, the agent or workflow its runs start in place of
// do's, and when it may fire.
const firing = {
  inputs: triggerInputs,
  agent: named,
  workflow: named,
  windows: Type.Optional(Type.Array(window, { minItems: 1, maxItems: 7 })),
};

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
  // The field names one of the group's repositories (ADR 0075).
  Type.Object(
    { field, inGroup: Type.Literal(true) },
    { additionalProperties: false },
  ),
]);

// A script that returns true or false before a firing spends tokens, or a
// check a plugin declares, by its type or name, with its settings
// (ADR 0075).
const check = Type.Optional(
  Type.Union([
    Type.String({ minLength: 1, maxLength: 4000 }),
    Type.Object(
      {
        use: Type.String({ minLength: 1 }),
        with: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      },
      { additionalProperties: false },
    ),
  ]),
);

const conditions = Type.Optional(Type.Array(condition, { maxItems: 20 }));

const duration = "^[1-9]\\d{0,3}[mhd]$";

// What a watch trigger's firing holds (ADR 0075).
export const watchFields = Type.Object({
  url: Type.String(),
  status: Type.Number(),
  // The value at the trigger's path, or the response's text, and what it
  // was before.
  value: Type.Unknown(),
  previous: Type.Unknown(),
});

export const watchEvent = "routines.watch";

const trigger = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("schedule"),
      cron: Type.String(),
      timeZone: Type.String(),
      ...firing,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal("once"), at: Type.String(), ...firing },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("event"),
      event: Type.String({ pattern: "^[a-z0-9-]+\\.[a-z0-9_]+$" }),
      where: conditions,
      check,
      // Matching events gather, and the routine runs once per schedule with
      // all of them.
      collect: Type.Optional(
        Type.Object(
          { cron: Type.String(), timeZone: Type.Optional(Type.String()) },
          { additionalProperties: false },
        ),
      ),
      ...firing,
    },
    { additionalProperties: false },
  ),
  // An https address fetched on a schedule, which fires when the response,
  // or the value at path in its JSON, changes.
  Type.Object(
    {
      kind: Type.Literal("watch"),
      url: Type.String({ pattern: "^https://" }),
      every: Type.String({ pattern: duration, description: "Such as 15m" }),
      path: Type.Optional(
        Type.String({ minLength: 1, description: "Such as items.0.version" }),
      ),
      where: conditions,
      check,
      ...firing,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal("webhook"), ...firing },
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

export const workspaceSchema = Type.Union([
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
  // Every repository of the routine's group, side by side.
  Type.Object({ kind: Type.Literal("group"), startPoint }),
]);

const prompt = Type.String({ minLength: 1 });

const work = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("session"),
      agent: named,
      workflow: named,
      // A workflow's run needs none: its inputs are the workflow's args.
      prompt: Type.Optional(prompt),
      workspace: workspaceSchema,
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

// A routine's limits, which a group's limits give defaults for (ADR 0076).
export const limitsSchema = Type.Object(
  {
    // Runs that go at once, across all pieces of work.
    maxRunning: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
    // A cap in the currency of the server's price table, counted from the
    // usage of the routine's runs each day.
    dailySpend: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
    // How long a run may be running, such as 2h.
    timeLimit: Type.Optional(Type.String({ pattern: "^[1-9]\\d{0,3}[mhd]$" })),
    // How often a failed run starts again.
    retries: Type.Optional(Type.Integer({ minimum: 0, maximum: 5 })),
    // A date, YYYY-MM-DD, or a time with a zone, after which the routine
    // pauses itself.
    stopAfter: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

const outputType = Type.Union([
  Type.Literal("string"),
  Type.Literal("number"),
  Type.Literal("boolean"),
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
    // The group's coordinator (ADR 0075): one lasting run that hears every
    // event its triggers catch and starts the group's runs.
    coordinator: Type.Optional(Type.Boolean()),
    // The fields of the output its runs end with, such as { "area":
    // "string" }, and ["string"] for a list.
    output: Type.Optional(
      Type.Record(
        Type.String(),
        Type.Union([outputType, Type.Tuple([outputType])]),
        { maxProperties: 20 },
      ),
    ),
    // Whose runs propose what they write outside instead of writing it:
    // runs fired by outside input, which is the default, every run, or none
    // (ADR 0076).
    proposes: Type.Optional(
      Type.Union([
        Type.Literal("outside-input"),
        Type.Literal("always"),
        Type.Literal("never"),
      ]),
    ),
    // The actions its runs may propose, by a plugin's type such as
    // git-hosts.comment or by its name alone, each with a maximum per run,
    // and whether a person approves each first.
    actions: Type.Optional(
      Type.Record(
        Type.String(),
        Type.Union([
          Type.Integer({ minimum: 1, maximum: 50 }),
          Type.Object(
            {
              max: Type.Integer({ minimum: 1, maximum: 50 }),
              approve: Type.Optional(Type.Boolean()),
            },
            { additionalProperties: false },
          ),
        ]),
      ),
    ),
    // Who a run's questions are for, and how long one waits (ADR 0076). A
    // personal routine asks its owner. A team routine asks the person or
    // the on-call list it names, or else whoever made it.
    questions: Type.Optional(
      Type.Object(
        {
          ask: Type.Optional(
            Type.Union([
              Type.Object(
                { person: Type.String({ minLength: 1 }) },
                { additionalProperties: false },
              ),
              Type.Object(
                { onCall: Type.String({ minLength: 1 }) },
                { additionalProperties: false },
              ),
            ]),
          ),
          timeout: Type.Optional(
            Type.String({ pattern: "^[1-9]\\d{0,3}[mhd]$" }),
          ),
        },
        { additionalProperties: false },
      ),
    ),
    // The people, by id or name, who may change or remove a team routine.
    // Without it anyone on the team may.
    editors: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 50 }),
    ),
    limits: Type.Optional(limitsSchema),
    // Where each run's result goes when it ends, by a plugin's destination
    // type or its name alone, with its settings and the outcomes it takes,
    // done unless it says (ADR 0075).
    results: Type.Optional(
      Type.Array(
        Type.Object(
          {
            to: Type.String({ minLength: 1 }),
            with: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
            on: Type.Optional(
              Type.Array(
                Type.Union([
                  Type.Literal("done"),
                  Type.Literal("nothing"),
                  Type.Literal("blocked"),
                  Type.Literal("failed"),
                  Type.Literal("stopped"),
                ]),
                { minItems: 1 },
              ),
            ),
          },
          { additionalProperties: false },
        ),
        { minItems: 1, maxItems: 5 },
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
export type Watch = Extract<Trigger, { kind: "watch" }>;
export type Inputs = Readonly<Record<string, string | number | boolean>>;
export type WhileRunning = "tell" | "skip" | "queue";
export type Output = Readonly<Record<string, unknown>>;

// The event a run that ends publishes, which other routines follow
// (ADR 0075).
export const runEnded = "routines.run_ended";

// A run that follows another is one deeper. Deeper than this, it is
// skipped.
export const maxDepth = 5;

const maxOutputChars = 4000;

export const namePattern = /^[a-z0-9][a-z0-9-]{0,62}$/;

const inputName = /^[a-zA-Z][a-zA-Z0-9_]{0,40}$/;

// The routine the value describes, or an Error naming what is wrong. A file
// in the ADR 0059 shape is read as the routine it would be now.
export function routineOf(value: unknown): Routine {
  const routine = checked(isFirstShape(value) ? fromFirstShape(value) : value);

  for (const [index, each] of routine.when.entries()) {
    if (each.kind === "schedule") {
      cronSchedule(each.cron, each.timeZone);
    } else if (each.kind === "event" && each.collect !== undefined) {
      cronSchedule(each.collect.cron, each.collect.timeZone ?? serverZone);
    } else if (
      each.kind === "watch" &&
      durationOf(each.every) < shortestWatchMs
    ) {
      throw new Error(
        `when.${String(index)}.every: a watch waits at least 5m between fetches`,
      );
    } else if (each.kind === "once" && !isZonedTime(each.at)) {
      throw new Error(`${each.at} must be an ISO 8601 time with a time zone`);
    }

    try {
      windowsOf(each);
    } catch (error) {
      throw new Error(
        `when.${String(index)}.windows: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  const { stopAfter } = routine.limits ?? {};

  if (stopAfter !== undefined && Number.isNaN(stopAtOf(routine) ?? 0)) {
    throw new Error(
      "limits.stopAfter must be a date, YYYY-MM-DD, or a time with a time zone",
    );
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

  checkStarts(routine);

  if (routine.coordinator === true && routine.do.kind === "message") {
    throw new Error("a coordinator starts a Session of its own");
  }

  for (const name of Object.keys(routine.output ?? {})) {
    if (!inputName.test(name)) {
      throw new Error(
        `output.${name}: a name is letters, digits and _, starting with a letter`,
      );
    }
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
    routine.do.prompt ?? "",
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

// A run starts an agent or a workflow, not both, and one that isn't a
// workflow's needs a prompt.
function checkStarts(routine: Routine): void {
  const { do: started } = routine;

  for (const [index, each] of routine.when.entries()) {
    if (each.agent !== undefined && each.workflow !== undefined) {
      throw new Error(`when.${String(index)} names an agent and a workflow`);
    }

    if (
      started.kind === "message" &&
      (each.agent !== undefined || each.workflow !== undefined)
    ) {
      throw new Error(
        `when.${String(index)}: a routine that messages a Session starts no agent or workflow`,
      );
    }
  }

  if (started.kind === "message") {
    return;
  }

  if (started.agent !== undefined && started.workflow !== undefined) {
    throw new Error("do names an agent and a workflow");
  }

  const prompted =
    started.workflow === undefined ||
    routine.when.some((each) => each.agent !== undefined);

  if (prompted && started.prompt === undefined) {
    throw new Error("do.prompt is required unless every run starts a workflow");
  }
}

// What a run starts: the trigger's agent or workflow, or else do's.
export function startOf(
  session: Extract<Routine["do"], { kind: "session" }>,
  override: Started,
): Started {
  if (override.agent !== undefined || override.workflow !== undefined) {
    return override;
  }

  return {
    ...(session.agent !== undefined && { agent: session.agent }),
    ...(session.workflow !== undefined && { workflow: session.workflow }),
  };
}

export interface Started {
  readonly agent?: string | undefined;
  readonly workflow?: string | undefined;
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
// A trigger on runEnded that names the routine it follows checks output
// fields against what that routine declares.
export function checkEvents(
  routine: Routine,
  declared: readonly DeclaredEvent[],
  declaredOutput: (name: string) => Routine["output"] = () => undefined,
): void {
  for (const [index, each] of routine.when.entries()) {
    if (each.kind !== "event" && each.kind !== "watch") {
      continue;
    }

    const known =
      each.kind === "watch"
        ? { fields: { ...watchFields } }
        : declared.find(({ type }) => type === each.event);

    if (known === undefined) {
      throw new Error(
        `when.${String(index)}: no event ${each.kind === "event" ? each.event : ""}`,
      );
    }

    const followed = each.where?.find(
      (where) => where.field === "routine" && "is" in where,
    );

    const output =
      each.kind === "event" &&
      each.event === runEnded &&
      followed !== undefined &&
      "is" in followed
        ? declaredOutput(String(followed.is))
        : undefined;

    const fields =
      output === undefined
        ? known.fields
        : {
            ...known.fields,
            properties: {
              ...(propertyOf(known.fields, "properties") as object),
              output: outputSchemaOf(output),
            },
          };

    for (const [at, where] of (each.where ?? []).entries()) {
      const misfit = misfitOf(where, fields);

      if (misfit !== undefined) {
        throw new Error(`when.${String(index)}.where.${String(at)}: ${misfit}`);
      }
    }
  }
}

function outputSchemaOf(output: NonNullable<Routine["output"]>): object {
  return {
    type: "object",
    properties: Object.fromEntries(
      Object.entries(output).map(([name, type]) => [
        name,
        typeof type === "string"
          ? { type }
          : { type: "array", items: { type: type[0] } },
      ]),
    ),
  };
}

// The output a run ends with, checked against the fields its routine
// declares: each of them, of its type, and nothing else. Without fields it
// goes on unchecked. An Error says what doesn't fit.
export function outputOf(
  routine: Routine,
  value: Output | undefined,
): Output | undefined {
  if (value !== undefined && JSON.stringify(value).length > maxOutputChars) {
    throw new Error(
      `the output is over ${String(maxOutputChars)} characters as JSON`,
    );
  }

  const declared = routine.output;

  if (declared === undefined) {
    return value;
  }

  const given = value ?? {};
  const extra = Object.keys(given).find((name) => !(name in declared));

  if (extra !== undefined) {
    throw new Error(`the routine's output has no field ${extra}`);
  }

  for (const [name, type] of Object.entries(declared)) {
    const each = given[name];
    const kind = typeof type === "string" ? type : type[0];

    const fits =
      typeof type === "string"
        ? typeof each === kind
        : Array.isArray(each) &&
          each.every((item: unknown) => typeof item === kind);

    if (!fits) {
      throw new Error(
        `output.${name} must be ${typeof type === "string" ? `a ${kind}` : `a list of ${kind}s`}`,
      );
    }
  }

  return given;
}

export interface Allowed {
  // The name the routine gives it, which a run proposes it by.
  readonly name: string;
  readonly action: DeclaredAction;
  readonly max: number;
  readonly approve: boolean;
}

// The actions the routine lets its runs propose, each found among the ones
// enabled plugins declare by its type or by its name alone. An Error names
// one it can't find.
export function allowedActions(
  routine: Routine,
  declared: readonly DeclaredAction[],
): readonly Allowed[] {
  return Object.entries(routine.actions ?? {}).map(([name, limit]) => {
    const exact = declared.find(({ type }) => type === name);

    const byName = declared.filter(
      ({ type }) => type.slice(type.indexOf(".") + 1) === name,
    );

    const action = exact ?? (byName.length === 1 ? byName[0] : undefined);

    if (action === undefined) {
      throw new Error(
        byName.length > 1
          ? `actions.${name}: name one of ${byName.map(({ type }) => type).join(", ")}`
          : `actions.${name}: no plugin that is on offers this action`,
      );
    }

    return typeof limit === "number"
      ? { name, action, max: limit, approve: false }
      : { name, action, max: limit.max, approve: limit.approve === true };
  });
}

// Whether a run of the routine proposes: a dry run does, and otherwise as
// the routine says, by whether outside input fired it.
export function proposesOf(
  routine: Routine,
  outsideInput: boolean,
  dryRun: boolean,
): boolean {
  const mode = routine.proposes ?? "outside-input";

  return (
    dryRun || mode === "always" || (mode === "outside-input" && outsideInput)
  );
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

  if (
    ("startsWith" in where || "matches" in where || "inGroup" in where) &&
    kind !== "string"
  ) {
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

// The server's own time zone, for what a routine names no zone for.
export const serverZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

// The zone a routine's days are counted in: its first schedule's.
export function zoneOf(routine: Routine | undefined): string {
  const scheduled = routine?.when.find((each) => each.kind === "schedule");

  return scheduled?.kind === "schedule" ? scheduled.timeZone : serverZone;
}

function windowsOf(each: Trigger) {
  return (each.windows ?? []).map((one) => ({
    outside: one.outside ?? "wait",
    ...timeWindow(
      one.days,
      one.from,
      one.to,
      one.timeZone ?? (each.kind === "schedule" ? each.timeZone : serverZone),
    ),
  }));
}

// Whether a firing of the trigger at the time goes now, waits until a later
// time, or is dropped.
export function admits(each: Trigger, at: number): "now" | "skip" | number {
  const windows = windowsOf(each);

  if (windows.length === 0 || windows.some(({ contains }) => contains(at))) {
    return "now";
  }

  const opens = windows
    .filter(({ outside }) => outside === "wait")
    .map(({ next }) => next(at))
    .filter((next) => next !== undefined);

  return opens.length === 0 ? "skip" : Math.min(...opens);
}

// ADR 0061: an event from a git host fires only for members of the
// repository, unless a condition says who may fire it.
export function admitsSender(each: Trigger, event: Heard): boolean {
  return (
    each.kind !== "event" ||
    !each.event.startsWith("git-hosts.") ||
    (each.where ?? []).some(
      (where) => where.field === "member" || where.field === "sender",
    ) ||
    !("member" in event.fields) ||
    event.fields["member"] === true
  );
}

// When the routine pauses itself, or NaN when its stopAfter isn't a date.
export function stopAtOf(routine: Routine): number | undefined {
  const { stopAfter } = routine.limits ?? {};

  if (stopAfter === undefined) {
    return undefined;
  }

  if (/^\d{4}-\d\d-\d\d$/.test(stopAfter)) {
    return Number.isNaN(Date.parse(stopAfter))
      ? Number.NaN
      : dayAfter(stopAfter, zoneOf(routine));
  }

  return isZonedTime(stopAfter) ? Date.parse(stopAfter) : Number.NaN;
}

const defaultTimeLimit = "2h";

const unitMs = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

const shortestWatchMs = 5 * 60_000;

// How long a run of the routine may be running. A coordinator lives for
// weeks and has no limit (ADR 0075).
export function timeLimitOf(
  routine: Routine,
): { readonly text: string; readonly ms: number } | undefined {
  if (routine.do.kind === "message" || routine.coordinator === true) {
    return undefined;
  }

  const text = routine.limits?.timeLimit ?? defaultTimeLimit;

  return { text, ms: durationOf(text) };
}

// How long a run's question waits for its answer, when the routine says.
export function questionTimeoutOf(routine: Routine): number | undefined {
  const text = routine.questions?.timeout;

  return text === undefined ? undefined : durationOf(text);
}

export function durationOf(text: string): number {
  const unit = text.at(-1) as keyof typeof unitMs;

  return Number(text.slice(0, -1)) * unitMs[unit];
}

// Who is on call for a list that rotates by ISO week: the first person in
// the list's first week of the year, then each in turn.
export function onCallOf(
  people: readonly string[],
  at: number,
): string | undefined {
  return people[(isoWeekOf(at) - 1) % people.length];
}

function isoWeekOf(at: number): number {
  const day = new Date(at);
  day.setUTCHours(0, 0, 0, 0);
  day.setUTCDate(day.getUTCDate() + 3 - ((day.getUTCDay() + 6) % 7));

  const firstThursday = new Date(Date.UTC(day.getUTCFullYear(), 0, 4));

  return (
    1 +
    Math.round(
      ((day.getTime() - firstThursday.getTime()) / 86_400_000 -
        3 +
        ((firstThursday.getUTCDay() + 6) % 7)) /
        7,
    )
  );
}

export function isZonedTime(text: string): boolean {
  return !Number.isNaN(Date.parse(text)) && /(Z|[+-]\d\d:?\d\d)$/i.test(text);
}

// What a routine hears: another plugin's event, or a webhook's delivery,
// with the inputs its trigger filled.
export interface Heard extends Started {
  readonly type: string;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly inputs?: Readonly<Record<string, unknown>>;
}

// Every condition holds. A field that is a list holds a condition when one
// of its items does, and isNot when none is the value. inGroup holds for a
// repository among the group's, as repositoryKey names them.
export function matches(
  event: Heard,
  where: readonly Condition[] = [],
  group: readonly string[] = [],
): boolean {
  const { host } = event.fields;

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

    if ("inGroup" in each) {
      return items.some(
        (item) =>
          typeof item === "string" &&
          group.includes(
            repositoryKey(item, typeof host === "string" ? host : undefined) ??
              "",
          ),
      );
    }

    return items.some((item) => holds(each, item));
  });
}

const defaultHost = "github.com";

// A repository as host/owner/name in lower case, from owner/name on the
// host, which is github.com unless one is given, from host/owner/name, or
// from its https address. undefined for text that names none.
export function repositoryKey(
  text: string,
  host = defaultHost,
): string | undefined {
  const bare = text
    .trim()
    .replace(/^https:\/\//i, "")
    .replace(/(\.git)?\/*$/, "")
    .toLowerCase();

  const parts = bare.split("/");

  if (parts.some((part) => part === "" || /\s/.test(part))) {
    return undefined;
  }

  if (parts.length === 2) {
    return `${host.toLowerCase()}/${bare}`;
  }

  return parts.length === 3 ? bare : undefined;
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

// A coordinator's one run hears every firing.
export function whileRunningOf(routine: Routine): WhileRunning {
  if (routine.coordinator === true) {
    return "tell";
  }

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
