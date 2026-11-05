import type { SessionEvent } from "@pipoca/protocol";
import {
  type ChildState,
  type ChildView,
  finishedKind,
  manages,
  missionRecordType,
  missionsKey,
  type MissionView,
  openDecisions,
  recordType,
  type Review,
  type RunView,
  runsKey,
  runState,
  type Started,
  watchdogKind,
} from "../src/format";

export {
  type ChildView,
  manages,
  missionsKey,
  type MissionView,
  openDecisions,
  type Review,
  runsKey,
  type RunView,
  runState,
  type Started,
  watchdogKind,
};

export type Tone = "running" | "done" | "failed" | "stopped";

// A run as the notice that brought its outputs to the parent recorded it.
export function finishedRun(event: SessionEvent): RunView | undefined {
  if (event.type !== "entry" || !event.entry.includes(`"${finishedKind}"`)) {
    return undefined;
  }

  let entry: {
    readonly type?: string;
    readonly details?: {
      readonly plugin?: unknown;
      readonly kind?: unknown;
      readonly data?: RunView;
    };
  };

  try {
    entry = JSON.parse(event.entry) as typeof entry;
  } catch {
    return undefined;
  }

  const { details } = entry;

  return entry.type === "custom_message" &&
    details?.plugin === "subagents" &&
    details.kind === finishedKind
    ? details.data
    : undefined;
}

// A run as the transcript last recorded it (ADR 0058).
export function recordedRun(event: SessionEvent): RunView | undefined {
  if (event.type !== "entry" || !event.entry.includes(`"${recordType}"`)) {
    return undefined;
  }

  try {
    const entry = JSON.parse(event.entry) as {
      readonly type?: string;
      readonly customType?: string;
      readonly data?: RunView;
    };

    return entry.type === "custom" && entry.customType === recordType
      ? entry.data
      : undefined;
  } catch {
    return undefined;
  }
}

// A mission as the transcript last recorded it.
export function recordedMission(event: SessionEvent): MissionView | undefined {
  if (
    event.type !== "entry" ||
    !event.entry.includes(`"${missionRecordType}"`)
  ) {
    return undefined;
  }

  try {
    const entry = JSON.parse(event.entry) as {
      readonly type?: string;
      readonly customType?: string;
      readonly data?: MissionView;
    };

    return entry.type === "custom" && entry.customType === missionRecordType
      ? entry.data
      : undefined;
  } catch {
    return undefined;
  }
}

export function runIdOf(details: unknown): string | undefined {
  if (typeof details !== "object" || details === null) {
    return undefined;
  }

  const { runId } = details as { readonly runId?: unknown };

  return typeof runId === "string" ? runId : undefined;
}

export function toneOf(state: ChildState): Tone {
  if (state === "queued") {
    return "running";
  }

  return state === "interrupted" ? "stopped" : state;
}

export function stateLabel(state: ChildState): string {
  return state.charAt(0).toUpperCase() + state.slice(1);
}

export function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) {
    return `${String(seconds)}s`;
  }

  const minutes = Math.floor(seconds / 60);

  return `${String(minutes)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

// How long a child has run, or ran, at now.
export function took(child: ChildView, now: number): number | undefined {
  return child.startedAt === undefined
    ? undefined
    : (child.endedAt ?? now) - child.startedAt;
}

export function running(runs: readonly RunView[]): number {
  return runs.filter((run) => run.endedAt === undefined).length;
}

// A child's last reply is usually its output, already in its activity.
export function separateOutput(child: ChildView): string {
  if (child.error !== undefined) {
    return child.error;
  }

  const output = child.output ?? "";

  const said = child.activity.some(
    ({ kind, text }) => kind === "text" && text === output,
  );

  return said ? "" : output;
}
