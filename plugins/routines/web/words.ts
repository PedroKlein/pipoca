import type { DeclaredEvent } from "@pipoca/protocol";
import type { Run } from "../src/model";
import type { Condition, Routine, Trigger } from "../src/routine";

// The event a run that ends publishes, and how deep a chain goes (ADR 0075).
export const runEnded = "routines.run_ended";
export const maxDepth = 5;

const endedOutcomes: readonly string[] = [
  "ok",
  "nothing",
  "failed",
  "blocked",
  "stopped",
];

const dayNames: Readonly<Record<string, string>> = {
  "*": "Every day",
  "0-6": "Every day",
  "1-5": "Every weekday",
  "0,6": "Weekends",
  "6,0": "Weekends",
  "0": "Sundays",
  "1": "Mondays",
  "2": "Tuesdays",
  "3": "Wednesdays",
  "4": "Thursdays",
  "5": "Fridays",
  "6": "Saturdays",
  "7": "Sundays",
};

// The last part of a time zone, such as Berlin for Europe/Berlin.
function placeOf(timeZone: string | undefined): string {
  return (timeZone?.split("/").at(-1) ?? "").replaceAll("_", " ");
}

export function scheduleWords(cron: string, timeZone?: string): string {
  const [minute = "", hour = "", day, month, weekday = ""] = cron
    .trim()
    .split(/\s+/);

  const days = dayNames[weekday];

  if (
    day !== "*" ||
    month !== "*" ||
    days === undefined ||
    !/^\d+$/.test(minute) ||
    !/^\d+$/.test(hour)
  ) {
    return `On the schedule ${cron}`;
  }

  return `${days} at ${hour.padStart(2, "0")}:${minute.padStart(2, "0")} ${placeOf(timeZone)}`.trim();
}

function valueWords(value: unknown): string {
  if (value === true) {
    return "yes";
  }

  if (value === false) {
    return "no";
  }

  if (value === "ok") {
    return "done";
  }

  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }

  return value === undefined || value === null
    ? "missing"
    : JSON.stringify(value);
}

type Scalar = Extract<Condition, { is: unknown }>["is"];

function listed(values: readonly Scalar[]): string {
  return values.map((value) => String(value)).join(" or ");
}

export function conditionWords(each: Condition): string {
  if ("is" in each) {
    return `${each.field} is ${String(each.is)}`;
  }

  if ("isNot" in each) {
    return `${each.field} is not ${String(each.isNot)}`;
  }

  if ("oneOf" in each) {
    return `${each.field} is ${listed(each.oneOf)}`;
  }

  if ("contains" in each) {
    return `${each.field} contains ${String(each.contains)}`;
  }

  if ("startsWith" in each) {
    return `${each.field} starts with ${each.startsWith}`;
  }

  return "matches" in each
    ? `${each.field} matches ${each.matches}`
    : `${each.field} is one of the group's`;
}

// The values a condition on the field asks for, or none.
function wanted(where: readonly Condition[], field: string): Scalar[] {
  return where.flatMap((each) => {
    if (each.field !== field) {
      return [];
    }

    if ("is" in each) {
      return [each.is];
    }

    if ("oneOf" in each) {
      return each.oneOf;
    }

    return "contains" in each ? [each.contains] : [];
  });
}

// Whether the trigger follows the routine's ended runs.
export function followsRoutine(trigger: Trigger, name: string): boolean {
  return (
    trigger.kind === "event" &&
    trigger.event === runEnded &&
    wanted(trigger.where ?? [], "routine").includes(name)
  );
}

const outcomeWords: Readonly<Record<string, string>> = {
  ok: "ends done",
  nothing: "ends with nothing",
  failed: "fails",
  blocked: "ends blocked",
  stopped: "stops",
};

// When a follower runs, such as "When it ends done and output.bug is true".
export function followWords(trigger: Trigger): string {
  const where = trigger.kind === "event" ? (trigger.where ?? []) : [];
  const outcomes = wanted(where, "outcome");

  const ends =
    outcomes.length === 0
      ? "ends"
      : outcomes.map((one) => outcomeWords[String(one)] ?? one).join(" or ");

  const rest = where
    .filter(({ field }) => field !== "routine" && field !== "outcome")
    .map(conditionWords);

  return `When it ${[ends, ...rest].join(" and ")}`;
}

function eventWords(
  trigger: Extract<Trigger, { kind: "event" }>,
  titleOf: (name: string) => string,
  events: readonly DeclaredEvent[],
): string {
  const where = trigger.where ?? [];

  if (trigger.event === runEnded) {
    const [source] = wanted(where, "routine");

    return source === undefined
      ? "After one of your routines"
      : `After ${titleOf(String(source))}`;
  }

  const title =
    events.find(({ type }) => type === trigger.event)?.title ?? trigger.event;

  const actions = wanted(where, "action");
  const labels = [...wanted(where, "label"), ...wanted(where, "labels")];
  const branches = wanted(where, "branch");

  return [
    title,
    labels.length > 0 ? `labelled ${listed(labels)}` : listed(actions),
    branches.length > 0 && `on ${listed(branches)}`,
  ]
    .filter((part) => part !== false && part !== "")
    .join(" ");
}

export function triggerWords(
  trigger: Trigger,
  titleOf: (name: string) => string,
  events: readonly DeclaredEvent[],
): string {
  switch (trigger.kind) {
    case "schedule":
      return scheduleWords(trigger.cron, trigger.timeZone);
    case "once":
      return `Once, ${new Date(trigger.at).toLocaleString()}`;
    case "webhook":
      return "A signed POST to its webhook";
    case "watch":
      return `When ${new URL(trigger.url).host} changes`;
    case "event":
      return eventWords(trigger, titleOf, events);
  }
}

export function whenWords(
  routine: Routine,
  titleOf: (name: string) => string,
  events: readonly DeclaredEvent[],
): string {
  return routine.when
    .map((each, index) => {
      const words = triggerWords(each, titleOf, events);

      return index === 0
        ? words
        : `${words.slice(0, 1).toLowerCase()}${words.slice(1)}`;
    })
    .join(", or ");
}

function repositoryName(repository: string): string {
  return repository.replace(/^https?:\/\/[^/]+\//, "").replace(/\.git$/, "");
}

// Where its runs work, such as acme/shop.
export function placeWords(routine: Routine): string {
  const work = routine.do;

  if (work.kind === "message") {
    return "a Session";
  }

  const { workspace } = work;

  switch (workspace.kind) {
    case "clone":
      return repositoryName(workspace.repository);
    case "repositories":
      return workspace.repositories
        .map(({ repository }) => repositoryName(repository))
        .join(", ");
    case "folder":
    case "worktree":
      return workspace.path.split("/").filter(Boolean).at(-1) ?? "a folder";
    case "group":
      return "the group's repositories";
    case "event-repository": {
      const named = routine.when.flatMap((each) =>
        each.kind === "event" ? wanted(each.where ?? [], "repository") : [],
      );

      return named.length > 0
        ? named.map(String).join(", ")
        : "the event's repository";
    }
  }
}

// A time near now as its weekday and time, others with their date.
export function shortTime(iso: string): string {
  const at = new Date(iso);
  const near = Math.abs(at.getTime() - Date.now()) < 6 * 24 * 3600 * 1000;

  return at.toLocaleString(
    undefined,
    near
      ? { weekday: "short", hour: "2-digit", minute: "2-digit" }
      : { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" },
  );
}

export function outputTypeWords(
  type: NonNullable<Routine["output"]>[string],
): string {
  const one = { string: "text", number: "number", boolean: "yes or no" };

  return typeof type === "string" ? one[type] : `list of ${one[type[0]]}s`;
}

function fieldOf(fields: Readonly<Record<string, unknown>>, path: string) {
  return path
    .split(".")
    .reduce<unknown>(
      (value, part) =>
        typeof value === "object" && value !== null
          ? (value as Record<string, unknown>)[part]
          : undefined,
      fields,
    );
}

// Whether the condition holds for the event's fields. A condition on a
// glob or a group is taken to hold, since only the server knows.
function holds(
  each: Condition,
  fields: Readonly<Record<string, unknown>>,
): boolean {
  const value = fieldOf(fields, each.field);
  const items: readonly unknown[] = Array.isArray(value) ? value : [value];

  if ("contains" in each) {
    return Array.isArray(value)
      ? value.includes(each.contains)
      : typeof value === "string" && value.includes(String(each.contains));
  }

  if ("isNot" in each) {
    return !items.includes(each.isNot);
  }

  if ("is" in each) {
    return items.includes(each.is);
  }

  if ("oneOf" in each) {
    return items.some((item) => each.oneOf.includes(item as never));
  }

  if ("startsWith" in each) {
    return items.some(
      (item) => typeof item === "string" && item.startsWith(each.startsWith),
    );
  }

  return true;
}

export interface Follower {
  readonly name: string;
  readonly title: string;
  readonly routine?: Routine;
}

export type Then =
  | { readonly kind: "none"; readonly text: string }
  | { readonly kind: "fed"; readonly followers: readonly Follower[] };

// What a run's end fed, or why it fed nothing, from the conditions of the
// routines that follow it.
export function thenOf(
  run: Run,
  source: { readonly name: string; readonly title: string },
  group: string | undefined,
  followers: readonly Follower[],
): Then {
  if (run.dryRun === true) {
    return { kind: "none", text: "dry runs feed nothing" };
  }

  if (!endedOutcomes.includes(run.outcome)) {
    return {
      kind: "none",
      text: run.outcome === "skipped" ? "skipped runs feed nothing" : "",
    };
  }

  if (followers.length === 0) {
    return { kind: "none", text: "nothing follows it" };
  }

  if ((run.depth ?? 0) >= maxDepth) {
    return {
      kind: "none",
      text: `${String(maxDepth)} deep, so the next one is skipped`,
    };
  }

  const fields = {
    routine: source.name,
    title: source.title,
    group: group ?? null,
    outcome: run.outcome,
    summary: run.reason,
    output: run.output ?? null,
    depth: run.depth ?? 0,
  };

  const triggersOf = (follower: Follower) =>
    (follower.routine?.when ?? []).filter((each) =>
      followsRoutine(each, source.name),
    );

  const fed = followers.filter((follower) =>
    triggersOf(follower).some(
      (each) =>
        each.kind === "event" &&
        (each.where ?? []).every((one) => holds(one, fields)),
    ),
  );

  if (fed.length > 0) {
    return { kind: "fed", followers: fed };
  }

  const [first] = followers;
  const [trigger] = first === undefined ? [] : triggersOf(first);

  const unmet =
    trigger?.kind === "event"
      ? (trigger.where ?? []).find((one) => !holds(one, fields))
      : undefined;

  if (first === undefined || unmet === undefined) {
    return { kind: "none", text: "nothing fed" };
  }

  return {
    kind: "none",
    text: `${unmet.field.replace(/^output\./, "")} is ${valueWords(fieldOf(fields, unmet.field))}, ${first.title} not fed`,
  };
}
