import { href as pageHref, useApi, useLoaded } from "@pipoca/plugins/web";
import {
  Button,
  Card,
  Checkbox,
  Chip,
  ChoiceTiles,
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
import { type ReactElement, useState } from "react";
import { routines } from "../plugin";
import type { RoutineDraft } from "../src/making";

// A routine as it is being made: what the draft or the person wrote so far,
// which saving checks.
type Json = Readonly<Record<string, unknown>>;

const changes = ["routines"];

const examples = [
  "Every weekday at 8, summarise the issues opened since yesterday",
  "When an issue is labelled pipoca, fix it and open a pull request",
  "When a pull request merges in shop or api, update the docs in docs-site",
];

const builtInAgents = ["scout", "worker", "reviewer", "delegate"];

const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

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
  const [mode, setMode] = useState<"sentence" | "steps">("sentence");
  const [sentence, setSentence] = useState("");
  const [draftId, setDraftId] = useState<string>();
  const [failure, setFailure] = useState<string>();
  const [made, setMade] = useState<Made>();

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

  const fromDraft: Made | undefined =
    draft?.state === "ready" && made?.from !== draft.id
      ? {
          from: draft.id,
          value: objectOf(draft.routine),
          name: draft.name ?? "",
          problem: draft.error,
        }
      : undefined;

  const current = fromDraft ?? made;

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
        prefix === ""
          ? "What should happen by itself?"
          : "What should happen by itself for the team?"
      }
      description={
        <a href={pageHref(routines, "")} className="hover:underline">
          All routines
        </a>
      }
    >
      {mode === "sentence" ? (
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
              <span className="flex-1" />
              <Button
                variant="ghost"
                onClick={() => {
                  setMode("steps");
                }}
              >
                Pick step by step
              </Button>
              <Button variant="ghost" onClick={onJson}>
                Write JSON
              </Button>
              <Button
                variant="primary"
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
      ) : (
        <StepPicker
          made={current}
          onMade={setMade}
          onSentence={() => {
            setMode("sentence");
          }}
        />
      )}
      {current !== undefined &&
        (mode === "sentence" || current.checked === true) && (
          <DraftCard
            key={current.from}
            prefix={prefix}
            made={current}
            onChange={setMade}
          />
        )}
    </Page>
  );
}

interface Made {
  // The draft it came from, or "steps".
  readonly from: string;
  readonly value: Json;
  readonly name: string;
  readonly problem?: string | undefined;
  // The step picker reached its last step.
  readonly checked?: boolean;
}

type Step = "when" | "what" | "check";

const triggerTiles = [
  {
    value: "schedule",
    title: "On a schedule",
    description: "Every weekday at 8, every Friday",
  },
  {
    value: "event",
    title: "When something happens",
    description: "In your repositories or another plugin",
  },
  {
    value: "webhook",
    title: "When called",
    description: "A signed URL for CI or another tool",
  },
  { value: "once", title: "Once", description: "At one time on a date" },
] as const;

type TriggerKind = (typeof triggerTiles)[number]["value"];

const blank: Json = {
  title: "",
  when: [{ kind: "schedule", cron: "0 8 * * 1-5", timeZone }],
  do: { kind: "session", prompt: "", workspace: { kind: "event-repository" } },
};

// When, what and check, one at a time, as another way to the same draft.
function StepPicker({
  made,
  onMade,
  onSentence,
}: {
  readonly made: Made | undefined;
  readonly onMade: (made: Made) => void;
  readonly onSentence: () => void;
}): ReactElement {
  const [step, setStep] = useState<Step>("when");
  const value = made?.value ?? blank;
  const trigger = objectOf(listOf(value["when"])[0]);
  const work = objectOf(value["do"]);

  const change = (next: Json, to: Step = step): void => {
    setStep(to);

    onMade({
      from: "steps",
      value: next,
      name: made?.name ?? "",
      checked: to === "check",
    });
  };

  const order: readonly Step[] = ["when", "what", "check"];
  const next = order[order.indexOf(step) + 1];

  return (
    <Card raised className="flex flex-col gap-5">
      <Segmented
        label="Steps"
        options={[
          { value: "when", label: "1 When" },
          { value: "what", label: "2 What" },
          { value: "check", label: "3 Check" },
        ]}
        value={step}
        onChange={(to) => {
          change(value, to);
        }}
      />
      {step === "when" && (
        <>
          <ChoiceTiles
            label="When it runs"
            name="trigger"
            tiles={triggerTiles}
            value={trigger["kind"] as TriggerKind | undefined}
            onChange={(kind) => {
              change(withTrigger(value, triggerOfKind(kind)));
            }}
          />
          <TriggerFields
            trigger={trigger}
            onChange={(each) => {
              change(withTrigger(value, each));
            }}
          />
          {trigger["kind"] === "event" && (
            <ConditionsFields
              trigger={trigger}
              onChange={(each) => {
                change(withTrigger(value, each));
              }}
            />
          )}
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
      {step === "check" && (
        <p className="text-ui text-fg-dim">
          Check the routine below, change any chip, then save it.
        </p>
      )}
      <div className="flex items-center gap-2 border-t border-line pt-4">
        <Button variant="ghost" onClick={onSentence}>
          Describe it instead
        </Button>
        <span className="flex-1" />
        {next !== undefined && (
          <Button
            variant="primary"
            onClick={() => {
              change(value, next);
            }}
          >
            {next === "what" ? "Next: what it does" : "Next: check it"}
          </Button>
        )}
      </div>
    </Card>
  );
}

type Part =
  "trigger" | "conditions" | "agent" | "workspace" | "actions" | "limits";

// The routine as a sentence with a chip for each part, the defaults it
// keeps as plain lines, and everything else under More.
function DraftCard({
  prefix,
  made,
  onChange,
}: {
  readonly prefix: string;
  readonly made: Made;
  readonly onChange: (made: Made) => void;
}): ReactElement {
  const api = useApi(routines);
  const [open, setOpen] = useState<Part>();
  const [asJson, setAsJson] = useState(false);
  const [text, setText] = useState("");
  const [failure, setFailure] = useState<string>();
  const { value, name } = made;

  // Its file's name, from its title unless the person gives one.
  const target =
    name.trim() === "" ? slugOf(stringOf(value["title"])) : name.trim();

  const trigger = objectOf(listOf(value["when"])[0]);
  const work = objectOf(value["do"]);

  const events = useLoaded(
    async () => api.get<DeclaredEvent[]>("events"),
    "events",
  ).value;

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

    api.put(`${prefix}routines/${encodeURIComponent(target)}`, routine).then(
      () => {
        location.hash = pageHref(routines, `${prefix}${target}`);
      },
      (error: unknown) => {
        setFailure(error instanceof Error ? error.message : String(error));
      },
    );
  };

  const chip = (part: Part, label: string): ReactElement => (
    <button
      type="button"
      aria-expanded={open === part}
      aria-label={`Change ${part}: ${label}`}
      className="mx-0.5 cursor-pointer align-middle"
      onClick={() => {
        setOpen(open === part ? undefined : part);
      }}
    >
      <Chip className="h-8 border-line-strong text-ui hover:bg-hover">
        {label}
      </Chip>
    </button>
  );

  const event = events?.find(({ type }) => type === trigger["event"]);
  const problem = made.problem ?? failure;

  return (
    <Card
      padding="lg"
      role="region"
      aria-label="Draft"
      className="mt-5 flex flex-col gap-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-label font-medium text-fg-dim">Draft</span>
        <span className="flex-1" />
        <TextInput
          aria-label="Title"
          placeholder="Title"
          value={stringOf(value["title"])}
          onChange={(change) => {
            set(put(value, "title", change.target.value));
          }}
          className="w-56"
        />
        <TextInput
          aria-label="Name"
          placeholder={
            target === "" ? "name, such as docs-from-merges" : target
          }
          value={name}
          onChange={(change) => {
            onChange({ ...made, name: change.target.value });
          }}
          className="w-56 font-mono text-label"
        />
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
          <p className="text-title leading-[2.4] text-fg">
            {triggerLead(trigger)}{" "}
            {chip("trigger", triggerText(trigger, event))}
            {trigger["kind"] === "event" && (
              <> {chip("conditions", conditionsText(trigger))}</>
            )}
            , {chip("agent", agentText(work))}{" "}
            {work["kind"] === "message" ? "messages" : "works in"}{" "}
            {chip("workspace", workspaceText(work))}, proposes{" "}
            {chip("actions", actionsText(value))} and runs{" "}
            {chip("limits", limitsText(value))}.
          </p>
          {open !== undefined && (
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
          <ul aria-label="Defaults" className="flex flex-col gap-1.5">
            {defaultsOf(value).map((line) => (
              <li
                key={line}
                className="flex items-start gap-2 text-label text-fg-dim"
              >
                <Icon name="check" className="mt-0.5 size-3.5 shrink-0" />
                {line}
              </li>
            ))}
          </ul>
          <details>
            <summary className="cursor-pointer text-ui text-fg hover:underline">
              More: same work, workflow, model, Profile, who it acts as
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
        <span className="text-label text-fg-dim">
          Saving checks it and runs it once as a test.
        </span>
        <span className="flex-1" />
        <Button
          variant="ghost"
          onClick={() => {
            showJson(!asJson);
          }}
        >
          {asJson ? "Edit as a sentence" : "Edit as JSON"}
        </Button>
        <Button variant="primary" disabled={target === ""} onClick={save}>
          Save and test
        </Button>
      </div>
    </Card>
  );
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
      return (
        <>
          <Field label="When it runs">
            <Select
              aria-label="When it runs"
              value={stringOf(trigger["kind"])}
              onChange={(event) => {
                setTrigger(triggerOfKind(event.target.value as TriggerKind));
              }}
            >
              {triggerTiles.map((tile) => (
                <option key={tile.value} value={tile.value}>
                  {tile.title}
                </option>
              ))}
            </Select>
          </Field>
          <TriggerFields trigger={trigger} onChange={setTrigger} />
        </>
      );
    case "conditions":
      return <ConditionsFields trigger={trigger} onChange={setTrigger} />;
    case "agent":
      return <AgentFields work={work} onChange={setWork} />;
    case "workspace":
      return <WorkspaceFields work={work} onChange={setWork} />;
    case "actions":
      return <ActionsFields value={value} onChange={onChange} />;
    case "limits":
      return <LimitsFields value={value} onChange={onChange} />;
  }
}

function TriggerFields({
  trigger,
  onChange,
}: {
  readonly trigger: Json;
  readonly onChange: (trigger: Json) => void;
}): ReactElement | null {
  const api = useApi(routines);

  const events = useLoaded(
    async () => api.get<DeclaredEvent[]>("events"),
    "events",
  ).value;

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
    case "event":
      return (
        <Field label="Event">
          <Select
            aria-label="Event"
            value={stringOf(trigger["event"])}
            onChange={(event) => {
              onChange(put(trigger, "event", event.target.value));
            }}
          >
            <option value="">Pick an event</option>
            {events?.map((each) => (
              <option key={each.type} value={each.type}>
                {each.title} ({each.type})
              </option>
            ))}
          </Select>
        </Field>
      );
    default:
      return null;
  }
}

const operators = [
  "is",
  "isNot",
  "oneOf",
  "contains",
  "startsWith",
  "matches",
] as const;

type Operator = (typeof operators)[number];

const operatorLabels: Readonly<Record<Operator, string>> = {
  is: "is",
  isNot: "is not",
  oneOf: "is one of",
  contains: "contains",
  startsWith: "starts with",
  matches: "matches the path",
};

function ConditionsFields({
  trigger,
  onChange,
}: {
  readonly trigger: Json;
  readonly onChange: (trigger: Json) => void;
}): ReactElement {
  const api = useApi(routines);

  const events = useLoaded(
    async () => api.get<DeclaredEvent[]>("events"),
    "events",
  ).value;

  const fields = fieldsOf(
    events?.find(({ type }) => type === trigger["event"])?.fields,
  );

  const where = listOf(trigger["where"]).map(objectOf);

  const setWhere = (next: readonly Json[]): void => {
    onChange(put(trigger, "where", next.length === 0 ? undefined : next));
  };

  return (
    <div className="flex flex-col gap-2">
      <span className="text-label font-medium text-fg">Only if</span>
      {where.map((each, index) => {
        const operator =
          operators.find((name) => name in each) ?? ("is" as const);

        const field = stringOf(each["field"]);
        const type = fields[field];

        const replace = (next: Json): void => {
          setWhere(where.map((one, at) => (at === index ? next : one)));
        };

        return (
          <div
            key={index}
            className="flex flex-wrap items-center gap-2"
            aria-label={`Condition ${String(index + 1)}`}
            role="group"
          >
            {Object.keys(fields).length > 0 ? (
              <Select
                aria-label="Field"
                value={field}
                onChange={(event) => {
                  replace({ ...each, field: event.target.value });
                }}
              >
                {Object.keys(fields).map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </Select>
            ) : (
              <TextInput
                aria-label="Field"
                value={field}
                onChange={(event) => {
                  replace({ ...each, field: event.target.value });
                }}
                className="w-40"
              />
            )}
            <Select
              aria-label="Test"
              value={operator}
              onChange={(event) => {
                replace({
                  field,
                  [event.target.value]: each[operator] ?? "",
                });
              }}
            >
              {operators.map((name) => (
                <option key={name} value={name}>
                  {operatorLabels[name]}
                </option>
              ))}
            </Select>
            <TextInput
              aria-label="Value"
              value={
                operator === "oneOf"
                  ? listOf(each["oneOf"]).map(stringOf).join(", ")
                  : stringOf(each[operator])
              }
              onChange={(event) => {
                const text = event.target.value;

                replace({
                  field,
                  [operator]:
                    operator === "oneOf"
                      ? text.split(",").map((one) => typed(one.trim(), type))
                      : typed(text, type),
                });
              }}
              className="min-w-40 flex-1"
            />
            <Button
              variant="ghost"
              aria-label={`Remove condition ${String(index + 1)}`}
              onClick={() => {
                setWhere(where.filter((_, at) => at !== index));
              }}
            >
              <Icon name="x" />
            </Button>
          </div>
        );
      })}
      <div>
        <Button
          variant="ghost"
          onClick={() => {
            setWhere([
              ...where,
              { field: Object.keys(fields)[0] ?? "", is: "" },
            ]);
          }}
        >
          <Icon name="plus" />
          Only if…
        </Button>
      </div>
    </div>
  );
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
            const picked = event.target.value;

            setWorkspace(workspaceOfKind(picked));
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

function LimitsFields({
  value,
  onChange,
}: {
  readonly value: Json;
  readonly onChange: (value: Json) => void;
}): ReactElement {
  const limits = objectOf(value["limits"]);

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

  const fields = [
    { name: "maxRunning", label: "Runs at once", number: true },
    { name: "dailySpend", label: "Daily spend", number: true },
    { name: "timeLimit", label: "Time limit, such as 2h", number: false },
    { name: "retries", label: "Retries after a failure", number: true },
    { name: "stopAfter", label: "Stop after, YYYY-MM-DD", number: false },
  ] as const;

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {fields.map((each) => (
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
    </div>
  );
}

function MoreFields({
  value,
  onChange,
}: {
  readonly value: Json;
  readonly onChange: (value: Json) => void;
}): ReactElement {
  const work = objectOf(value["do"]);
  const sameWork = objectOf(value["sameWork"]);

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
    <div className="mt-3 grid gap-3 sm:grid-cols-2">
      <Field label="Same work" hint="Event fields that make one piece of work">
        <TextInput
          aria-label="Same work"
          placeholder="repository, number"
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
      {text("workflow", "Workflow", "A saved workflow, in place of the agent")}
      {text("model", "Model", "provider/id, such as openai/gpt-5")}
      {text("profile", "Profile")}
      {text("environment", "Environment")}
      {text("as", "Acts on git as", "A technical user, such as a GitHub App")}
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
    case "webhook":
      return { kind };
  }
}

function withTrigger(value: Json, trigger: Json): Json {
  return put(value, "when", [trigger, ...listOf(value["when"]).slice(1)]);
}

function triggerLead(trigger: Json): string {
  switch (trigger["kind"]) {
    case "schedule":
      return "Runs";
    case "once":
      return "Runs once";
    default:
      return "When";
  }
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

function triggerText(trigger: Json, event: DeclaredEvent | undefined): string {
  switch (trigger["kind"]) {
    case "schedule": {
      const cron = stringOf(trigger["cron"]);
      const [minute, hour, day, month, weekday = ""] = cron.split(/\s+/);
      const daily = day === "*" && month === "*" && weekday in days;

      return daily && /^\d+$/.test(minute ?? "") && /^\d+$/.test(hour ?? "")
        ? `${days[weekday] ?? ""} at ${(hour ?? "").padStart(2, "0")}:${(minute ?? "").padStart(2, "0")}`
        : `on ${cron === "" ? "a schedule" : cron}`;
    }

    case "once":
      return stringOf(trigger["at"]) || "at a time";
    case "event":
      return event?.title ?? (stringOf(trigger["event"]) || "an event");
    case "webhook":
      return "its webhook is called";
    default:
      return "it is triggered";
  }
}

function conditionsText(trigger: Json): string {
  const where = listOf(trigger["where"]).map(objectOf);

  if (where.length === 0) {
    return "for every one";
  }

  return `if ${where
    .map((each) => {
      const operator = operators.find((name) => name in each) ?? "is";
      const wanted = each[operator];

      return `${stringOf(each["field"])} ${operatorLabels[operator]} ${
        Array.isArray(wanted)
          ? wanted.map(stringOf).join(" or ")
          : stringOf(wanted)
      }`;
    })
    .join(" and ")}`;
}

function agentText(work: Json): string {
  if (work["kind"] === "message") {
    return "Pipoca";
  }

  const agent = stringOf(work["agent"]);
  const workflow = stringOf(work["workflow"]);

  if (agent !== "") {
    return `the ${agent} agent`;
  }

  return workflow === "" ? "the Profile's agent" : `the ${workflow} workflow`;
}

function workspaceText(work: Json): string {
  if (work["kind"] === "message") {
    return `the Session ${stringOf(work["session"])}`;
  }

  const workspace = objectOf(work["workspace"]);

  switch (workspace["kind"]) {
    case "event-repository":
      return "the event's repository";
    case "clone":
      return (
        stringOf(workspace["repository"]).replace(/^https?:\/\/[^/]+\//, "") ||
        "a repository"
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

function actionsText(value: Json): string {
  const allowed = Object.entries(objectOf(value["actions"]));

  return allowed.length === 0
    ? "nothing"
    : allowed
        .map(([name, limit]) => {
          const max =
            typeof limit === "number" ? limit : objectOf(limit)["max"];

          return `${name.slice(name.indexOf(".") + 1)} ×${stringOf(max)}`;
        })
        .join(", ");
}

function limitsText(value: Json): string {
  const limits = objectOf(value["limits"]);

  const parts = [
    limits["maxRunning"] !== undefined &&
      `at most ${stringOf(limits["maxRunning"])} at once`,
    limits["dailySpend"] !== undefined &&
      `up to ${stringOf(limits["dailySpend"])} a day`,
    limits["timeLimit"] !== undefined &&
      `for up to ${stringOf(limits["timeLimit"])}`,
  ].filter((part) => typeof part === "string");

  return parts.length === 0 ? "without limits" : parts.join(", ");
}

// What the routine leaves to its defaults, in plain words.
function defaultsOf(value: Json): readonly string[] {
  const triggers = listOf(value["when"]).map(objectOf);
  const work = objectOf(value["do"]);
  const sameWork = objectOf(value["sameWork"]);
  const limits = objectOf(value["limits"]);

  const outside = triggers.some(
    ({ kind }) => kind === "event" || kind === "webhook",
  );

  return [
    sameWork["whileRunning"] === undefined &&
      (sameWork["key"] === undefined
        ? "One run at a time: a firing while one is going is skipped."
        : "A firing for work that has a run going is told to that run."),
    outside &&
      value["proposes"] === undefined &&
      "Runs that events or webhooks start can't push or post; they propose what to write.",
    work["kind"] === "session" &&
      limits["timeLimit"] === undefined &&
      "A run may take up to 2h.",
    work["kind"] === "session" &&
      work["model"] === undefined &&
      "Uses the agent's model, or else the Profile's default.",
  ].filter((line) => typeof line === "string");
}

function fieldsOf(
  schema: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(objectOf(schema?.["properties"])).map(([name, each]) => {
      const field = objectOf(each);

      return [
        name,
        field["type"] === "array"
          ? stringOf(objectOf(field["items"])["type"])
          : stringOf(field["type"]),
      ];
    }),
  );
}

function typed(text: string, type: string | undefined): unknown {
  if (type === "boolean" && (text === "true" || text === "false")) {
    return text === "true";
  }

  return (type === "number" || type === "integer") &&
    text !== "" &&
    !Number.isNaN(Number(text))
    ? Number(text)
    : text;
}

function put(value: Json, key: string, next: unknown): Json {
  const { [key]: _, ...rest } = value;

  return next === undefined || next === "" ? rest : { ...rest, [key]: next };
}

function objectOf(value: unknown): Json {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : {};
}

function listOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringOf(value: unknown): string {
  return typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
    ? String(value)
    : "";
}

function slugOf(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}
