import {
  defineWeb,
  type MountedSession,
  SessionView,
  useApi,
  useLoaded,
} from "@pipoca/plugins/web";
import {
  Badge,
  type BadgeState,
  Button,
  buttonClass,
  Checkbox,
  cn,
  Code,
  ErrorText,
  Field,
  Icon,
  linkCardClass,
  Page,
  plural,
  Section,
  Select,
  TextArea,
  TextInput,
  useConfirm,
} from "@pipoca/ui";
import type { TypedClient } from "@pipoca/plugins";
import type { DeclaredAction, DeclaredEvent } from "@pipoca/protocol";
import { type ReactElement, useState } from "react";
import { routines } from "../plugin";
import type {
  Proposal,
  ProposalState,
  RoutineDetail,
  RoutineView,
  Run,
  WakeUp,
} from "../src/model";
import type { Routine } from "../src/routine";
import {
  changes,
  failureOf,
  groupPage,
  OutcomeBadge,
  pageAt,
  type Scope,
  summaryOf,
  teams,
  yours,
} from "./common";
import { GroupPage, GroupPicker, Groups, ImportGroup } from "./groups";
import { starters } from "./starters";

// Routines, a Session's pending wake-ups above its composer, and the notice
// each wake-up sends when it comes (ADR 0059).
export const web = defineWeb(routines, {
  pages: [
    {
      path: "",
      label: "Routines",
      Page: RoutinesPage,
      nav: {
        fills: (path) =>
          path
            .slice(path.startsWith(teams.prefix) ? teams.prefix.length : 0)
            .split("/").length > 1,
      },
    },
  ],
  // A run's Session is owned by "<owner>/<routine>".
  sessionPath: (session) => {
    const key = session.plugin?.key ?? "";
    const owner = key.slice(0, key.lastIndexOf("/"));
    const name = key.slice(key.lastIndexOf("/") + 1);

    return `${owner === "team" ? teams.prefix : ""}${name}/${session.id}`;
  },
  panels: { routines: { title: "Routines", Panel: TeamRoutines } },
  slots: {
    "session.composer": PendingWakeUps,
    "notice:wakeup": WakeUpNotice,
    "notice:routine": RoutineNotice,
  },
});

function RoutinesPage({ path }: { readonly path: string }): ReactElement {
  const scope = path.startsWith(teams.prefix) ? teams : yours;
  const [name = "", sessionId] = path.slice(scope.prefix.length).split("/");

  if (name === "") {
    return <RoutineList />;
  }

  if (name.startsWith(groupPage)) {
    const group = name.slice(groupPage.length);

    return (
      <GroupPage key={`${scope.prefix}${group}`} scope={scope} name={group} />
    );
  }

  if (sessionId !== undefined) {
    return <RunSession scope={scope} name={name} sessionId={sessionId} />;
  }

  return (
    <RoutinePage key={`${scope.prefix}${name}`} scope={scope} name={name} />
  );
}

function RoutineList(): ReactElement {
  const api = useApi(routines);

  const team =
    useLoaded(
      async () => api.get<unknown[]>("/api/environments?scope=team"),
      "team-environments",
      { topics: ["environments"] },
    ).value ?? [];

  return (
    <Page
      title="Routines"
      description="A routine runs a prompt on a schedule, each time in a new Session of its own, or as a message to one of your Sessions. Ask the assistant to make one, or write its JSON here."
      actions={
        <>
          <a href={pageAt(`${groupPage}new`)} className={buttonClass()}>
            New group
          </a>
          {team.length > 0 && (
            <a
              href={pageAt(`${teams.prefix}${groupPage}new`)}
              className={buttonClass()}
            >
              New team group
            </a>
          )}
          {team.length > 0 && (
            <a href={pageAt(`${teams.prefix}new`)} className={buttonClass()}>
              New team routine
            </a>
          )}
          <a
            href={pageAt("new")}
            className={buttonClass({ variant: "primary" })}
          >
            New routine
          </a>
        </>
      }
    >
      <Groups scope={yours} title="Your groups" />
      <Routines scope={yours} title="Yours" />
      {team.length > 0 && <Groups scope={teams} title="The team's groups" />}
      {team.length > 0 && <Routines scope={teams} title="The team's" />}
      <ImportGroup scope={yours} />
      {team.length > 0 && <ImportGroup scope={teams} />}
    </Page>
  );
}

function Routines({
  scope,
  title,
}: {
  readonly scope: Scope;
  readonly title: string;
}): ReactElement {
  const api = useApi(routines);

  const list = useLoaded(
    async () => api.get<RoutineView[]>(`${scope.prefix}routines`),
    scope.prefix,
    { changes },
  ).value;

  return (
    <Section title={title}>
      {list?.length === 0 && <p className="text-fg-dim">No routines yet.</p>}
      <ul className="flex flex-col gap-2">
        {list?.map((routine) => (
          <li key={routine.name}>
            <a
              href={pageAt(`${scope.prefix}${routine.name}`)}
              className={cn(
                linkCardClass,
                "flex min-w-0 items-center gap-3 px-3 py-2",
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-ui font-medium text-fg">
                  {routine.title}
                </span>
                <span className="block truncate text-label text-fg-dim">
                  {summaryOf(routine)}
                </span>
              </span>
              {routine.lastRun !== null && (
                <OutcomeBadge outcome={routine.lastRun.outcome} />
              )}
            </a>
          </li>
        ))}
      </ul>
    </Section>
  );
}

// The team's next scheduled run and how many are paused, for the hub's Home.
function TeamRoutines(): ReactElement {
  const api = useApi(routines);

  const list = useLoaded(
    async () => api.get<RoutineView[]>(`${teams.prefix}routines`),
    "team-panel",
    { changes },
  ).value;

  if (list === undefined) {
    return <p className="text-label text-fg-dim">Loading…</p>;
  }

  const next = list
    .flatMap(({ title, nextAt, paused }) =>
      nextAt !== null && paused === null ? [{ title, at: nextAt }] : [],
    )
    .sort((a, b) => a.at.localeCompare(b.at))[0];

  const paused = list.filter((routine) => routine.paused !== null).length;

  return (
    <div className="flex flex-col gap-2.5">
      <p className="text-label text-fg-dim">
        {list.length === 0 && "The team has no routines yet."}
        {list.length > 0 && next === undefined && "Nothing scheduled."}
        {next !== undefined && (
          <>
            Next: <b className="font-medium text-fg-strong">{next.title}</b>,{" "}
            {new Date(next.at).toLocaleString()}.
          </>
        )}
        {paused > 0 && ` ${plural(paused, "routine")} paused.`}
      </p>
      <a href={pageAt("")} className="self-start text-label text-fg underline">
        Open routines
      </a>
    </div>
  );
}

function startText(index: number): string {
  return `${JSON.stringify(starters[index]?.routine ?? {}, null, 2)}\n`;
}

function RoutinePage({
  scope,
  name,
}: {
  readonly scope: Scope;
  readonly name: string;
}): ReactElement {
  const api = useApi(routines);
  const [ask, asking] = useConfirm();
  const creating = name === "new";
  const [editing, setEditing] = useState(creating);
  const [failure, setFailure] = useState<string>();
  const path = `${scope.prefix}routines/${encodeURIComponent(name)}`;

  const { value: routine, reload } = useLoaded(
    async () => (creating ? undefined : api.get<RoutineDetail>(path)),
    `${scope.prefix}${name}`,
    { changes },
  );

  const [runForm, setRunForm] = useState<"run" | "dry" | undefined>();
  const inputs = Object.entries(routine?.routine?.inputs ?? {});

  const act = (action: string, body?: object): void => {
    setFailure(undefined);

    api.post(`${path}/${action}`, body).then(
      () => {
        setRunForm(undefined);
        reload();
      },
      (error: unknown) => {
        setFailure(failureOf(error));
      },
    );
  };

  return (
    <Page
      title={
        creating
          ? `New ${scope === teams ? "team " : ""}routine`
          : (routine?.title ?? name)
      }
      description={
        <a href={pageAt("")} className="hover:underline">
          All routines
        </a>
      }
    >
      {asking}
      {routine !== undefined && (
        <div className="flex flex-col gap-3">
          <p className="text-ui text-fg-dim">{summaryOf(routine)}</p>
          {routine.group !== undefined && (
            <p className="text-ui text-fg-dim">
              In the group{" "}
              <a
                href={pageAt(`${scope.prefix}${groupPage}${routine.group}`)}
                className="text-fg underline"
              >
                {routine.group}
              </a>
            </p>
          )}
          {routine.routine?.limits?.dailySpend !== undefined && (
            <p className="text-ui text-fg-dim">
              Spent today: {routine.spentToday.toFixed(2)} of its daily cap of{" "}
              {routine.routine.limits.dailySpend}
            </p>
          )}
          {(routine.createdBy !== null || routine.changedBy !== null) && (
            <p className="text-ui text-fg-dim">
              {routine.createdBy !== null && `Made by ${routine.createdBy}. `}
              {routine.changedBy !== null &&
                `Changed last by ${routine.changedBy}.`}
            </p>
          )}
          <ErrorText size="inherit" className="text-ui">
            {routine.error}
          </ErrorText>
          {writesOnOutsideInput(routine) && (
            <p className="text-ui text-waiting">
              Its runs write directly, so text strangers write in an issue,
              message or webhook can make it push or post.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {(["run", "dry"] as const).map((kind) => (
              <Button
                key={kind}
                variant={kind === "run" ? "primary" : "default"}
                disabled={routine.error !== undefined}
                onClick={() => {
                  if (inputs.length === 0) {
                    act("run", { dryRun: kind === "dry" });
                  } else {
                    setRunForm(runForm === kind ? undefined : kind);
                  }
                }}
              >
                {kind === "run" ? "Run now" : "Dry run"}
              </Button>
            ))}
            <Button
              onClick={() => {
                act(routine.paused === null ? "pause" : "resume");
              }}
            >
              {routine.paused === null ? "Pause" : "Resume"}
            </Button>
            <Button
              onClick={() => {
                setEditing(!editing);
              }}
            >
              Edit
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                void ask({
                  title: `Delete the routine “${routine.title}”?`,
                  confirm: "Delete",
                  danger: true,
                }).then(async (yes) => {
                  if (!yes) {
                    return;
                  }

                  await api.delete(path);
                  location.hash = pageAt("");
                });
              }}
            >
              Delete
            </Button>
          </div>
        </div>
      )}
      {runForm !== undefined && (
        <RunForm
          inputs={inputs}
          dryRun={runForm === "dry"}
          onRun={(given) => {
            act("run", { inputs: given, dryRun: runForm === "dry" });
          }}
        />
      )}
      <ErrorText size="inherit" className="mt-3 text-ui">
        {failure}
      </ErrorText>
      {routine?.webhook !== undefined && <Webhook {...routine.webhook} />}
      {editing && (creating || routine !== undefined) && (
        <Editor
          api={api}
          scope={scope}
          name={creating ? undefined : name}
          group={routine?.group ?? ""}
          text={
            routine?.routine === undefined
              ? (routine?.file ?? startText(0))
              : `${JSON.stringify(routine.routine, null, 2)}\n`
          }
          onSaved={(saved) => {
            setEditing(false);

            if (creating) {
              location.hash = pageAt(`${scope.prefix}${saved}`);
            } else {
              reload();
            }
          }}
        />
      )}
      {routine !== undefined && (
        <Section title="Runs">
          {routine.runs.length === 0 && (
            <p className="text-fg-dim">No runs yet.</p>
          )}
          <ul className="flex flex-col gap-1">
            {routine.runs.map((run) => (
              <RunRow
                key={run.id}
                href={pageAt(`${scope.prefix}${name}/${run.sessionId ?? ""}`)}
                run={run}
                act={act}
              />
            ))}
          </ul>
        </Section>
      )}
      {routine !== undefined && routine.history.length > 0 && (
        <Section title="History">
          <ul className="flex flex-col gap-1 text-label">
            {routine.history.map((change) => (
              <li key={`${change.at}-${change.change}`} className="flex gap-2">
                <time dateTime={change.at} className="text-fg-dim">
                  {new Date(change.at).toLocaleString()}
                </time>
                <span className="text-fg">
                  {change.change === "created" ? "Made" : "Changed"}
                  {change.by === null ? "" : ` by ${change.by}`}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </Page>
  );
}

function Webhook({
  path,
  secret,
}: {
  readonly path: string;
  readonly secret: string;
}): ReactElement {
  const [shown, setShown] = useState(false);

  return (
    <Section title="Webhook">
      <p className="text-ui text-fg-dim">
        POST JSON here, signed with the secret as{" "}
        <code>sha256=&lt;HMAC-SHA256 of the body in hex&gt;</code> in{" "}
        <code>X-Pipoca-Signature</code> or <code>X-Hub-Signature-256</code>, as
        GitHub signs webhooks, with an id of its own in{" "}
        <code>X-Pipoca-Delivery</code>.
      </p>
      <code className="break-all text-label text-fg">
        {new URL(path, location.origin).href}
      </code>
      <div className="flex min-w-0 items-center gap-2">
        <code className="min-w-0 truncate text-label text-fg">
          {shown ? secret : "•".repeat(24)}
        </code>
        <Button
          variant="ghost"
          onClick={() => {
            setShown(!shown);
          }}
        >
          {shown ? "Hide secret" : "Show secret"}
        </Button>
      </div>
    </Section>
  );
}

function Editor({
  api,
  scope,
  name,
  group: initialGroup,
  text: initial,
  onSaved,
}: {
  readonly api: TypedClient;
  readonly scope: Scope;
  readonly name: string | undefined;
  readonly group: string;
  readonly text: string;
  readonly onSaved: (name: string) => void;
}): ReactElement {
  const [text, setText] = useState(initial);
  const [group, setGroup] = useState(initialGroup);
  const [newName, setNewName] = useState("");
  const [failure, setFailure] = useState<string>();

  const save = (): void => {
    const target = name ?? newName.trim();
    let value: unknown;

    try {
      value = JSON.parse(text);
    } catch (error) {
      setFailure(`Not JSON: ${String(error)}`);

      return;
    }

    api
      .put(
        `${scope.prefix}routines/${encodeURIComponent(target)}?group=${encodeURIComponent(group)}`,
        value,
      )
      .then(
        () => {
          onSaved(target);
        },
        (error: unknown) => {
          setFailure(failureOf(error));
        },
      );
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
      className="mt-4 flex flex-col gap-2"
    >
      {name === undefined && (
        <div className="flex flex-wrap items-center gap-2 text-ui">
          <span className="text-fg-dim">Start from</span>
          {starters.map((starter, index) => (
            <Button
              key={starter.name}
              variant="ghost"
              onClick={() => {
                setText(startText(index));
                setNewName(starter.name);
              }}
            >
              {starter.label}
            </Button>
          ))}
        </div>
      )}
      {name === undefined && (
        <TextInput
          aria-label="Name"
          placeholder="name, such as daily-issues"
          value={newName}
          onChange={(event) => {
            setNewName(event.target.value);
          }}
        />
      )}
      <GroupPicker api={api} scope={scope} value={group} onChange={setGroup} />
      <TextArea
        aria-label="Routine JSON"
        rows={14}
        spellCheck={false}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
        }}
        className="h-auto font-mono text-label"
      />
      <ErrorText size="inherit" className="text-ui">
        {failure}
      </ErrorText>
      <DeclaredEvents api={api} />
      <DeclaredActions api={api} />
      <div>
        <Button type="submit" variant="primary">
          Save
        </Button>
      </div>
    </form>
  );
}

// What an event trigger can name, with the fields its filter and key read.
function DeclaredEvents({
  api,
}: {
  readonly api: TypedClient;
}): ReactElement | null {
  const events = useLoaded(
    async () => api.get<DeclaredEvent[]>("events"),
    "events",
  ).value;

  if (events === undefined || events.length === 0) {
    return null;
  }

  return (
    <details className="text-label text-fg-dim">
      <summary className="cursor-pointer">
        Events a trigger can name, as{" "}
        {
          '{ "kind": "event", "event": type, "where": [{ "field": name, "is": value }] }'
        }
      </summary>
      <ul className="mt-2 flex flex-col gap-2">
        {events.map((event) => (
          <li key={event.type}>
            <code className="text-fg">{event.type}</code>: {event.title}
            {event.description !== undefined && ` ${event.description}`}
            <span className="block">
              Fields: {fieldNames(event.fields).join(", ")}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}

// What a routine's actions can name, with the input each takes.
function DeclaredActions({
  api,
}: {
  readonly api: TypedClient;
}): ReactElement | null {
  const actions = useLoaded(
    async () => api.get<DeclaredAction[]>("actions"),
    "actions",
  ).value;

  if (actions === undefined || actions.length === 0) {
    return null;
  }

  return (
    <details className="text-label text-fg-dim">
      <summary className="cursor-pointer">
        Actions runs may propose, as{" "}
        {'"actions": { type: max } or { type: { "max": 3, "approve": true } }'}
      </summary>
      <ul className="mt-2 flex flex-col gap-2">
        {actions.map((action) => (
          <li key={action.type}>
            <code className="text-fg">{action.type}</code>: {action.title}
            {action.description !== undefined && ` ${action.description}`}
            <span className="block">
              Input: {fieldNames(action.input).join(", ")}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}

// Whether runs that outside input fires write directly (ADR 0076).
function writesOnOutsideInput(routine: RoutineDetail): boolean {
  return (
    routine.routine?.proposes === "never" &&
    routine.routine.when.some(
      ({ kind }) => kind === "event" || kind === "webhook",
    )
  );
}

type Input = NonNullable<Routine["inputs"]>[string];

// The routine's inputs as a form, each starting at its default, for one run.
function RunForm({
  inputs,
  dryRun,
  onRun,
}: {
  readonly inputs: readonly (readonly [string, Input])[];
  readonly dryRun: boolean;
  readonly onRun: (inputs: Readonly<Record<string, unknown>>) => void;
}): ReactElement {
  const [values, setValues] = useState<Record<string, string | boolean>>(() =>
    Object.fromEntries(
      inputs.map(([name, input]) => [
        name,
        input.type === "boolean"
          ? (input.default ?? false)
          : String(input.default ?? ""),
      ]),
    ),
  );

  const set = (name: string, value: string | boolean): void => {
    setValues({ ...values, [name]: value });
  };

  return (
    <form
      aria-label="Run with inputs"
      onSubmit={(event) => {
        event.preventDefault();

        onRun(
          Object.fromEntries(
            Object.entries(values).filter(([, value]) => value !== ""),
          ),
        );
      }}
      className="mt-4 flex max-w-md flex-col gap-3"
    >
      {inputs.map(([name, input]) => {
        const value = values[name];
        const label = `${name}${input.required === true ? " (required)" : ""}`;

        if (input.type === "boolean") {
          return (
            <Checkbox
              key={name}
              label={label}
              description={input.description}
              checked={value === true}
              onChange={(event) => {
                set(name, event.target.checked);
              }}
            />
          );
        }

        return (
          <Field key={name} label={label} hint={input.description}>
            {input.type === "oneOf" ? (
              <Select
                aria-label={name}
                value={String(value ?? "")}
                onChange={(event) => {
                  set(name, event.target.value);
                }}
              >
                {input.required !== true && <option value="" />}
                {input.values.map((each) => (
                  <option key={each} value={each}>
                    {each}
                  </option>
                ))}
              </Select>
            ) : (
              <TextInput
                aria-label={name}
                inputMode={input.type === "number" ? "decimal" : undefined}
                value={String(value ?? "")}
                onChange={(event) => {
                  set(name, event.target.value);
                }}
              />
            )}
          </Field>
        );
      })}
      <div>
        <Button type="submit" variant="primary">
          {dryRun ? "Dry run" : "Run"}
        </Button>
      </div>
    </form>
  );
}

function fieldNames(schema: Readonly<Record<string, unknown>>): string[] {
  const properties = schema["properties"];

  return typeof properties === "object" && properties !== null
    ? Object.keys(properties)
    : [];
}

function RunRow({
  href,
  run,
  act,
}: {
  readonly href: string;
  readonly run: Run;
  readonly act: (action: string, body?: object) => void;
}): ReactElement {
  const label = (
    <>
      <OutcomeBadge outcome={run.outcome} />
      {run.dryRun === true && <Badge state="offline">Dry run</Badge>}
      <time dateTime={run.firedAt} className="shrink-0 text-fg-dim">
        {new Date(run.firedAt).toLocaleString()}
      </time>
      <span className="text-fg-dim">{run.cause}</span>
      {run.reason !== null && (
        <span className="min-w-0 truncate text-fg">{run.reason}</span>
      )}
    </>
  );

  return (
    <li className="text-label">
      <div className="flex min-w-0 items-center gap-1">
        {run.sessionId === null ? (
          <span className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1">
            {label}
          </span>
        ) : (
          <a
            href={href}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1 hover:bg-hover"
          >
            {label}
          </a>
        )}
        <Button
          variant="ghost"
          aria-label={`Replay the run of ${new Date(run.firedAt).toLocaleString()}`}
          onClick={() => {
            act(`runs/${run.id}/replay`, {});
          }}
        >
          Replay
        </Button>
      </div>
      {run.questions !== undefined && run.questions.length > 0 && (
        <ul aria-label="Questions" className="ml-6 flex flex-col gap-1 py-1">
          {run.questions.map((question) => (
            <li key={question.id} className="flex flex-col">
              <span className="text-fg">{question.prompts.join(" ")}</span>
              <span className="text-fg-dim">
                {run.askedFor !== undefined && run.askedFor.length > 0
                  ? `For ${run.askedFor.join(", ")}. `
                  : ""}
                Waits until {new Date(question.closesAt).toLocaleString()}.
              </span>
            </li>
          ))}
        </ul>
      )}
      {run.proposals !== undefined && run.proposals.length > 0 && (
        <ul aria-label="Proposals" className="ml-6 flex flex-col gap-1 py-1">
          {run.proposals.map((proposal) => (
            <ProposalRow key={proposal.id} proposal={proposal} act={act} />
          ))}
        </ul>
      )}
    </li>
  );
}

const proposalStates: Readonly<
  Record<ProposalState, { readonly state: BadgeState; readonly label: string }>
> = {
  proposed: { state: "waiting", label: "Proposed" },
  waiting: { state: "waiting", label: "Waiting for approval" },
  applied: { state: "done", label: "Applied" },
  failed: { state: "failed", label: "Failed" },
  rejected: { state: "offline", label: "Rejected" },
  refused: { state: "failed", label: "Refused" },
  shown: { state: "offline", label: "Not applied: dry run" },
};

// What a run proposed, exactly as it would be written, and where it stands.
function ProposalRow({
  proposal,
  act,
}: {
  readonly proposal: Proposal;
  readonly act: (action: string, body?: object) => void;
}): ReactElement {
  const { state, label } = proposalStates[proposal.state];

  return (
    <li className="flex flex-col gap-1">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Badge state={state}>{label}</Badge>
        <span className="text-fg">{proposal.title}</span>
        {proposal.url !== null && (
          <a
            href={proposal.url}
            target="_blank"
            rel="noreferrer"
            className="min-w-0 truncate text-fg-dim hover:underline"
          >
            {proposal.url}
          </a>
        )}
        {proposal.result !== null && proposal.url === null && (
          <span className="min-w-0 truncate text-fg-dim">
            {proposal.result}
          </span>
        )}
      </div>
      <Code label={`What ${proposal.title} writes`} wrap>
        {JSON.stringify(proposal.input, null, 2)}
      </Code>
      {proposal.state === "waiting" && (
        <div className="flex gap-2">
          <Button
            variant="primary"
            onClick={() => {
              act(`proposals/${proposal.id}/approve`);
            }}
          >
            Approve
          </Button>
          <Button
            onClick={() => {
              act(`proposals/${proposal.id}/reject`);
            }}
          >
            Reject
          </Button>
        </div>
      )}
    </li>
  );
}

function RunSession({
  scope,
  name,
  sessionId,
}: {
  readonly scope: Scope;
  readonly name: string;
  readonly sessionId: string;
}): ReactElement {
  return (
    <SessionView
      sessionId={sessionId}
      layout="full"
      crumb={
        <>
          <a
            href={pageAt(`${scope.prefix}${name}`)}
            className="shrink-0 font-normal text-fg-dim hover:text-fg hover:underline"
          >
            {name}
          </a>
          <Icon
            name="chevron-right"
            className="size-3.5 shrink-0 text-fg-dim"
          />
        </>
      }
    />
  );
}

function PendingWakeUps({
  session,
}: {
  readonly session: MountedSession;
}): ReactElement | null {
  const api = useApi(routines);

  const { value, reload } = useLoaded(
    async () => api.get<readonly WakeUp[]>("wakeups", { session: session.id }),
    session.id,
    { changes: ["wakeups"] },
  );

  if (value === undefined || value.length === 0) {
    return null;
  }

  return (
    <ul
      aria-label="Wake-ups"
      className="flex flex-col gap-1 rounded-lg border border-line bg-panel px-3 py-1.5"
    >
      {value.map((wakeUp) => (
        <li
          key={wakeUp.id}
          className="flex min-w-0 items-center gap-2 text-label"
        >
          <Icon name="clock" className="size-4 shrink-0 text-fg-dim" />
          <span className="min-w-0 flex-1 truncate text-fg">
            {wakeUp.reason}
          </span>
          <time dateTime={wakeUp.dueAt} className="shrink-0 text-fg-dim">
            {whenOf(wakeUp.dueAt)}
          </time>
          <Button
            variant="ghost"
            size="xs"
            aria-label={`Cancel wake-up: ${wakeUp.reason}`}
            onClick={() => {
              void api.delete(`wakeups/${wakeUp.id}`).finally(reload);
            }}
          >
            Cancel
          </Button>
        </li>
      ))}
    </ul>
  );
}

function WakeUpNotice({ data }: { readonly data: unknown }): ReactElement {
  const { reason } = (data ?? {}) as { reason?: unknown };

  return (
    <p className="flex min-w-0 items-center gap-2 px-2 py-1 text-label text-fg-dim">
      <Icon name="clock" className="size-4 shrink-0" />
      <span className="truncate">
        Woke up: {typeof reason === "string" ? reason : "a wake-up"}
      </span>
    </p>
  );
}

function RoutineNotice({
  data,
  text,
}: {
  readonly data: unknown;
  readonly text: string;
}): ReactElement {
  const { title } = (data ?? {}) as { title?: unknown };

  return (
    <div className="flex min-w-0 flex-col gap-1 px-2 py-1 text-label text-fg-dim">
      <p className="flex min-w-0 items-center gap-2">
        <Icon name="clock" className="size-4 shrink-0" />
        <span className="truncate">
          Routine: {typeof title === "string" ? title : "a routine"}
        </span>
      </p>
      <p className="ml-6 break-words text-fg">{text}</p>
    </div>
  );
}

function whenOf(iso: string): string {
  const due = new Date(iso);
  const sameDay = due.toDateString() === new Date().toDateString();

  return due.toLocaleString(
    undefined,
    sameDay
      ? { hour: "2-digit", minute: "2-digit" }
      : { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" },
  );
}
