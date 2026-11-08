import { cn, Icon, popClass } from "@pipoca/ui";
import type { DeclaredEvent } from "@pipoca/protocol";
import {
  Fragment,
  type ReactElement,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import type { HeardEvent } from "../src/model";

// A routine as it is being made, as plain JSON (ADR 0075).
export type Json = Readonly<Record<string, unknown>>;

export const runEnded = "routines.run_ended";

// The parts of a routine a chip in its sentence changes.
export type Part = "trigger" | "conditions" | "agent" | "workspace";

export type Phrase = string | { readonly part: Part; readonly label: string };

export const operators = [
  "is",
  "isNot",
  "oneOf",
  "contains",
  "startsWith",
  "matches",
] as const;

export type Operator = (typeof operators)[number];

export const operatorLabels: Readonly<Record<Operator, string>> = {
  is: "is",
  isNot: "is not",
  oneOf: "is one of",
  contains: "contains",
  startsWith: "starts with",
  matches: "matches the path",
};

// What a sentence names besides the routine: its group's title.
export interface Known {
  readonly events: readonly DeclaredEvent[] | undefined;
  readonly group?: string | undefined;
}

// The routine as a short sentence, with a chip for each part to change.
export function sentenceOf(value: Json, known: Known): readonly Phrase[] {
  const triggers = listOf(value["when"]).map(objectOf);
  const trigger = triggers[0] ?? {};
  const work = objectOf(value["do"]);

  const more =
    triggers.length > 1 ? [`(or ${String(triggers.length - 1)} more)`] : [];

  const doing: readonly Phrase[] =
    work["kind"] === "message"
      ? [",", "tell", { part: "workspace", label: workspaceText(work) }, "."]
      : [
          ",",
          { part: "agent", label: agentText(work) },
          "in",
          { part: "workspace", label: workspaceText(work) },
          ".",
        ];

  return [...whenOf(trigger, known), ...more, ...doing];
}

function whenOf(trigger: Json, known: Known): readonly Phrase[] {
  switch (trigger["kind"]) {
    case "schedule":
      return [{ part: "trigger", label: capital(scheduleText(trigger)) }];
    case "once":
      return ["Once", { part: "trigger", label: atText(trigger) }];
    case "webhook":
      return ["When", { part: "trigger", label: "its webhook is called" }];
    case "watch":
      return [
        "When",
        { part: "trigger", label: `${stringOf(trigger["url"])} changes` },
      ];
    case "event":
      return [
        trigger["event"] === runEnded ? "After" : "When",
        ...eventPhrases(trigger, known),
      ];
    default:
      return ["When", { part: "trigger", label: "it is triggered" }];
  }
}

// What an event trigger listens for: which event, what happened to it,
// where, and any other condition.
export function eventPhrases(trigger: Json, known: Known): readonly Phrase[] {
  const event = known.events?.find(({ type }) => type === trigger["event"]);
  const sorted = sortedOf(trigger, event, known.group);

  if (trigger["event"] === runEnded) {
    const followed = sorted.extra.find(
      (each) => each["field"] === "routine" && "is" in each,
    );

    const rest = sorted.extra.filter((each) => each !== followed);

    return [
      {
        part: "trigger",
        label:
          followed === undefined
            ? "another routine"
            : stringOf(followed["is"]) || "another routine",
      },
      "ends",
      ...(rest.length === 0
        ? []
        : [{ part: "conditions" as const, label: `if ${whereText(rest)}` }]),
    ];
  }

  return [
    nounOf(trigger, event),
    { part: "trigger", label: sorted.what },
    ...(sorted.where === undefined
      ? []
      : ["in", { part: "conditions" as const, label: sorted.where }]),
    ...(sorted.extra.length === 0
      ? []
      : [",", { part: "conditions" as const, label: whereText(sorted.extra) }]),
  ];
}

// The event's own name in a sentence, such as "a pull request".
export function nounOf(
  trigger: Json,
  event: DeclaredEvent | undefined,
): string {
  const title = (event?.title ?? stringOf(trigger["event"])) || "an event";
  const lower = title.toLowerCase();

  return /^(a|an|the) /.test(lower)
    ? lower
    : `${/^[aeiou]/.test(lower) ? "an" : "a"} ${lower}`;
}

interface Sorted {
  readonly what: string;
  readonly where: string | undefined;
  readonly extra: readonly Json[];
  readonly members: boolean;
}

// Conditions by what they say: what happened, in which repository, who
// may fire it, and the rest.
export function sortedOf(
  trigger: Json,
  event: DeclaredEvent | undefined,
  group?: string,
): Sorted {
  const fields = fieldsOf(event?.fields);
  const where = listOf(trigger["where"]).map(objectOf);
  const what: string[] = [];
  const places: string[] = [];
  const extra: Json[] = [];
  let members = true;

  for (const each of where) {
    const field = stringOf(each["field"]);

    if (field === "member" || field === "sender") {
      members = false;
    } else if (field === "action" && ("is" in each || "oneOf" in each)) {
      what.push(`is ${valuesText(each["is"] ?? each["oneOf"])}`);
    } else if (fields[field] === "boolean" && typeof each["is"] === "boolean") {
      what.push(`${each["is"] ? "is" : "isn't"} ${field}`);
    } else if (field === "repository" && "inGroup" in each) {
      places.push(`any repo of ${group ?? "its group"}`);
    } else if (field === "repository" && ("is" in each || "oneOf" in each)) {
      places.push(valuesText(each["is"] ?? each["oneOf"]));
    } else {
      extra.push(each);
    }
  }

  const hasRepository = "repository" in fields || places.length > 0;
  const place = places.length === 0 ? "any repository" : places.join(" and ");

  return {
    what: what.length === 0 ? "happens" : what.join(" and "),
    where: hasRepository ? place : undefined,
    extra,
    members: members && stringOf(trigger["event"]).startsWith("git-hosts."),
  };
}

export function whereText(where: readonly Json[]): string {
  return where
    .map((each) => {
      const operator = operators.find((name) => name in each) ?? "is";

      return `${stringOf(each["field"])} ${operatorLabels[operator]} ${valuesText(each[operator])}`;
    })
    .join(" and ");
}

function valuesText(value: unknown): string {
  const all = Array.isArray(value) ? value.map(stringOf) : [stringOf(value)];

  return all.length < 2
    ? (all[0] ?? "")
    : `${all.slice(0, -1).join(", ")} or ${all.at(-1) ?? ""}`;
}

// A whole event trigger in plain words, such as "An issue in acme/shop is
// opened, by a member."
export function triggerSummary(
  trigger: Json,
  event: DeclaredEvent | undefined,
  group?: string,
): string {
  if (trigger["event"] === runEnded) {
    return `${eventPhrases(trigger, { events: event ? [event] : [], group })
      .map((each) => (typeof each === "string" ? each : each.label))
      .join(" ")
      .replace(/^/, "After ")}.`;
  }

  const sorted = sortedOf(trigger, event, group);
  const by = sorted.members ? ", by a member" : ", by anyone";

  const parts = [
    capital(nounOf(trigger, event)),
    sorted.where === undefined ? "" : ` in ${sorted.where}`,
    ` ${sorted.what}`,
    sorted.extra.length === 0 ? "" : `, if ${whereText(sorted.extra)}`,
    stringOf(trigger["event"]).startsWith("git-hosts.") ? by : "",
  ];

  return `${parts.join("")}.`;
}

const days: Readonly<Record<string, string>> = {
  "*": "every day",
  "1-5": "every weekday",
  "0": "every Sunday",
  "1": "every Monday",
  "2": "every Tuesday",
  "3": "every Wednesday",
  "4": "every Thursday",
  "5": "every Friday",
  "6": "every Saturday",
};

function scheduleText(trigger: Json): string {
  const cron = stringOf(trigger["cron"]);
  const [minute, hour, day, month, weekday = ""] = cron.split(/\s+/);
  const daily = day === "*" && month === "*" && weekday in days;

  return daily && /^\d+$/.test(minute ?? "") && /^\d+$/.test(hour ?? "")
    ? `${days[weekday] ?? ""} at ${(hour ?? "").padStart(2, "0")}:${(minute ?? "").padStart(2, "0")}`
    : `on ${cron === "" ? "a schedule" : cron}`;
}

function atText(trigger: Json): string {
  const at = Date.parse(stringOf(trigger["at"]));

  return Number.isNaN(at)
    ? stringOf(trigger["at"]) || "at a time"
    : `on ${new Date(at).toLocaleString()}`;
}

function agentText(work: Json): string {
  const agent = stringOf(work["agent"]);
  const workflow = stringOf(work["workflow"]);

  if (agent !== "") {
    return `run the ${agent} agent`;
  }

  return workflow === ""
    ? "follow the instructions"
    : `run the ${workflow} workflow`;
}

function workspaceText(work: Json): string {
  if (work["kind"] === "message") {
    return `the Session ${stringOf(work["session"])}`;
  }

  const workspace = objectOf(work["workspace"]);

  switch (workspace["kind"]) {
    case "event-repository":
      return "its repository";
    case "group":
      return "the group's repositories";
    case "clone":
      return (
        stringOf(workspace["repository"])
          .replace(/^https?:\/\/[^/]+\//, "")
          .replace(/\.git$/, "") || "a repository"
      );
    case "folder":
    case "worktree":
      return stringOf(workspace["path"]) || "a folder";
    case "repositories":
      return listOf(workspace["repositories"])
        .map((each) => stringOf(objectOf(each)["repository"]))
        .join(", ");
    default:
      return "somewhere";
  }
}

// Who a routine's runs act as, the Profile, where they run and what they
// may spend, in one line.
export function actsLine(
  value: Json,
  { team, profile }: { readonly team: boolean; readonly profile?: string },
): string {
  const work = objectOf(value["do"]);
  const spend = objectOf(value["limits"])["dailySpend"];
  const as = stringOf(work["as"]);
  const environment = stringOf(work["environment"]);
  const owner = team ? "team " : "";

  return [
    `Acts as ${as === "" ? actor(team) : as}`,
    profile === undefined || profile === ""
      ? `default ${owner}Profile`
      : `${owner}Profile ${profile}`,
    environment === "" ? `default ${owner}Environment` : environment,
    typeof spend === "number" ? `$${String(spend)} a day` : "no daily cap",
  ].join(" · ");
}

// What the routine leaves to its defaults, each in plain words: how the
// same work behaves, its group, who it acts as and what it may spend.
export function defaultsOf(
  value: Json,
  {
    team,
    group,
    profile,
    noun,
  }: {
    readonly team: boolean;
    readonly group: string | undefined;
    readonly profile: string | undefined;
    readonly noun: string;
  },
): readonly string[] {
  const triggers = listOf(value["when"]).map(objectOf);
  const work = objectOf(value["do"]);
  const sameWork = objectOf(value["sameWork"]);
  const key = listOf(sameWork["key"]).map(stringOf);
  const spend = objectOf(value["limits"])["dailySpend"];
  const as = stringOf(work["as"]);

  const whileRunning =
    stringOf(sameWork["whileRunning"]) || (key.length === 0 ? "skip" : "tell");

  const outside = triggers.some(
    ({ kind }) => kind === "event" || kind === "webhook",
  );

  const same = {
    skip: "One run at a time: what fires while one is going is skipped.",
    queue: `${capital(plural(noun))} that come while a run is going wait and run after it, one at a time.`,
    tell:
      key.length === 0
        ? `${capital(plural(noun))} that come while a run is going join that run.`
        : `${capital(plural(noun))} for the same ${key.join(" and ")} join the run going for it.`,
  }[whileRunning];

  const runsOn =
    profile === undefined || profile === ""
      ? `${team ? "the team's" : "your"} default Profile`
      : `the Profile ${profile}`;

  const proposes =
    outside && value["proposes"] === undefined
      ? "; runs that events start propose what they write"
      : "";

  return [
    same,
    group === undefined
      ? "In no group, so runs share no memory with other routines."
      : `Runs in the group ${group}, so they read its memory and count toward its budget.`,
    work["kind"] === "message"
      ? undefined
      : `Runs on ${runsOn} and acts on git as ${as === "" ? actor(team) : `${as}, not as you`}${proposes}.`,
    typeof spend === "number"
      ? `At most $${String(spend)} a day, then it pauses until tomorrow.`
      : "No daily spend cap. Set one under More.",
  ].filter((line) => line !== undefined);
}

function actor(team: boolean): string {
  return team ? "the team" : "you";
}

function plural(noun: string): string {
  const bare = noun.replace(/^(a|an|the) /, "");

  return bare === "" ? "events" : `${bare}s`;
}

export function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// A recent event, such as "acme/shop#412 Checkout total rounds wrong".
export function heardLabel(event: HeardEvent): string {
  const { repository, number, title, name } = event.fields;

  const where =
    typeof repository === "string"
      ? `${repository}${typeof number === "number" ? `#${String(number)}` : ""}`
      : "";

  const named =
    [title, name].find((each): each is string => typeof each === "string") ??
    "";

  return [where, named].filter((part) => part !== "").join(" ") || event.type;
}

// When a recent event came and what happened, such as "Thu 14:02 · labeled".
export function heardWhen(event: HeardEvent): string {
  const at = new Date(event.at).toLocaleString(undefined, {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

  const { action, outcome } = event.fields;
  const what = typeof action === "string" ? action : outcome;

  return typeof what === "string" ? `${at} · ${what}` : at;
}

// Draws a sentence's phrases, each chip through the given function.
export function Sentence({
  phrases,
  chip,
}: {
  readonly phrases: readonly Phrase[];
  readonly chip: (part: Part, label: string) => ReactNode;
}): ReactElement {
  return (
    <>
      {phrases.map((phrase, index) => {
        const next = phrases[index + 1];

        const space =
          next === "," || next === "." || next === undefined ? "" : " ";

        return (
          <Fragment key={index}>
            {typeof phrase === "string"
              ? phrase
              : chip(phrase.part, phrase.label)}
            {space}
          </Fragment>
        );
      })}
    </>
  );
}

export const chipClass =
  "inline-flex h-8 max-w-full cursor-pointer items-center gap-1 rounded-full border border-line-strong bg-elevated px-3 align-middle text-ui text-fg hover:bg-hover aria-expanded:bg-hover";

export interface ChipChoice {
  readonly label: string;
  readonly checked?: boolean;
  readonly run: () => void;
}

// A chip in a sentence that opens a menu of what it can be.
export function ChipMenu({
  label,
  name,
  choices,
}: {
  readonly label: string;
  // Names the menu, such as "Event".
  readonly name: string;
  readonly choices: readonly ChipChoice[];
}): ReactElement {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const close = (event: Event): void => {
      if (
        event instanceof KeyboardEvent
          ? event.key === "Escape"
          : box.current?.contains(event.target as Node) !== true
      ) {
        setOpen(false);
      }
    };

    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);

    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  return (
    <span ref={box} className="relative inline-block">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${name}: ${label}`}
        className={chipClass}
        onClick={() => {
          setOpen(!open);
        }}
      >
        <span className="truncate">{label}</span>
      </button>
      {open && (
        <span
          role="menu"
          aria-label={name}
          className={cn(
            "absolute top-full left-0 z-30 mt-1 flex max-h-72 min-w-48 flex-col overflow-y-auto text-left",
            popClass,
          )}
        >
          {choices.map((choice) => (
            <button
              key={choice.label}
              type="button"
              role="menuitemradio"
              aria-checked={choice.checked === true}
              onClick={() => {
                setOpen(false);
                choice.run();
              }}
              className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-ui leading-normal whitespace-nowrap text-fg hover:bg-hover"
            >
              <Icon
                name="check"
                className={cn(choice.checked !== true && "invisible")}
              />
              {choice.label}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

// The values a field of an event can have, as its declaration lists them:
// an enum, constants, true and false, or "such as a, b or c".
export function valuesOfField(
  schema: unknown,
): readonly (string | number | boolean)[] {
  const field = objectOf(schema);
  const listed = listOf(field["enum"]).filter(isScalar);

  if (listed.length > 0) {
    return listed;
  }

  const constants = listOf(field["anyOf"])
    .map((each) => objectOf(each)["const"])
    .filter(isScalar);

  if (constants.length > 0) {
    return constants;
  }

  if (field["type"] === "boolean") {
    return [true, false];
  }

  const such = /such as ([^.]+)/.exec(stringOf(field["description"]))?.[1];

  return such === undefined
    ? []
    : such
        .split(/,\s*|\s+or\s+|\s+and\s+/)
        .map((each) => each.trim())
        .filter((each) => /^[a-z_]+$/.test(each));
}

function isScalar(value: unknown): value is string | number | boolean {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

// Each field of an event's declaration by name, with its type, and its
// items' type for a list.
export function fieldsOf(schema: unknown): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(objectOf(objectOf(schema)["properties"])).map(
      ([name, each]) => {
        const field = objectOf(each);

        return [
          name,
          field["type"] === "array"
            ? stringOf(objectOf(field["items"])["type"])
            : stringOf(field["type"]) ||
              (listOf(field["anyOf"]).length > 0 ? "string" : ""),
        ];
      },
    ),
  );
}

export function typed(text: string, type: string | undefined): unknown {
  if (type === "boolean" && (text === "true" || text === "false")) {
    return text === "true";
  }

  return (type === "number" || type === "integer") &&
    text !== "" &&
    !Number.isNaN(Number(text))
    ? Number(text)
    : text;
}

export function put(value: Json, key: string, next: unknown): Json {
  const { [key]: _, ...rest } = value;

  return next === undefined || next === "" ? rest : { ...rest, [key]: next };
}

export function objectOf(value: unknown): Json {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : {};
}

export function listOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

export function stringOf(value: unknown): string {
  return isScalar(value) ? String(value) : "";
}

export function slugOf(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}
