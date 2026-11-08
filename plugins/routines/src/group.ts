import { type Static, Type } from "@pipoca/plugins";
import { Value } from "typebox/value";
import { limitsSchema, repositoryKey, type Routine } from "./routine";

const people = Type.Array(Type.String({ minLength: 1 }), {
  minItems: 1,
  maxItems: 50,
});

// A routine group as its folder's group.json holds it (ADR 0075). Its name
// is the folder's, and its owner the folder's owner.
export const groupSchema = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: 120 }),
    // owner/name on github.com, host/owner/name, or an https address.
    repositories: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), { maxItems: 50 }),
    ),
    // What its routines' runs start with unless they say.
    defaults: Type.Optional(
      Type.Object(
        {
          profile: Type.Optional(Type.String({ minLength: 1 })),
          environment: Type.Optional(Type.String({ minLength: 1 })),
          as: Type.Optional(Type.String({ minLength: 1 })),
        },
        { additionalProperties: false },
      ),
    ),
    // Defaults for its routines' own limits (ADR 0076).
    limits: Type.Optional(limitsSchema),
    // A cap for the whole group, which pauses it until the next day.
    budget: Type.Optional(
      Type.Object(
        { dailySpend: Type.Number({ exclusiveMinimum: 0 }) },
        { additionalProperties: false },
      ),
    ),
    // Rotations of people by ISO week, by name. A team routine that names
    // no one asks the first list.
    onCall: Type.Optional(Type.Record(Type.String({ minLength: 1 }), people)),
    // The people who may change it and its routines. Without it anyone who
    // may change its owner's routines may.
    editors: Type.Optional(people),
    // A coordinator's limits, for when a group has one.
    coordinator: Type.Optional(
      Type.Object(
        {
          atOnce: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
          askAbove: Type.Optional(Type.Integer({ minimum: 0, maximum: 20 })),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export type Group = Static<typeof groupSchema>;

export const groupFile = "group.json";

// The group the value describes, or an Error naming what is wrong.
export function groupOf(value: unknown): Group {
  if (!Value.Check(groupSchema, value)) {
    const [error] = Value.Errors(groupSchema, value);
    const at = error?.instancePath.slice(1).replaceAll("/", ".") ?? "";

    throw new Error(
      `${at === "" ? "group" : at} ${error?.message ?? "doesn't fit"}`,
    );
  }

  for (const [index, each] of (value.repositories ?? []).entries()) {
    if (repositoryKey(each) === undefined) {
      throw new Error(
        `repositories.${String(index)}: ${each} isn't owner/name, host/owner/name or an https address`,
      );
    }
  }

  return value;
}

// The group's repositories as repositoryKey names them, each once.
export function groupRepositories(group: Group | undefined): string[] {
  return [
    ...new Set(
      (group?.repositories ?? []).flatMap((each) => repositoryKey(each) ?? []),
    ),
  ];
}

// The routine as its runs go: the group's defaults and limits fill what it
// leaves out, and its editors are the group's unless it names its own. An
// Error says what in it needs a group it isn't in.
export function withGroup(routine: Routine, group: Group | undefined): Routine {
  const conditions = routine.when.flatMap((each) =>
    each.kind === "event" ? (each.where ?? []) : [],
  );

  const usesGroup =
    conditions.some((each) => "inGroup" in each) ||
    (routine.do.kind === "session" && routine.do.workspace.kind === "group");

  if (group === undefined) {
    if (routine.coordinator === true) {
      throw new Error("a coordinator is a group's: put it in one");
    }

    if (usesGroup) {
      throw new Error(
        "the routine names its group's repositories, but it is in no group",
      );
    }

    return routine;
  }

  if (usesGroup && groupRepositories(group).length === 0) {
    throw new Error(
      "the routine names its group's repositories, but its group has none",
    );
  }

  const limits = { ...group.limits, ...routine.limits };
  const editors = routine.editors ?? group.editors;
  const { profile, environment, as } = group.defaults ?? {};

  return {
    ...routine,
    ...(Object.keys(limits).length > 0 && { limits }),
    ...(editors !== undefined && { editors }),
    do:
      routine.do.kind === "message"
        ? routine.do
        : {
            ...(profile !== undefined && { profile }),
            ...(environment !== undefined && { environment }),
            ...(as !== undefined && { as }),
            ...routine.do,
          },
  };
}

const defaultAtOnce = 5;
const defaultAskAbove = 3;

// How many runs a group's coordinator may have going, and start in one turn
// before it asks.
export function coordinatorLimitsOf(group: Group | undefined): {
  readonly atOnce: number;
  readonly askAbove: number;
} {
  return {
    atOnce: group?.coordinator?.atOnce ?? defaultAtOnce,
    askAbove: group?.coordinator?.askAbove ?? defaultAskAbove,
  };
}

// The first on-call list's name, in the order group.json lists them.
export function firstOnCall(group: Group | undefined): string | undefined {
  return Object.keys(group?.onCall ?? {})[0];
}
