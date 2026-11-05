import {
  json,
  type NoticeProps,
  ok,
  type PageProps,
  type SessionPartProps,
  useLoaded,
  type WebContext,
  type WebPlugin,
} from "@pipoca/plugins/web";
import {
  Badge,
  type BadgeState,
  Button,
  cn,
  fieldClass,
  Icon,
  linkCardClass,
  PageTitle,
  Section,
  useConfirm,
} from "@pipoca/ui";
import type { DeclaredEvent } from "@pipoca/protocol";
import { type ReactElement, useState } from "react";
import type {
  RoutineDetail,
  RoutineView,
  Run,
  RunOutcome,
  WakeUp,
} from "../src/model";
import { starters } from "./starters";

const watched = { topics: ["routines.routines"] };

// A person's own routines, or the team's, which anyone on the team makes
// and changes (ADR 0067).
interface Scope {
  readonly api: "routines" | "team-routines";
  readonly page: "" | "team/";
}

const yours: Scope = { api: "routines", page: "" };
const teams: Scope = { api: "team-routines", page: "team/" };

// Routines, a Session's pending wake-ups above its composer, and the notice
// each wake-up sends when it comes (ADR 0059).
export const routines: WebPlugin = {
  name: "routines",
  nav: {
    label: "Routines",
    Page,
    fills: (path) => path.split("/").length > 1,
  },
  sessionPath: (session) => {
    const [owner = "", name = ""] = session.owner?.key.split(":") ?? [];

    return `${owner === "team" ? teams.page : ""}${name}/${session.id}`;
  },
  Composer: PendingWakeUps,
  notices: { wakeup: WakeUpNotice, routine: RoutineNotice },
};

function Page({ context, path }: PageProps): ReactElement {
  const scope = path.startsWith(teams.page) ? teams : yours;
  const [name = "", sessionId] = path.slice(scope.page.length).split("/");

  if (name === "") {
    return <RoutineList context={context} />;
  }

  if (sessionId !== undefined) {
    return (
      <RunSession
        context={context}
        scope={scope}
        name={name}
        sessionId={sessionId}
      />
    );
  }

  return (
    <RoutinePage
      key={`${scope.page}${name}`}
      context={context}
      scope={scope}
      name={name}
    />
  );
}

function RoutineList({
  context,
}: {
  readonly context: WebContext;
}): ReactElement {
  const team =
    useLoaded(
      async () =>
        json<unknown[]>(context.request("/api/environments?owner=team")),
      "team-environments",
      { topics: ["environments"] },
    ).value ?? [];

  return (
    <>
      <PageTitle description="A routine runs a prompt on a schedule, each time in a new Session of its own, or as a message to one of your Sessions. Ask the assistant to make one, or write its JSON here.">
        Routines
      </PageTitle>
      <div className="flex flex-wrap gap-2">
        <a href={context.href("new")} className="inline-flex">
          <Button variant="primary" tabIndex={-1}>
            New routine
          </Button>
        </a>
        {team.length > 0 && (
          <a href={context.href(`${teams.page}new`)} className="inline-flex">
            <Button tabIndex={-1}>New team routine</Button>
          </a>
        )}
      </div>
      <Routines context={context} scope={yours} title="Yours" />
      {team.length > 0 && (
        <Routines context={context} scope={teams} title="The team's" />
      )}
    </>
  );
}

function Routines({
  context,
  scope,
  title,
}: {
  readonly context: WebContext;
  readonly scope: Scope;
  readonly title: string;
}): ReactElement {
  const list = useLoaded(
    async () => json<RoutineView[]>(context.request(scope.api)),
    scope.api,
    watched,
  ).value;

  return (
    <Section title={title}>
      {list?.length === 0 && <p className="text-fg-dim">No routines yet.</p>}
      <ul className="flex flex-col gap-2">
        {list?.map((routine) => (
          <li key={routine.name}>
            <a
              href={context.href(`${scope.page}${routine.name}`)}
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

function startText(index: number): string {
  return `${JSON.stringify(starters[index]?.routine ?? {}, null, 2)}\n`;
}

function RoutinePage({
  context,
  scope,
  name,
}: {
  readonly context: WebContext;
  readonly scope: Scope;
  readonly name: string;
}): ReactElement {
  const [ask, asking] = useConfirm();
  const creating = name === "new";
  const [editing, setEditing] = useState(creating);
  const [failure, setFailure] = useState<string>();

  const { value: routine, reload } = useLoaded(
    async () =>
      creating
        ? undefined
        : json<RoutineDetail>(context.request(`${scope.api}/${name}`)),
    name,
    watched,
  );

  const act = (action: string, method = "POST"): void => {
    setFailure(undefined);

    ok(context.request(`${scope.api}/${name}/${action}`, { method })).then(
      reload,
      (error: unknown) => {
        setFailure(String(error instanceof Error ? error.message : error));
      },
    );
  };

  return (
    <>
      {asking}
      <PageTitle
        description={
          <a href={context.href("")} className="hover:underline">
            All routines
          </a>
        }
      >
        {creating
          ? `New ${scope === teams ? "team " : ""}routine`
          : (routine?.title ?? name)}
      </PageTitle>
      {routine !== undefined && (
        <div className="flex flex-col gap-3">
          <p className="text-ui text-fg-dim">{summaryOf(routine)}</p>
          {routine.error !== undefined && (
            <p className="text-ui text-failed">{routine.error}</p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              disabled={routine.error !== undefined}
              onClick={() => {
                act("run");
              }}
            >
              Run now
            </Button>
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

                  await ok(
                    context.request(`${scope.api}/${name}`, {
                      method: "DELETE",
                    }),
                  );

                  location.hash = context.href("");
                });
              }}
            >
              Delete
            </Button>
          </div>
        </div>
      )}
      {failure !== undefined && (
        <p className="mt-3 text-ui text-failed">{failure}</p>
      )}
      {routine?.webhook !== undefined && <Webhook {...routine.webhook} />}
      {editing && (creating || routine !== undefined) && (
        <Editor
          context={context}
          scope={scope}
          name={creating ? undefined : name}
          text={routine?.file ?? startText(0)}
          onSaved={(saved) => {
            setEditing(false);

            if (creating) {
              location.hash = context.href(`${scope.page}${saved}`);
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
                href={context.href(
                  `${scope.page}${name}/${run.sessionId ?? ""}`,
                )}
                run={run}
              />
            ))}
          </ul>
        </Section>
      )}
    </>
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
        GitHub signs webhooks.
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
  context,
  scope,
  name,
  text: initial,
  onSaved,
}: {
  readonly context: WebContext;
  readonly scope: Scope;
  readonly name: string | undefined;
  readonly text: string;
  readonly onSaved: (name: string) => void;
}): ReactElement {
  const [text, setText] = useState(initial);
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

    ok(
      context.request(`${scope.api}/${encodeURIComponent(target)}`, {
        method: "PUT",
        body: JSON.stringify(value),
      }),
    ).then(
      () => {
        onSaved(target);
      },
      (error: unknown) => {
        setFailure(String(error instanceof Error ? error.message : error));
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
        <input
          aria-label="Name"
          placeholder="name, such as daily-issues"
          value={newName}
          onChange={(event) => {
            setNewName(event.target.value);
          }}
          className={fieldClass}
        />
      )}
      <textarea
        aria-label="Routine JSON"
        rows={14}
        spellCheck={false}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
        }}
        className={`${fieldClass} h-auto py-2 font-mono text-label`}
      />
      {failure !== undefined && (
        <p className="text-ui text-failed">{failure}</p>
      )}
      <DeclaredEvents context={context} />
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
  context,
}: {
  readonly context: WebContext;
}): ReactElement | null {
  const events = useLoaded(
    async () => json<DeclaredEvent[]>(context.request("events")),
    "events",
  ).value;

  if (events === undefined || events.length === 0) {
    return null;
  }

  return (
    <details className="text-label text-fg-dim">
      <summary className="cursor-pointer">
        Events a trigger can name, as{" "}
        {'{ "event": type, "filter": { field: value } }'}
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

function fieldNames(schema: Readonly<Record<string, unknown>>): string[] {
  const properties = schema["properties"];

  return typeof properties === "object" && properties !== null
    ? Object.keys(properties)
    : [];
}

function RunRow({
  href,
  run,
}: {
  readonly href: string;
  readonly run: Run;
}): ReactElement {
  const label = (
    <>
      <OutcomeBadge outcome={run.outcome} />
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
      {run.sessionId === null ? (
        <span className="flex min-w-0 items-center gap-2 px-2 py-1">
          {label}
        </span>
      ) : (
        <a
          href={href}
          className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1 hover:bg-hover"
        >
          {label}
        </a>
      )}
    </li>
  );
}

function RunSession({
  context,
  scope,
  name,
  sessionId,
}: {
  readonly context: WebContext;
  readonly scope: Scope;
  readonly name: string;
  readonly sessionId: string;
}): ReactElement {
  const { SessionView } = context;

  return (
    <SessionView
      sessionId={sessionId}
      layout="full"
      crumb={
        <>
          <a
            href={context.href(`${scope.page}${name}`)}
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

const outcomes: Readonly<
  Record<RunOutcome, { readonly state: BadgeState; readonly label: string }>
> = {
  running: { state: "working", label: "Running" },
  queued: { state: "waiting", label: "Queued" },
  ok: { state: "done", label: "Done" },
  nothing: { state: "offline", label: "Nothing to do" },
  stopped: { state: "offline", label: "Stopped" },
  failed: { state: "failed", label: "Failed" },
  skipped: { state: "offline", label: "Skipped" },
  blocked: { state: "failed", label: "Blocked" },
};

function OutcomeBadge({
  outcome,
}: {
  readonly outcome: RunOutcome;
}): ReactElement {
  const { state, label } = outcomes[outcome];

  return <Badge state={state}>{label}</Badge>;
}

function summaryOf(routine: RoutineView): string {
  if (routine.error !== undefined) {
    return "Doesn't load";
  }

  if (routine.paused !== null) {
    return routine.paused;
  }

  return routine.nextAt === null
    ? "Nothing scheduled"
    : `Next run ${new Date(routine.nextAt).toLocaleString()}`;
}

function PendingWakeUps({
  context,
  session,
}: SessionPartProps): ReactElement | null {
  const { value, reload } = useLoaded(
    async () =>
      json<readonly WakeUp[]>(
        context.request(`wakeups?session=${encodeURIComponent(session.id)}`),
      ),
    session.id,
    { topics: ["routines.wakeups"] },
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
            className="h-6 px-2"
            aria-label={`Cancel wake-up: ${wakeUp.reason}`}
            onClick={() => {
              void ok(
                context.request(`wakeups/${wakeUp.id}`, { method: "DELETE" }),
              ).finally(reload);
            }}
          >
            Cancel
          </Button>
        </li>
      ))}
    </ul>
  );
}

function WakeUpNotice({ data }: NoticeProps): ReactElement {
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

function RoutineNotice({ data, text }: NoticeProps): ReactElement {
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
