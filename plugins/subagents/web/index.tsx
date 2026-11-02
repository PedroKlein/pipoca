import type {
  MountedSession,
  NoticeProps,
  SessionPartProps,
  ToolCall,
  ToolCallProps,
  WebPlugin,
} from "@pipoca/plugins/web";
import { Button, cn, Icon, isComposing } from "@pipoca/ui";
import { type ReactElement, useEffect, useState } from "react";
import {
  type ChildView,
  elapsed,
  finishedRun,
  manages,
  publishedRuns,
  recordedRun,
  runIdOf,
  running,
  runState,
  type RunView,
  separateOutput,
  stateLabel,
  type Tone,
  toneOf,
  took,
} from "./runs";

// Subagent runs as cards in the chat, and a fleet panel from the header
// (ADR 0030, ADR 0057).
export const subagents: WebPlugin = {
  name: "subagents",
  tools: { subagent: SubagentCall },
  SessionHeader: FleetButton,
  notices: { finished: FinishedNotice, interrupted: InterruptedNotice },
};

// The latest of every run: as published while the Session runs, and as the
// transcript recorded the ones that ended.
function useRuns(session: MountedSession): ReadonlyMap<string, RunView> {
  const [runs, setRuns] = useState<ReadonlyMap<string, RunView>>(new Map());

  useEffect(
    () =>
      session.events((event) => {
        const published = publishedRuns(event);
        const kept = recordedRun(event) ?? finishedRun(event);

        if (published === undefined && kept === undefined) {
          return;
        }

        setRuns((seen) => {
          const next = new Map(seen);

          for (const run of published ?? []) {
            next.set(run.id, run);
          }

          if (kept) {
            next.set(kept.id, kept);
          }

          return next;
        });
      }),
    [session],
  );

  return runs;
}

function useNow(ticking: boolean): number {
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    if (!ticking) {
      return undefined;
    }

    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);

    return () => {
      clearInterval(timer);
    };
  }, [ticking]);

  return now;
}

function SubagentCall({ call, session }: ToolCallProps): ReactElement {
  const runs = useRuns(session);
  const runId = runIdOf(call.result?.details);
  const run = runId === undefined ? undefined : runs.get(runId);

  if (manages(call.args as object)) {
    return <ManageRow call={call} />;
  }

  return (
    <div
      data-subagent-run={runId}
      data-subagent-tone={run ? toneOf(runState(run)) : call.status}
      className="overflow-hidden rounded-lg border border-line bg-elevated shadow-xs"
    >
      {run ? <Run run={run} session={session} /> : <Pending call={call} />}
    </div>
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
  const now = useNow(live);

  return (
    <div className="flex flex-col">
      {run.shape !== "single" && (
        <div className="border-b border-line px-3 py-1.5 text-label text-fg-dim">
          {run.shape === "chain" ? "Chain" : "Parallel"} ·{" "}
          {stateLabel(runState(run))}
        </div>
      )}
      {run.children.map((child, index) => (
        <Child key={index} child={child} now={now} />
      ))}
      {live && <Controls runId={run.id} session={session} />}
      {!live && run.children.some(({ state }) => state === "interrupted") && (
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
          <span className="shrink-0 font-medium text-fg">{child.agent}</span>
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
    <pre
      className={cn(
        "max-h-80 overflow-auto rounded-md border border-line bg-code px-3 py-2 font-mono text-mono-sm whitespace-pre-wrap",
        failed ? "text-failed" : "text-fg",
      )}
    >
      {text}
    </pre>
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
  switch (tone) {
    case "running":
      return (
        <span className="grid size-4 shrink-0 place-items-center">
          <span className="size-1.5 animate-pulse rounded-full bg-working" />
        </span>
      );
    case "done":
      return <Icon name="check" className="size-4 shrink-0 text-done" />;
    case "failed":
      return <Icon name="x" className="size-4 shrink-0 text-failed" />;
    case "stopped":
      return <Icon name="stop" className="size-4 shrink-0 text-fg-dim" />;
  }
}

// The header's Subagents button opens every run of the Session in a side
// panel, once there is one.
function FleetButton({ session }: SessionPartProps): ReactElement | null {
  const [open, setOpen] = useState(false);
  const runs = [...useRuns(session).values()].reverse();
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

  if (runs.length === 0) {
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
          {runs.map((run) => (
            <div
              key={run.id}
              className="overflow-hidden rounded-lg border border-line bg-elevated shadow-xs"
            >
              <Run run={run} session={session} />
            </div>
          ))}
        </div>
      </section>
    </>
  );
}

// The message that wakes the parent with a finished run's outputs.
function FinishedNotice({ data }: NoticeProps): ReactElement {
  const run = data as RunView;

  return (
    <span className="text-label text-fg-dim">
      Subagents finished:{" "}
      {run.children.map(({ agent, state }) => `${agent} ${state}`).join(", ")}
    </span>
  );
}

// The message that tells the parent which runs a restart cut off.
function InterruptedNotice({ data }: NoticeProps): ReactElement {
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
