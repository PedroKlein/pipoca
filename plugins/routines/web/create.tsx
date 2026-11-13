import { href as pageHref, useApi, useLoaded } from "@pipoca/plugins/web";
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Chip,
  ChoiceTiles,
  Dialog,
  DialogBody,
  DialogFoot,
  ErrorText,
  Field,
  Icon,
  Page,
  Segmented,
  Select,
  Spinner,
  TextArea,
  TextInput,
} from "@pipoca/ui";
import type { DeclaredAction, DeclaredEvent } from "@pipoca/protocol";
import { ReachWarning } from "./reach";
import { type ReactElement, useState } from "react";
import { routines } from "../plugin";
import type {
  GroupView,
  HeardEvent,
  RoutineDraft,
  RoutineView,
  WouldFire,
} from "../src/model";
import { changes } from "./common";
import {
  chipClass,
  ChipMenu,
  type ChipChoice,
  defaultsOf,
  fieldsOf,
  heardLabel,
  type Json,
  listOf,
  nounOf,
  objectOf,
  type Part,
  put,
  runEnded,
  Sentence,
  sentenceOf,
  slugOf,
  sortedOf,
  stringOf,
  valuesOfField,
} from "./sentence";
import { EventTriggerDialog, useEvents, useWouldFire } from "./trigger";

const examples = [
  "Every weekday at 8, summarise new issues",
  "Fix issues I label pipoca",
  "When main goes red, find out why",
];

const builtInAgents = ["scout", "worker", "reviewer", "delegate"];

const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

interface Named {
  readonly id: string;
  readonly name: string;
}

interface Handed {
  readonly prefix: string;
  readonly value: Json;
  readonly name: string;
}

let handed: Handed | undefined;

// Opens the new routine form with a routine to change and save, such as
// one the Team assistant proposed.
export function openInForm(prefix: string, value: Json, name: string): void {
  handed = { prefix, value, name };
  location.hash = pageHref(routines, `${prefix}new`);
}

function takeHanded(prefix: string): Made | undefined {
  const taken = handed?.prefix === prefix ? handed : undefined;

  handed = undefined;

  return taken && { from: "form", value: taken.value, name: taken.name };
}

// Making a routine (ADR 0075): from one sentence Pipoca drafts, or step by
// step, then as a sentence with chips to change. The JSON stays.
export function NewRoutine({
  prefix,
  onJson,
}: {
  readonly prefix: string;
  readonly onJson: () => void;
}): ReactElement {
  const api = useApi(routines);
  const team = prefix !== "";
  const [steps, setSteps] = useState(false);
  const [picking, setPicking] = useState(false);
  const [sentence, setSentence] = useState("");
  const [draftId, setDraftId] = useState<string>();
  const [failure, setFailure] = useState<string>();
  const [made, setMade] = useState(() => takeHanded(prefix));
  const [group, setGroup] = useState("");
  const [profile, setProfile] = useState("");

  const groups =
    useLoaded(
      async () => api.get<GroupView[]>(`${prefix}groups`),
      `${prefix}groups`,
      { changes },
    ).value ?? [];

  const profiles =
    useLoaded(
      async () =>
        api.get<Named[]>(`/api/profiles?scope=${team ? "team" : "mine"}`),
      `profiles-${prefix}`,
      { topics: ["profiles"] },
    ).value ?? [];

  const draft = useLoaded(
    async () =>
      draftId === undefined
        ? undefined
        : api.get<RoutineDraft>(`${prefix}drafts/${draftId}`),
    `draft-${draftId ?? ""}`,
    // Also asked again now and then, in case a change was missed.
    {
      changes,
      ...(draftId !== undefined && made?.from !== draftId && { everyMs: 1500 }),
    },
  ).value;

  const withProfile = (value: Json, id: string): Json => {
    const work = objectOf(value["do"]);

    return work["kind"] === "message"
      ? value
      : put(value, "do", put(work, "profile", id));
  };

  const fromDraft: Made | undefined =
    draft?.state === "ready" && made?.from !== draft.id
      ? {
          from: draft.id,
          value:
            profile === ""
              ? objectOf(draft.routine)
              : withProfile(objectOf(draft.routine), profile),
          name: draft.name ?? "",
          problem: draft.error,
        }
      : undefined;

  const current = fromDraft ?? made;
  const picked = stringOf(objectOf(current?.value["do"])["profile"]) || profile;
  const profileName = profiles.find(({ id }) => id === picked)?.name ?? picked;
  const groupTitle = groups.find(({ name }) => name === group)?.title;

  const ask = (): void => {
    setFailure(undefined);
    setMade(undefined);

    api.post<RoutineDraft>(`${prefix}drafts`, { sentence, timeZone }).then(
      (asked) => {
        setDraftId(asked.id);
      },
      (error: unknown) => {
        setFailure(error instanceof Error ? error.message : String(error));
      },
    );
  };

  const drafting =
    draftId !== undefined &&
    (draft === undefined || draft.state === "drafting");

  return (
    <Page
      title={
        team
          ? "What should happen by itself for the team?"
          : "What should happen by itself?"
      }
      description={
        <a href={pageHref(routines, "")} className="hover:underline">
          All routines
        </a>
      }
    >
      <div className="flex flex-col gap-4">
        <Card raised className="flex flex-col gap-3">
          <TextArea
            aria-label="Describe the routine"
            rows={2}
            placeholder="When a pull request merges in shop or api, update the docs in docs-site"
            value={sentence}
            onChange={(event) => {
              setSentence(event.target.value);
            }}
            className="h-auto border-0 bg-transparent text-title shadow-none"
          />
          <div className="flex flex-wrap items-center gap-2">
            <ChipMenu
              name="Group"
              label={groupTitle ?? "No group"}
              choices={[
                {
                  label: "No group",
                  checked: group === "",
                  run: () => {
                    setGroup("");
                  },
                },
                ...groups.map((each) => ({
                  label: each.title,
                  checked: each.name === group,
                  run: () => {
                    setGroup(each.name);
                  },
                })),
              ]}
            />
            <ChipMenu
              name="Profile"
              label={profileName === "" ? "Default Profile" : profileName}
              choices={[
                { label: "Default Profile", id: "" },
                ...profiles.map(({ id, name }) => ({ label: name, id })),
              ].map(({ label, id }) => ({
                label,
                checked: id === picked,
                run: () => {
                  setProfile(id);

                  if (current !== undefined) {
                    setMade({
                      ...current,
                      value: withProfile(current.value, id),
                    });
                  }
                },
              }))}
            />
            <span className="flex-1" />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setSteps(true);
              }}
            >
              Pick step by step
            </Button>
            <Button variant="ghost" size="sm" onClick={onJson}>
              Write JSON
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={sentence.trim() === "" || drafting}
              onClick={ask}
            >
              Draft it
            </Button>
          </div>
        </Card>
        <div className="flex flex-wrap items-center gap-2 text-label">
          <span className="text-fg-dim">Try:</span>
          {examples.map((example) => (
            <button
              key={example}
              type="button"
              className="cursor-pointer"
              onClick={() => {
                setSentence(example);
              }}
            >
              <Chip>{example}</Chip>
            </button>
          ))}
        </div>
        {drafting && (
          <p className="flex items-center gap-2 text-ui text-fg-dim">
            <Spinner /> Drafting…
          </p>
        )}
        <ErrorText size="inherit" className="text-ui">
          {failure ?? (draft?.state === "failed" ? draft.error : undefined)}
        </ErrorText>
      </div>
      <Dialog
        open={steps}
        onClose={() => {
          setSteps(false);
        }}
        title="New routine"
        size="lg"
      >
        <StepPicker
          prefix={prefix}
          made={current}
          group={group === "" ? undefined : group}
          groupTitle={groupTitle}
          onMade={setMade}
          onMore={() => {
            setPicking(true);
          }}
          onSentence={() => {
            setSteps(false);
          }}
          onDone={(done) => {
            setMade({ ...done, checked: true });
            setSteps(false);
          }}
        />
      </Dialog>
      {picking && (
        <EventTriggerDialog
          open
          prefix={prefix}
          trigger={objectOf(listOf(current?.value["when"])[0])}
          group={group === "" ? undefined : group}
          groupTitle={groupTitle}
          testOn={current?.testOn}
          onCancel={() => {
            setPicking(false);
          }}
          onAdd={(each, testOn) => {
            const value = current?.value ?? blank;

            setMade({
              from: "steps",
              name: current?.name ?? "",
              value: withTrigger(value, each),
              testOn,
            });

            setPicking(false);
          }}
        />
      )}
      {current !== undefined &&
        (current.from !== "steps" || current.checked === true) && (
          <DraftCard
            key={current.from}
            prefix={prefix}
            made={current}
            group={group === "" ? undefined : group}
            groupTitle={groupTitle}
            profile={profileName}
            onChange={setMade}
          />
        )}
    </Page>
  );
}

interface Made {
  // The draft it came from, "steps" or "form".
  readonly from: string;
  readonly value: Json;
  readonly name: string;
  readonly problem?: string | undefined;
  // The step picker reached its last step.
  readonly checked?: boolean;
  // The recent event saving tests it on, in place of the newest it matches.
  readonly testOn?: string | undefined;
}

type Step = "when" | "what" | "check";

const triggerTiles = [
  {
    value: "schedule",
    title: "On a schedule",
    description: "Every weekday at 8, every Friday, once on a date",
  },
  {
    value: "event",
    title: "When something happens",
    description: "In your repositories or another plugin",
  },
  {
    value: "after",
    title: "After another routine",
    description: "Gets its summary and output",
  },
  {
    value: "webhook",
    title: "When called",
    description: "A signed URL for CI or another tool",
  },
] as const;

type TriggerKind = (typeof triggerTiles)[number]["value"] | "once";

const blank: Json = {
  title: "",
  when: [{ kind: "schedule", cron: "0 8 * * 1-5", timeZone }],
  do: { kind: "session", prompt: "", workspace: { kind: "event-repository" } },
};

// When and what, one at a time, as another way to the same draft.
function StepPicker({
  prefix,
  made,
  group,
  groupTitle,
  onMade,
  onMore,
  onSentence,
  onDone,
}: {
  readonly prefix: string;
  readonly made: Made | undefined;
  readonly group: string | undefined;
  readonly groupTitle: string | undefined;
  readonly onMade: (made: Made) => void;
  // Opens the whole event trigger, outside this dialog.
  readonly onMore: () => void;
  readonly onSentence: () => void;
  readonly onDone: (made: Made) => void;
}): ReactElement {
  const [step, setStep] = useState<Step>("when");
  const value = made?.value ?? blank;
  const trigger = objectOf(listOf(value["when"])[0]);
  const work = objectOf(value["do"]);
  const kind = kindOf(trigger);

  const mine = (next: Json, testOn = made?.testOn): Made => ({
    from: "steps",
    value: next,
    name: made?.name ?? "",
    testOn,
  });

  const change = (next: Json, testOn?: string): void => {
    onMade(mine(next, testOn));
  };

  const go = (to: Step): void => {
    if (to === "check") {
      onDone(mine(value));
    } else {
      setStep(to);
    }
  };

  return (
    <>
      <div className="max-h-[calc(100dvh-180px)] overflow-y-auto">
        <DialogBody className="gap-5.5">
          <Segmented
            label="Steps"
            options={[
              { value: "when", label: "1 When" },
              { value: "what", label: "2 What" },
              { value: "check", label: "3 Check" },
            ]}
            value={step}
            onChange={go}
          />
          {step === "when" && (
            <>
              <ChoiceTiles
                label="When it runs"
                name="trigger"
                tiles={triggerTiles}
                value={kind === "once" ? "schedule" : kind}
                onChange={(picked) => {
                  change(withTrigger(value, triggerOfKind(picked)));
                }}
              />
              {(kind === "schedule" || kind === "once") && (
                <div className="flex flex-col gap-3">
                  <Segmented
                    label="How often"
                    options={[
                      { value: "schedule", label: "Repeats" },
                      { value: "once", label: "Once" },
                    ]}
                    value={kind}
                    onChange={(picked) => {
                      change(withTrigger(value, triggerOfKind(picked)));
                    }}
                  />
                  <TriggerFields
                    trigger={trigger}
                    onChange={(each) => {
                      change(withTrigger(value, each));
                    }}
                  />
                </div>
              )}
              {(kind === "event" || kind === "after") && (
                <EventCard
                  prefix={prefix}
                  trigger={trigger}
                  group={group}
                  groupTitle={groupTitle}
                  onChange={(each) => {
                    change(withTrigger(value, each), undefined);
                  }}
                  onMore={onMore}
                />
              )}
              {kind === "webhook" && (
                <p className="text-ui text-fg-dim">
                  Saving gives it a signed URL. Each call starts a run with the
                  body as its event.
                </p>
              )}
              <p className="text-label text-fg-dim">
                Each choice is one chip. Pick a chip to change it; a menu lists
                only what that event really has.
              </p>
            </>
          )}
          {step === "what" && (
            <>
              <Field label="Instructions for each run">
                <TextArea
                  aria-label="Instructions for each run"
                  rows={4}
                  value={stringOf(work["prompt"])}
                  onChange={(event) => {
                    change(
                      put(value, "do", put(work, "prompt", event.target.value)),
                    );
                  }}
                  className="h-auto"
                />
              </Field>
              <AgentFields
                work={work}
                onChange={(each) => {
                  change(put(value, "do", each));
                }}
              />
              <WorkspaceFields
                work={work}
                onChange={(each) => {
                  change(put(value, "do", each));
                }}
              />
            </>
          )}
        </DialogBody>
      </div>
      <DialogFoot>
        <Button variant="ghost" onClick={onSentence}>
          Describe it instead
        </Button>
        <span className="flex-1" />
        <Button
          variant="primary"
          onClick={() => {
            go(step === "when" ? "what" : "check");
          }}
        >
          {step === "when" ? "Next: what it does" : "Next: check it"}
        </Button>
      </DialogFoot>
    </>
  );
}

function kindOf(trigger: Json): TriggerKind | undefined {
  if (trigger["kind"] === "event") {
    return trigger["event"] === runEnded ? "after" : "event";
  }

  return triggerTiles.some(({ value }) => value === trigger["kind"]) ||
    trigger["kind"] === "once"
    ? (trigger["kind"] as TriggerKind)
    : undefined;
}

// An event trigger as a sentence of chips, each a menu of what the event
// has, with "Only if…" for the rest and what it would have fired on.
function EventCard({
  prefix,
  trigger,
  group,
  groupTitle,
  onChange,
  onMore,
}: {
  readonly prefix: string;
  readonly trigger: Json;
  readonly group: string | undefined;
  readonly groupTitle: string | undefined;
  readonly onChange: (trigger: Json) => void;
  readonly onMore: () => void;
}): ReactElement {
  const events = useEvents();
  const type = stringOf(trigger["event"]);
  const event = events?.find((each) => each.type === type);
  const heard = useWouldFire(prefix, trigger, group);
  const sorted = sortedOf(trigger, event, groupTitle);
  const noun = nounOf(trigger, event).replace(/^(a|an) /, "");

  return (
    <Card className="flex flex-col gap-3.5">
      <p className="text-title leading-[2.1] text-fg">
        {type === runEnded ? (
          <AfterSentence
            prefix={prefix}
            trigger={trigger}
            event={event}
            onChange={onChange}
          />
        ) : (
          <EventSentence
            prefix={prefix}
            trigger={trigger}
            event={event}
            events={events ?? []}
            group={group}
            groupTitle={groupTitle}
            onChange={onChange}
          />
        )}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onMore}>
          <Icon name="plus" />
          Only if…
        </Button>
        <span className="text-label text-fg-dim">
          {sorted.extra.length > 0
            ? `${String(sorted.extra.length)} more condition${sorted.extra.length === 1 ? "" : "s"}`
            : "such as a label, an author, a branch"}
        </span>
      </div>
      {heard !== undefined && (
        <p className="border-t border-line pt-3 text-label text-fg-dim">
          {heard.count} {noun} event{heard.count === 1 ? "" : "s"} of the last 7
          days would have fired this.
          {sorted.members &&
            ` Only repository members' work counts, so outside ${noun}s never start a run.`}
        </p>
      )}
    </Card>
  );
}

function EventSentence({
  prefix,
  trigger,
  event,
  events,
  group,
  groupTitle,
  onChange,
}: {
  readonly prefix: string;
  readonly trigger: Json;
  readonly event: DeclaredEvent | undefined;
  readonly events: readonly DeclaredEvent[];
  readonly group: string | undefined;
  readonly groupTitle: string | undefined;
  readonly onChange: (trigger: Json) => void;
}): ReactElement {
  const type = stringOf(trigger["event"]);
  const source = type.slice(0, type.indexOf(".") + 1);
  const fields = fieldsOf(event?.fields);
  const declared = objectOf(objectOf(event?.fields)["properties"]);
  const where = listOf(trigger["where"]).map(objectOf);
  const sorted = sortedOf(trigger, event, groupTitle);

  const recent =
    useWouldFire(prefix, { kind: "event", event: type }, undefined)?.events ??
    [];

  const seen = (field: string): readonly string[] =>
    [...new Set(recent.map((each) => stringOf(each.fields[field])))].filter(
      (each) => each !== "",
    );

  const isWhat = (each: Json): boolean =>
    (each["field"] === "action" && ("is" in each || "oneOf" in each)) ||
    (fields[stringOf(each["field"])] === "boolean" &&
      typeof each["is"] === "boolean" &&
      each["field"] !== "member");

  const isWhere = (each: Json): boolean => each["field"] === "repository";

  const replace = (drop: (each: Json) => boolean, add: readonly Json[]) => {
    const next = [...where.filter((each) => !drop(each)), ...add];

    onChange(put(trigger, "where", next.length === 0 ? undefined : next));
  };

  const actions = [
    ...new Set([
      ...valuesOfField(declared["action"]).map(String),
      ...seen("action"),
    ]),
  ];

  const flags = Object.keys(fields).filter(
    (name) => fields[name] === "boolean" && name !== "member",
  );

  const what: readonly ChipChoice[] = [
    {
      label: "happens",
      checked: sorted.what === "happens",
      run: () => {
        replace(isWhat, []);
      },
    },
    ...actions.map((action) => ({
      label: `is ${action}`,
      checked: sorted.what === `is ${action}`,
      run: () => {
        replace(isWhat, [{ field: "action", is: action }]);
      },
    })),
    ...flags.map((flag) => ({
      label: `is ${flag}`,
      checked: sorted.what === `is ${flag}`,
      run: () => {
        replace(isWhat, [{ field: flag, is: true }]);
      },
    })),
  ];

  const places: readonly ChipChoice[] = [
    {
      label: "any repository",
      checked: sorted.where === "any repository",
      run: () => {
        replace(isWhere, []);
      },
    },
    ...(group === undefined
      ? []
      : [
          {
            label: `any repo of ${groupTitle ?? group}`,
            checked: sorted.where === `any repo of ${groupTitle ?? group}`,
            run: () => {
              replace(isWhere, [{ field: "repository", inGroup: true }]);
            },
          },
        ]),
    ...seen("repository").map((repository) => ({
      label: repository,
      checked: sorted.where === repository,
      run: () => {
        replace(isWhere, [{ field: "repository", is: repository }]);
      },
    })),
  ];

  const noun = nounOf(trigger, event);

  return (
    <>
      {noun.startsWith("an ") ? "An" : "A"}{" "}
      <ChipMenu
        name="Event"
        label={noun.replace(/^(a|an) /, "")}
        choices={events
          .filter((each) => each.type.startsWith(source))
          .map((each) => ({
            label: each.title.toLowerCase(),
            checked: each.type === type,
            run: () => {
              onChange({
                ...trigger,
                event: each.type,
                where: where.filter(isWhere),
              });
            },
          }))}
      />{" "}
      <ChipMenu name="What happens" label={sorted.what} choices={what} />
      {sorted.where !== undefined && (
        <>
          {" "}
          in <ChipMenu name="Where" label={sorted.where} choices={places} />
        </>
      )}
    </>
  );
}

function AfterSentence({
  prefix,
  trigger,
  event,
  onChange,
}: {
  readonly prefix: string;
  readonly trigger: Json;
  readonly event: DeclaredEvent | undefined;
  readonly onChange: (trigger: Json) => void;
}): ReactElement {
  const api = useApi(routines);
  const where = listOf(trigger["where"]).map(objectOf);
  const declared = objectOf(objectOf(event?.fields)["properties"]);

  const list =
    useLoaded(
      async () => api.get<RoutineView[]>(`${prefix}routines`),
      `${prefix}routines`,
      { changes },
    ).value ?? [];

  const valueOf = (field: string): string =>
    stringOf(where.find((each) => each["field"] === field)?.["is"]);

  const set = (field: string, to: string): void => {
    const rest = where.filter((each) => each["field"] !== field);
    const next = to === "" ? rest : [...rest, { field, is: to }];

    onChange(put(trigger, "where", next.length === 0 ? undefined : next));
  };

  const followed = valueOf("routine");
  const outcome = valueOf("outcome");

  return (
    <>
      After{" "}
      <ChipMenu
        name="Routine"
        label={
          list.find(({ name }) => name === followed)?.title ??
          (followed || "another routine")
        }
        choices={list.map((each) => ({
          label: each.title,
          checked: each.name === followed,
          run: () => {
            set("routine", each.name);
          },
        }))}
      />{" "}
      ends{" "}
      <ChipMenu
        name="Outcome"
        label={outcome === "" ? "with any outcome" : `with ${outcome}`}
        choices={["", ...valuesOfField(declared["outcome"]).map(String)].map(
          (each) => ({
            label: each === "" ? "with any outcome" : `with ${each}`,
            checked: each === outcome,
            run: () => {
              set("outcome", each);
            },
          }),
        )}
      />
    </>
  );
}

// The routine as a sentence with a chip for each part, the defaults it
// keeps as plain lines, and everything else under More.
function DraftCard({
  prefix,
  made,
  group,
  groupTitle,
  profile,
  onChange,
}: {
  readonly prefix: string;
  readonly made: Made;
  readonly group: string | undefined;
  readonly groupTitle: string | undefined;
  readonly profile: string;
  readonly onChange: (made: Made) => void;
}): ReactElement {
  const api = useApi(routines);
  const [open, setOpen] = useState<Part>();
  const [asJson, setAsJson] = useState(false);
  const [naming, setNaming] = useState(false);
  const [text, setText] = useState("");
  const [failure, setFailure] = useState<string>();
  const { value, name } = made;
  const events = useEvents();

  // Its file's name, from its title unless the person gives one.
  const target =
    name.trim() === "" ? slugOf(stringOf(value["title"])) : name.trim();

  const trigger = objectOf(listOf(value["when"])[0]);
  const work = objectOf(value["do"]);
  const event = events?.find(({ type }) => type === trigger["event"]);
  const heard = useWouldFire(prefix, trigger, group);

  const testedOn =
    heard?.events.find(({ id }) => id === made.testOn) ?? heard?.events[0];

  const set = (next: Json): void => {
    setFailure(undefined);
    onChange({ ...made, value: next, problem: undefined });
  };

  const showJson = (on: boolean): void => {
    if (on) {
      setText(`${JSON.stringify(value, null, 2)}\n`);
      setAsJson(true);

      return;
    }

    try {
      set(objectOf(JSON.parse(text)));
      setAsJson(false);
    } catch (error) {
      setFailure(`Not JSON: ${String(error)}`);
    }
  };

  const save = (): void => {
    let routine: unknown = value;

    if (asJson) {
      try {
        routine = JSON.parse(text);
      } catch (error) {
        setFailure(`Not JSON: ${String(error)}`);

        return;
      }
    }

    const query = new URLSearchParams({
      ...(group !== undefined && { group }),
      ...(testedOn !== undefined &&
        made.testOn === testedOn.id && { test: testedOn.id }),
    }).toString();

    api
      .put(
        `${prefix}routines/${encodeURIComponent(target)}${query === "" ? "" : `?${query}`}`,
        routine,
      )
      .then(
        () => {
          location.hash = pageHref(routines, `${prefix}${target}`);
        },
        (error: unknown) => {
          setFailure(error instanceof Error ? error.message : String(error));
        },
      );
  };

  const onEvent = trigger["kind"] === "event";

  const chip = (part: Part, label: string): ReactElement => (
    <button
      type="button"
      aria-expanded={open === part}
      aria-label={`Change ${part}: ${label}`}
      className={`mx-0.5 ${chipClass}`}
      onClick={() => {
        setOpen(open === part ? undefined : part);
      }}
    >
      <span className="truncate">{label}</span>
    </button>
  );

  const problem = made.problem ?? failure;
  const picking = onEvent && (open === "trigger" || open === "conditions");

  const saving = savingText(onEvent, heard, testedOn);

  return (
    <Card
      padding="lg"
      role="region"
      aria-label="Draft"
      className="mt-5 flex flex-col gap-4"
    >
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="text-label font-medium text-fg-dim">Draft</span>
        <TextInput
          aria-label="Title"
          placeholder="Name it, such as Docs from merges"
          value={stringOf(value["title"])}
          onChange={(change) => {
            set(put(value, "title", change.target.value));
          }}
          className="min-w-56 flex-1 border-transparent bg-transparent text-title font-medium shadow-none hover:border-line focus:border-line-focus"
        />
        {naming ? (
          <TextInput
            aria-label="Name"
            autoFocus
            placeholder={target === "" ? "docs-from-merges" : target}
            value={name}
            onChange={(change) => {
              onChange({ ...made, name: change.target.value });
            }}
            onBlur={() => {
              setNaming(false);
            }}
            className="w-56 font-mono text-label"
          />
        ) : (
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Change the name: ${target}`}
            onClick={() => {
              setNaming(true);
            }}
            className="font-mono font-normal"
          >
            {target === "" ? "name" : target}
          </Button>
        )}
      </div>
      {asJson ? (
        <TextArea
          aria-label="Routine JSON"
          rows={16}
          spellCheck={false}
          value={text}
          onChange={(change) => {
            setText(change.target.value);
          }}
          className="h-auto font-mono text-label"
        />
      ) : (
        <>
          <p className="text-[18px] leading-[2.1] text-fg">
            <Sentence
              phrases={sentenceOf(value, { events, group: groupTitle })}
              chip={chip}
            />
          </p>
          {open !== undefined && !picking && (
            <div className="flex flex-col gap-3 rounded-lg border border-line bg-panel p-4">
              <PartFields part={open} value={value} onChange={set} />
              <div>
                <Button
                  onClick={() => {
                    setOpen(undefined);
                  }}
                >
                  Done
                </Button>
              </div>
            </div>
          )}
          {work["kind"] !== "message" && (
            <Field label="Instructions for each run">
              <TextArea
                aria-label="Instructions for each run"
                rows={3}
                value={stringOf(work["prompt"])}
                onChange={(change) => {
                  set(
                    put(value, "do", put(work, "prompt", change.target.value)),
                  );
                }}
                className="h-auto"
              />
            </Field>
          )}
          {work["kind"] !== "message" && (
            <ReachWarning
              repository={
                objectOf(work["workspace"])["kind"] === "clone"
                  ? stringOf(objectOf(work["workspace"])["repository"])
                  : ""
              }
              environment={stringOf(work["environment"])}
              team={prefix !== ""}
              onUse={(environment) => {
                set(put(value, "do", put(work, "environment", environment)));
              }}
            />
          )}
          <ul aria-label="Defaults" className="flex flex-col gap-1.5">
            {defaultsOf(value, {
              team: prefix !== "",
              group: groupTitle ?? group,
              profile,
              noun: nounOf(trigger, event),
            }).map((line) => (
              <li
                key={line}
                className="flex items-start gap-2 text-label text-fg-dim"
              >
                <Badge>ok</Badge>
                <span>{line}</span>
              </li>
            ))}
          </ul>
          <details>
            <summary className="cursor-pointer text-ui text-fg underline decoration-line-strong underline-offset-3 hover:decoration-fg">
              More: same work, limits, model, workflow
            </summary>
            <MoreFields value={value} onChange={set} />
          </details>
        </>
      )}
      {problem !== undefined && (
        <ErrorText size="inherit" className="text-ui">
          {problem}. Change it with the chips or in the JSON.
        </ErrorText>
      )}
      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
        <span className="min-w-0 flex-1 text-label text-fg-dim">{saving}</span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            showJson(!asJson);
          }}
        >
          {asJson ? "Edit as a sentence" : "Edit as JSON"}
        </Button>
        <Button variant="primary" disabled={target === ""} onClick={save}>
          {onEvent && testedOn !== undefined ? "Save and test" : "Save"}
        </Button>
      </div>
      <EventTriggerDialog
        open={picking}
        prefix={prefix}
        trigger={trigger}
        group={group}
        groupTitle={groupTitle}
        testOn={made.testOn}
        onCancel={() => {
          setOpen(undefined);
        }}
        onAdd={(each, testOn) => {
          onChange({
            ...made,
            value: withTrigger(value, each),
            problem: undefined,
            testOn,
          });

          setOpen(undefined);
        }}
      />
    </Card>
  );
}

function savingText(
  onEvent: boolean,
  heard: WouldFire | undefined,
  testedOn: HeardEvent | undefined,
): string {
  if (!onEvent) {
    return "Saving checks it. Run it from its page to try it.";
  }

  if (testedOn !== undefined) {
    return `Saving tests it once on ${heardLabel(testedOn)} (${new Date(testedOn.at).toLocaleString()}).`;
  }

  return heard === undefined
    ? "Saving checks it and tests it on the newest event it matches."
    : "No event of the last 7 days matches, so it runs first on the next one.";
}

function PartFields({
  part,
  value,
  onChange,
}: {
  readonly part: Part;
  readonly value: Json;
  readonly onChange: (value: Json) => void;
}): ReactElement {
  const trigger = objectOf(listOf(value["when"])[0]);
  const work = objectOf(value["do"]);

  const setTrigger = (each: Json): void => {
    onChange(withTrigger(value, each));
  };

  const setWork = (each: Json): void => {
    onChange(put(value, "do", each));
  };

  switch (part) {
    case "trigger":
    case "conditions":
      return (
        <>
          <Field label="When it runs">
            <Select
              aria-label="When it runs"
              value={kindOf(trigger) ?? ""}
              onChange={(event) => {
                setTrigger(triggerOfKind(event.target.value as TriggerKind));
              }}
            >
              {[
                ...triggerTiles,
                { value: "once", title: "Once, on a date" } as const,
              ].map((tile) => (
                <option key={tile.value} value={tile.value}>
                  {tile.title}
                </option>
              ))}
            </Select>
          </Field>
          <TriggerFields trigger={trigger} onChange={setTrigger} />
        </>
      );
    case "agent":
      return <AgentFields work={work} onChange={setWork} />;
    case "workspace":
      return <WorkspaceFields work={work} onChange={setWork} />;
  }
}

function TriggerFields({
  trigger,
  onChange,
}: {
  readonly trigger: Json;
  readonly onChange: (trigger: Json) => void;
}): ReactElement | null {
  switch (trigger["kind"]) {
    case "schedule":
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Cron" hint="Minute hour day month weekday">
            <TextInput
              aria-label="Cron"
              value={stringOf(trigger["cron"])}
              onChange={(event) => {
                onChange(put(trigger, "cron", event.target.value));
              }}
              className="font-mono"
            />
          </Field>
          <Field label="Time zone">
            <TextInput
              aria-label="Time zone"
              value={stringOf(trigger["timeZone"])}
              onChange={(event) => {
                onChange(put(trigger, "timeZone", event.target.value));
              }}
            />
          </Field>
        </div>
      );
    case "once":
      return (
        <Field
          label="At"
          hint="A time with its zone, such as 2026-12-01T09:00:00+01:00"
        >
          <TextInput
            aria-label="At"
            value={stringOf(trigger["at"])}
            onChange={(event) => {
              onChange(put(trigger, "at", event.target.value));
            }}
          />
        </Field>
      );
    default:
      return null;
  }
}

function AgentFields({
  work,
  onChange,
}: {
  readonly work: Json;
  readonly onChange: (work: Json) => void;
}): ReactElement {
  return (
    <Field
      label="Agent"
      hint={`An agent file of the run's Profile, or a built-in one: ${builtInAgents.join(", ")}. Empty runs the Profile's main agent.`}
    >
      <TextInput
        aria-label="Agent"
        value={stringOf(work["agent"])}
        onChange={(event) => {
          onChange(put(work, "agent", event.target.value.trim()));
        }}
        className="font-mono"
      />
    </Field>
  );
}

const workspaceKinds = [
  { value: "event-repository", label: "The repository the event names" },
  { value: "group", label: "The group's repositories" },
  { value: "clone", label: "A clone of a repository" },
  { value: "folder", label: "A folder on the runner" },
] as const;

function WorkspaceFields({
  work,
  onChange,
}: {
  readonly work: Json;
  readonly onChange: (work: Json) => void;
}): ReactElement {
  const workspace = objectOf(work["workspace"]);
  const kind = stringOf(workspace["kind"]);

  const setWorkspace = (next: Json): void => {
    onChange(put(work, "workspace", next));
  };

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Works in">
        <Select
          aria-label="Works in"
          value={kind}
          onChange={(event) => {
            setWorkspace(workspaceOfKind(event.target.value));
          }}
        >
          {workspaceKinds.map((each) => (
            <option key={each.value} value={each.value}>
              {each.label}
            </option>
          ))}
        </Select>
      </Field>
      {kind === "clone" && (
        <Field label="Repository">
          <TextInput
            aria-label="Repository"
            placeholder="https://github.com/owner/name"
            value={stringOf(workspace["repository"])}
            onChange={(event) => {
              setWorkspace({ ...workspace, repository: event.target.value });
            }}
          />
        </Field>
      )}
      {kind === "folder" && (
        <Field label="Path">
          <TextInput
            aria-label="Path"
            value={stringOf(workspace["path"])}
            onChange={(event) => {
              setWorkspace({ ...workspace, path: event.target.value });
            }}
          />
        </Field>
      )}
    </div>
  );
}

function ActionsFields({
  value,
  onChange,
}: {
  readonly value: Json;
  readonly onChange: (value: Json) => void;
}): ReactElement {
  const api = useApi(routines);

  const declared = useLoaded(
    async () => api.get<DeclaredAction[]>("actions"),
    "actions",
  ).value;

  const allowed = objectOf(value["actions"]);

  const setAllowed = (name: string, limit: unknown): void => {
    const next = put(allowed, name, limit);

    onChange(
      put(value, "actions", Object.keys(next).length === 0 ? undefined : next),
    );
  };

  if (declared?.length === 0) {
    return <p className="text-label text-fg-dim">No plugin offers actions.</p>;
  }

  return (
    <ul className="flex flex-col gap-2">
      {declared?.map((action) => {
        const limit = allowed[action.type];
        const max = typeof limit === "number" ? limit : objectOf(limit)["max"];
        const approve = objectOf(limit)["approve"] === true;

        const write = (most: number, asks: boolean): void => {
          setAllowed(action.type, asks ? { max: most, approve: true } : most);
        };

        return (
          <li
            key={action.type}
            className="flex flex-wrap items-center gap-3 text-label"
          >
            <span className="min-w-40 flex-1 text-fg">{action.title}</span>
            <TextInput
              aria-label={`Most ${action.title} a run`}
              inputMode="numeric"
              placeholder="none"
              value={typeof max === "number" ? String(max) : ""}
              onChange={(event) => {
                const most = Number(event.target.value);

                if (event.target.value === "" || !Number.isInteger(most)) {
                  setAllowed(action.type, undefined);
                } else {
                  write(most, approve);
                }
              }}
              className="w-20"
            />
            <Checkbox
              label="Approve each"
              checked={approve}
              disabled={typeof max !== "number"}
              onChange={(event) => {
                write(typeof max === "number" ? max : 1, event.target.checked);
              }}
            />
          </li>
        );
      })}
    </ul>
  );
}

const limitFields = [
  { name: "dailySpend", label: "Daily spend", number: true },
  { name: "maxRunning", label: "Runs at once", number: true },
  { name: "timeLimit", label: "Time limit, such as 2h", number: false },
  { name: "retries", label: "Retries after a failure", number: true },
  { name: "stopAfter", label: "Stop after, YYYY-MM-DD", number: false },
] as const;

function MoreFields({
  value,
  onChange,
}: {
  readonly value: Json;
  readonly onChange: (value: Json) => void;
}): ReactElement {
  const work = objectOf(value["do"]);
  const sameWork = objectOf(value["sameWork"]);
  const limits = objectOf(value["limits"]);

  const setSameWork = (name: string, next: unknown): void => {
    const changed = put(sameWork, name, next);

    onChange(
      put(
        value,
        "sameWork",
        Object.keys(changed).length === 0 ? undefined : changed,
      ),
    );
  };

  const setLimit = (name: string, text: string, number: boolean): void => {
    const next = put(
      limits,
      name,
      number && text !== "" && !Number.isNaN(Number(text))
        ? Number(text)
        : text,
    );

    onChange(
      put(value, "limits", Object.keys(next).length === 0 ? undefined : next),
    );
  };

  const text = (name: string, label: string, hint?: string): ReactElement => (
    <Field label={label} hint={hint}>
      <TextInput
        aria-label={label}
        value={stringOf(work[name])}
        onChange={(event) => {
          onChange(
            put(value, "do", put(work, name, event.target.value.trim())),
          );
        }}
      />
    </Field>
  );

  return (
    <div className="mt-3 flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Same work"
          hint="Event fields that make one piece of work"
        >
          <TextInput
            aria-label="Same work"
            placeholder="The whole routine, one at a time"
            value={listOf(sameWork["key"]).map(stringOf).join(", ")}
            onChange={(event) => {
              const key = event.target.value
                .split(",")
                .map((one) => one.trim())
                .filter((one) => one !== "");

              setSameWork("key", key.length === 0 ? undefined : key);
            }}
          />
        </Field>
        <Field label="While a run of it is going">
          <Select
            aria-label="While a run of it is going"
            value={stringOf(sameWork["whileRunning"])}
            onChange={(event) => {
              setSameWork("whileRunning", event.target.value);
            }}
          >
            <option value="">The default</option>
            <option value="tell">Tell that run</option>
            <option value="skip">Skip the firing</option>
            <option value="queue">Run after it</option>
          </Select>
        </Field>
        {limitFields.map((each) => (
          <Field key={each.name} label={each.label}>
            <TextInput
              aria-label={each.label}
              inputMode={each.number ? "decimal" : undefined}
              value={stringOf(limits[each.name])}
              onChange={(event) => {
                setLimit(each.name, event.target.value, each.number);
              }}
            />
          </Field>
        ))}
        {text(
          "workflow",
          "Workflow",
          "A saved workflow, in place of the agent",
        )}
        {text("model", "Model", "provider/id, such as openai/gpt-5")}
        {text("environment", "Environment")}
        {text("as", "Acts on git as", "A technical user, such as a GitHub App")}
        <Field label="Runs that outside input fires">
          <Select
            aria-label="Runs that outside input fires"
            value={stringOf(value["proposes"])}
            onChange={(event) => {
              onChange(put(value, "proposes", event.target.value));
            }}
          >
            <option value="">Propose what they write (the default)</option>
            <option value="always">Every run proposes</option>
            <option value="never">Runs write themselves</option>
          </Select>
        </Field>
      </div>
      <Field label="What runs may propose">
        <ActionsFields value={value} onChange={onChange} />
      </Field>
    </div>
  );
}

function workspaceOfKind(kind: string): Json {
  switch (kind) {
    case "clone":
      return { kind, repository: "" };
    case "folder":
      return { kind, path: "" };
    default:
      return { kind };
  }
}

function triggerOfKind(kind: TriggerKind): Json {
  switch (kind) {
    case "schedule":
      return { kind, cron: "0 8 * * 1-5", timeZone };
    case "once":
      return { kind, at: "" };
    case "event":
      return { kind, event: "" };
    case "after":
      return {
        kind: "event",
        event: runEnded,
        where: [{ field: "routine", is: "" }],
      };
    case "webhook":
      return { kind };
  }
}

function withTrigger(value: Json, trigger: Json): Json {
  return put(value, "when", [trigger, ...listOf(value["when"]).slice(1)]);
}
