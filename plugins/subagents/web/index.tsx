import {
  defineWeb,
  type MountedSession,
  type ToolCall,
  useNow,
  useSessionState,
  useToolResults,
} from "@pipoca/plugins/web";
import type { SessionEvent } from "@pipoca/protocol";
import {
  Button,
  Card,
  cardClass,
  cn,
  Code,
  Icon,
  isComposing,
  StatusMark,
} from "@pipoca/ui";
import { type ReactElement, useEffect, useMemo, useState } from "react";
import { about } from "../about";
import {
  type ChildView,
  elapsed,
  finishedRun,
  manages,
  type MissionView,
  missionsKey,
  openDecisions,
  recordedMission,
  recordedRun,
  type Review,
  runIdOf,
  running,
  runsKey,
  runState,
  type RunView,
  separateOutput,
  type Started,
  stateLabel,
  type Tone,
  toneOf,
  took,
  watchdogKind,
} from "./runs";

// Subagent runs as cards in the chat, and a fleet panel from the header
// (ADR 0030, ADR 0057).
export default defineWeb(about, {
  slots: {
    "session.toolCall:subagent": SubagentCall,
    "session.header": FleetButton,
    "notice:finished": FinishedNotice,
    "notice:interrupted": InterruptedNotice,
    [`notice:${watchdogKind}`]: WatchdogNotice,
    "notice:decided": DecidedNotice,
  },
});

interface NoticeData {
  readonly data: unknown;
}

// The latest of every run: as the call that started it returned, as the
// transcript recorded it, and as the Session part last published them.
function useRuns(session: MountedSession): ReadonlyMap<string, RunView> {
  const called = useToolResults<Partial<Started>>(session, "subagent");
  const published = useSessionState<readonly RunView[]>(session, runsKey);
  const kept = useKept(session, keptRun);

  return useMemo(
    () =>
      new Map([
        ...called.flatMap(({ details: { run } }) =>
          run === undefined ? [] : [[run.id, run] as const],
        ),
        ...kept,
        ...(published ?? []).map((run) => [run.id, run] as const),
      ]),
    [called, kept, published],
  );
}

// The latest of every mission, as the transcript recorded it and as the
// Session part last published them.
function useMissions(session: MountedSession): readonly MissionView[] {
  const published = useSessionState<readonly MissionView[]>(
    session,
    missionsKey,
  );

  const kept = useKept(session, recordedMission);

  return useMemo(
    () =>
      [
        ...new Map([
          ...kept,
          ...(published ?? []).map((mission) => [mission.id, mission] as const),
        ]).values(),
      ].reverse(),
    [kept, published],
  );
}

// What the transcript last recorded of each run or mission, by its id.
function useKept<T extends { readonly id: string }>(
  session: MountedSession,
  read: (event: SessionEvent) => T | undefined,
): ReadonlyMap<string, T> {
  const [kept, setKept] = useState<{
    readonly session: MountedSession;
    readonly records: ReadonlyMap<string, T>;
  }>();

  useEffect(
    () =>
      session.events((event) => {
        const record = read(event);

        if (record !== undefined) {
          setKept((seen) => ({
            session,
            records: new Map(seen?.session === session ? seen.records : []).set(
              record.id,
              record,
            ),
          }));
        }
      }),
    [session, read],
  );

  return kept?.session === session ? kept.records : none;
}

const none: ReadonlyMap<never, never> = new Map<never, never>();

function keptRun(event: SessionEvent): RunView | undefined {
  return recordedRun(event) ?? finishedRun(event);
}

function SubagentCall({
  call,
  session,
}: {
  readonly call: ToolCall;
  readonly session: MountedSession;
}): ReactElement {
  const runs = useRuns(session);
  const runId = runIdOf(call.result?.details);
  const run = runId === undefined ? undefined : runs.get(runId);

  if (manages(call.args as object)) {
    return <ManageRow call={call} />;
  }

  return (
    <Card
      padding="none"
      data-subagent-run={runId}
      data-subagent-tone={run ? toneOf(runState(run)) : call.status}
      className="overflow-hidden"
    >
      {run ? <Run run={run} session={session} /> : <Pending call={call} />}
    </Card>
  );
}

// Before the run shows, or when it failed to start, the call is all there is.
function Pending({ call }: { readonly call: ToolCall }): ReactElement {
  const { agent, task } = call.args as {
    readonly agent?: unknown;
    readonly task?: unknown;
  };

  const tone: Tone = call.status;

  return (
    <div className="flex flex-col gap-1 px-3 py-2 text-label">
      <span className="flex min-w-0 items-center gap-2">
        <Mark tone={tone} />
        <span className="shrink-0 font-medium text-fg">
          {typeof agent === "string" ? agent : "Subagents"}
        </span>
        <span className="min-w-0 flex-1 truncate text-fg-dim">
          {typeof task === "string" ? task.split("\n")[0] : ""}
        </span>
      </span>
      {call.status === "failed" && (
        <Output text={call.result?.text ?? ""} failed />
      )}
    </div>
  );
}

function Run({
  run,
  session,
}: {
  readonly run: RunView;
  readonly session: MountedSession;
}): ReactElement {
  const live = run.endedAt === undefined;
  const now = useNow(live ? 1000 : 30_000);

  return (
    <div className="flex flex-col">
      {run.shape !== "single" && (
        <div className="border-b border-line px-3 py-1.5 text-label text-fg-dim">
          {shapeLabel(run)} · {stateLabel(runState(run))}
        </div>
      )}
      {run.children.map((child, index) => (
        <Child key={index} child={child} now={now} />
      ))}
      {live && <Controls runId={run.id} session={session} />}
      {!live && (run.output !== undefined || run.error !== undefined) && (
        <div className="border-t border-line px-3 py-2">
          <Output
            text={run.error ?? run.output ?? ""}
            failed={run.error !== undefined}
          />
        </div>
      )}
      {!live && runState(run) === "interrupted" && (
        <div className="flex items-center gap-2 border-t border-line px-3 py-2">
          <span className="min-w-0 flex-1 text-label text-fg-dim">
            A restart cut this run off.
          </span>
          <Button
            variant="ghost"
            onClick={() => {
              void session.send(`/subagent-resume ${run.id}`);
            }}
          >
            Resume
          </Button>
        </div>
      )}
    </div>
  );
}

function Child({
  child,
  now,
}: {
  readonly child: ChildView;
  readonly now: number;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const tone = toneOf(child.state);
  const time = took(child, now);

  const facts = [
    stateLabel(child.state),
    ...(child.toolCount > 0
      ? [
          `${String(child.toolCount)} ${child.toolCount === 1 ? "tool" : "tools"}`,
        ]
      : []),
    ...(time === undefined ? [] : [elapsed(time)]),
  ];

  const detail = [
    child.model,
    child.tool === undefined ? undefined : `running ${child.tool}`,
  ].filter((part) => part !== undefined);

  return (
    <section className="border-b border-line last:border-b-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
        }}
        className="flex w-full min-w-0 flex-col gap-0.5 px-3 py-2 text-left hover:bg-hover"
      >
        <span className="flex w-full min-w-0 items-center gap-2 text-label">
          <Mark tone={tone} />
          <span className="shrink-0 font-medium text-fg">
            {child.key ?? child.agent}
          </span>
          <span className="min-w-0 flex-1 truncate text-fg-dim">
            {child.task.split("\n")[0]}
          </span>
          <span className="shrink-0 text-fg-dim">{facts.join(" · ")}</span>
          <Icon
            name="chevron-right"
            className={cn(
              "size-3.5 shrink-0 text-fg-dim transition-transform",
              open && "rotate-90",
            )}
          />
        </span>
        {detail.length > 0 && (
          <span className="truncate pl-6 font-mono text-mono-sm text-fg-dim">
            {detail.join(" · ")}
          </span>
        )}
      </button>
      {open && (
        <div className="flex flex-col gap-1.5 border-t border-line px-3 py-2">
          {child.activity.map((line, at) => (
            <p
              key={at}
              className={cn(
                "min-w-0 font-mono text-mono-sm break-words whitespace-pre-wrap",
                line.kind === "text" ? "text-fg" : "text-fg-dim",
                line.failed === true && "text-failed",
              )}
            >
              {line.kind === "tool" ? `› ${line.text}` : line.text}
            </p>
          ))}
          {child.activity.length === 0 && child.state === "queued" && (
            <p className="text-label text-fg-dim">Waiting for a free slot.</p>
          )}
          <Output
            text={separateOutput(child)}
            failed={child.state === "failed"}
          />
        </div>
      )}
    </section>
  );
}

// Steer tells the run's running agents something; Stop ends the run.
function Controls({
  runId,
  session,
}: {
  readonly runId: string;
  readonly session: MountedSession;
}): ReactElement {
  const [text, setText] = useState("");

  const steer = (): void => {
    const message = text.trim();
    if (message === "") {
      return;
    }

    setText("");
    void session.send(`/subagent-steer ${runId} ${message}`);
  };

  return (
    <div className="flex items-center gap-2 border-t border-line px-3 py-2">
      <input
        value={text}
        aria-label="Tell the subagents"
        placeholder="Tell the subagents…"
        onChange={(event) => {
          setText(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !isComposing(event)) {
            event.preventDefault();
            steer();
          }
        }}
        className="min-w-0 flex-1 rounded-md border border-line bg-panel px-2 py-1 text-label text-fg placeholder:text-fg-dim"
      />
      <Button variant="ghost" onClick={steer} disabled={text.trim() === ""}>
        Steer
      </Button>
      <Button
        variant="ghost"
        onClick={() => {
          void session.send(`/subagent-stop ${runId}`);
        }}
      >
        <Icon name="stop" className="size-3.5" />
        Stop
      </Button>
    </div>
  );
}

function Output({
  text,
  failed,
}: {
  readonly text: string;
  readonly failed: boolean;
}): ReactElement | null {
  if (text === "") {
    return null;
  }

  return (
    <Code wrap failed={failed} className="max-h-80 overflow-auto">
      {text}
    </Code>
  );
}

// A call that manages runs, such as status or stop, reads like a work step.
function ManageRow({ call }: { readonly call: ToolCall }): ReactElement {
  const { action } = call.args as { readonly action?: unknown };

  const tone: Tone = call.status;

  return (
    <details className="group/step">
      <summary className="flex min-w-0 cursor-pointer list-none items-center gap-2 rounded-md px-2 py-1 text-label hover:bg-hover [&::-webkit-details-marker]:hidden">
        <Mark tone={tone} />
        <span className="shrink-0 font-medium text-fg">Subagents</span>
        <span className="truncate font-mono text-mono-sm text-fg-dim">
          {typeof action === "string" ? action : ""}
        </span>
      </summary>
      <div className="mx-2 mt-1 mb-2">
        <Output text={call.result?.text ?? ""} failed={tone === "failed"} />
      </div>
    </details>
  );
}

function Mark({ tone }: { readonly tone: Tone }): ReactElement {
  return <StatusMark status={tone} label="" />;
}

// The header's Subagents button opens every run of the Session in a side
// panel, once there is one.
function FleetButton({
  session,
}: {
  readonly session: MountedSession;
}): ReactElement | null {
  const [open, setOpen] = useState(false);

  const runs = [...useRuns(session).values()].sort(
    (one, other) => other.startedAt - one.startedAt,
  );

  const missions = useMissions(session);
  const asking = openDecisions(missions).length;
  const count = running(runs);

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const close = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };

    document.addEventListener("keydown", close);

    return () => {
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  if (runs.length === 0 && missions.length === 0) {
    return null;
  }

  return (
    <>
      <Button
        variant="ghost"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
        }}
      >
        {count > 0 ? (
          <span className="size-1.5 animate-pulse rounded-full bg-working" />
        ) : (
          <Icon name="git-fork" className="size-3.5" />
        )}
        {count > 0 ? `${String(count)} running` : "Subagents"}
        {asking > 0 && (
          <span className="rounded-full bg-waiting px-1.5 text-label text-fg-strong">
            {asking} to decide
          </span>
        )}
      </Button>
      <section
        role="dialog"
        aria-label="Subagents"
        hidden={!open}
        className="fixed inset-y-0 right-0 z-40 flex w-[min(640px,100vw)] flex-col border-l border-line bg-panel text-ui text-fg shadow-pop"
      >
        <header className="flex min-h-14 items-center gap-2 border-b border-line px-4">
          <h2 className="flex-1 font-semibold text-fg-strong">Subagents</h2>
          <Button
            variant="ghost"
            iconOnly
            aria-label="Close subagents"
            onClick={() => {
              setOpen(false);
            }}
          >
            <Icon name="x" />
          </Button>
        </header>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-4">
          {missions.map((mission) => (
            <Mission key={mission.id} mission={mission} session={session} />
          ))}
          {runs.map((run) => (
            <Card padding="none" key={run.id} className="overflow-hidden">
              <Run run={run} session={session} />
            </Card>
          ))}
        </div>
      </section>
    </>
  );
}

// The message that wakes the parent with a finished run's outputs.
function FinishedNotice({ data }: NoticeData): ReactElement {
  const run = data as RunView;

  return (
    <span className="text-label text-fg-dim">
      Subagents finished:{" "}
      {run.children.map(({ agent, state }) => `${agent} ${state}`).join(", ")}
    </span>
  );
}

// The message that tells the parent which runs a restart cut off.
function InterruptedNotice({ data }: NoticeData): ReactElement {
  const cutOff = data as readonly RunView[];

  return (
    <span className="text-label text-fg-dim">
      A restart cut off{" "}
      {cutOff.length === 1
        ? "a subagent run"
        : `${String(cutOff.length)} subagent runs`}
    </span>
  );
}

// A watchdog review of a turn's changes. Only its high findings reached the
// agent (ADR 0058).
function WatchdogNotice({ data }: NoticeData): ReactElement {
  const review = data as Review;

  if (review.error !== undefined) {
    return (
      <span className="text-label text-fg-dim">
        The watchdog couldn't review this turn: {review.error}
      </span>
    );
  }

  return (
    <div className="flex flex-col gap-1 px-2 py-1 text-label">
      <span className="text-fg-dim">
        {review.stuck === true
          ? "The watchdog keeps finding this, so it stopped sending it to the agent"
          : "The watchdog reviewed this turn's changes"}
      </span>
      {review.findings.map((finding, at) => (
        <details key={at} className="rounded-md border border-line px-2 py-1">
          <summary className="cursor-pointer">
            <span
              className={cn(
                "mr-2 text-mono-sm",
                finding.importance === "high" ? "text-failed" : "text-fg-dim",
              )}
            >
              {finding.importance}
            </span>
            {finding.summary}
          </summary>
          {finding.evidence !== "" && (
            <p className="mt-1 whitespace-pre-wrap text-fg-dim">
              {finding.evidence}
            </p>
          )}
          {finding.action !== "" && (
            <p className="mt-1 whitespace-pre-wrap">{finding.action}</p>
          )}
        </details>
      ))}
    </div>
  );
}

function shapeLabel(run: RunView): string {
  if (run.shape === "workflow") {
    return `Workflow${run.workflow?.name === undefined ? "" : ` ${run.workflow.name}`}`;
  }

  return run.shape === "chain" ? "Chain" : "Parallel";
}

// A mission with its decisions, receipts and runs (ADR 0058).
function Mission({
  mission,
  session,
}: {
  readonly mission: MissionView;
  readonly session: MountedSession;
}): ReactElement {
  const closed = mission.closedAt !== undefined;

  return (
    <section
      aria-label={`Mission ${mission.title}`}
      className={cn(cardClass, "flex flex-col gap-2 px-3 py-2")}
    >
      <div className="flex items-center gap-2">
        <Icon name="pin" className="size-3.5 shrink-0 text-fg-dim" />
        <h3 className="min-w-0 flex-1 truncate font-medium text-fg-strong">
          {mission.title}
        </h3>
        <span className="shrink-0 text-label text-fg-dim">
          {closed ? "Closed" : "Open"} ·{" "}
          {mission.runIds.length === 1
            ? "1 run"
            : `${String(mission.runIds.length)} runs`}
        </span>
      </div>
      <p className="text-label whitespace-pre-wrap text-fg-dim">
        {mission.summary ?? mission.objective}
      </p>
      {mission.decisions.map((decision) => (
        <div key={decision.id} className="flex flex-col gap-1 text-label">
          <span className="text-fg">{decision.question}</span>
          {decision.answer === undefined ? (
            !closed && (
              <Decide
                options={decision.options}
                decide={(answer) => {
                  void session.send(
                    `/mission-decide ${mission.id} ${decision.id} ${answer}`,
                  );
                }}
              />
            )
          ) : (
            <span className="text-fg-dim">Decided: {decision.answer}</span>
          )}
        </div>
      ))}
      {mission.receipts.map(({ label, url }) => (
        <a
          key={url}
          href={url}
          target="_blank"
          rel="noreferrer"
          className="truncate text-label text-fg underline"
        >
          {label}
        </a>
      ))}
    </section>
  );
}

function Decide({
  options,
  decide,
}: {
  readonly options: readonly string[];
  readonly decide: (answer: string) => void;
}): ReactElement {
  const [text, setText] = useState("");

  return (
    <div className="flex flex-wrap items-center gap-2">
      {options.map((option) => (
        <Button
          key={option}
          variant="ghost"
          onClick={() => {
            decide(option);
          }}
        >
          {option}
        </Button>
      ))}
      <form
        className="flex min-w-40 flex-1 gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (text.trim() !== "") {
            decide(text.trim());
          }
        }}
      >
        <input
          aria-label="Your answer"
          value={text}
          placeholder={
            options.length === 0 ? "Your answer" : "Or say something else"
          }
          onChange={(event) => {
            setText(event.target.value);
          }}
          className="min-w-0 flex-1 rounded-md border border-line bg-panel px-2 py-1 text-label"
        />
      </form>
    </div>
  );
}

// The message that brings the person's decision to the agent.
function DecidedNotice({ data }: NoticeData): ReactElement {
  const { decision } = data as {
    readonly decision: { readonly question: string; readonly answer?: string };
  };

  return (
    <span className="text-label text-fg-dim">
      You decided: {decision.answer} ({decision.question})
    </span>
  );
}
