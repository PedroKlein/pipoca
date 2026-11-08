import type { Group } from "./group";
import type { Routine } from "./routine";

export interface WakeUp {
  readonly id: string;
  readonly sessionId: string;
  readonly dueAt: string;
  readonly reason: string;
  readonly message: string;
}

export type RunOutcome =
  | "running"
  // Its turn ended with a question open, and it waits for the answer
  // (ADR 0076).
  | "waiting"
  | "queued"
  | "ok"
  | "nothing"
  | "failed"
  | "skipped"
  | "blocked"
  // The run's turn ended without it saying it finished (ADR 0061).
  | "stopped";

// How a run's agent ends it.
export type RunResult = "done" | "nothing" | "blocked";

// Where a proposal stands (ADR 0076): proposed until the run's turn ends,
// then applied, failed, or waiting for a person who approves or rejects it.
// A dry run's are shown and never applied, and refused ones break the
// routine's rules.
export type ProposalState =
  | "proposed"
  | "waiting"
  | "applied"
  | "failed"
  | "rejected"
  | "refused"
  | "shown";

export interface Proposal {
  readonly id: string;
  // The plugin's action, such as git-hosts.comment, and its title.
  readonly action: string;
  readonly title: string;
  readonly input: unknown;
  readonly state: ProposalState;
  // What applying it wrote, or why it failed or was refused.
  readonly result: string | null;
  readonly url: string | null;
  readonly proposedAt: string;
}

// A question a waiting run asked.
export interface RunQuestion {
  readonly id: string;
  readonly prompts: readonly string[];
  readonly closesAt: string;
}

// A change to a routine, by the name of who saved it.
export interface Change {
  readonly by: string | null;
  readonly change: "created" | "changed";
  readonly at: string;
}

// Where a run's result went (ADR 0075): what the destination wrote, or why
// it failed.
export interface Delivered {
  readonly destination: string;
  readonly state: "sent" | "failed";
  readonly text: string;
  readonly url?: string;
}

// How a trigger's check went when it last ran, or a watch's fetch.
export interface TriggerNote {
  readonly trigger: number;
  readonly at: string;
  readonly passed?: boolean;
  readonly error?: string;
}

export interface Run {
  readonly id: string;
  // Which retry of a failed run it is, from 1.
  readonly attempt?: number;
  readonly firedAt: string;
  // What fired it: schedule or by hand.
  readonly cause: string;
  readonly sessionId: string | null;
  readonly outcome: RunOutcome;
  readonly reason: string | null;
  readonly endedAt: string | null;
  // Its git couldn't push and it proposed what to write outside.
  readonly proposes?: true;
  // Its proposals were shown, never applied.
  readonly dryRun?: true;
  readonly proposals?: readonly Proposal[];
  // While it waits: its open questions, and who they are for, by name.
  readonly questions?: readonly RunQuestion[];
  readonly askedFor?: readonly string[];
  // What it ended with for the routines that follow it, and how deep in a
  // chain of runs it is when it follows another (ADR 0075).
  readonly output?: Readonly<Record<string, unknown>>;
  readonly depth?: number;
  readonly results?: readonly Delivered[];
}

export interface RoutineView {
  readonly name: string;
  readonly title: string;
  // The group it is in, by name.
  readonly group?: string;
  // Why the routine's file doesn't load.
  readonly error?: string;
  readonly paused: string | null;
  // When the pause ends by itself, such as the day after the spend cap.
  readonly pausedUntil: string | null;
  readonly nextAt: string | null;
  readonly lastRun: Run | null;
  // The fields its runs' output has, when it declares them.
  readonly output?: readonly string[];
}

export interface RoutineDetail extends RoutineView {
  // The routine's JSON file as it is on disk.
  readonly file: string;
  // The routine the file holds, in the shape saving writes.
  readonly routine?: Routine;
  readonly runs: readonly Run[];
  // Who made it and changed it last, by name, when Pipoca saw them save it,
  // and every change, newest first.
  readonly createdBy: string | null;
  readonly changedBy: string | null;
  readonly history: readonly Change[];
  // What its runs spent today, in the currency of the server's prices.
  readonly spentToday: number;
  // The owner's routines whose ended runs start it, and the ones its ended
  // runs start, by name (ADR 0075).
  readonly fedBy: readonly string[];
  readonly feeds: readonly string[];
  // Where a webhook trigger takes deliveries, signed with the secret as
  // sha256=<HMAC-SHA256 of the body in hex>.
  readonly webhook?: { readonly path: string; readonly secret: string };
  // How its triggers' checks went last, and its watches' last fetches.
  readonly checks?: readonly TriggerNote[];
  readonly watches?: readonly TriggerNote[];
}

export interface GroupView {
  readonly name: string;
  readonly title: string;
  // Why its group.json doesn't load.
  readonly error?: string;
  // Why it is paused, such as at its daily budget, and until when.
  readonly paused: string | null;
  readonly pausedUntil: string | null;
  // What its routines' runs spent today.
  readonly spentToday: number;
}

// A piece of work of one of the group's routines, with its newest runs.
export interface WorkItem {
  readonly routine: string;
  readonly title: string;
  readonly key: string;
  readonly runs: readonly Run[];
}

export interface RoutineCost {
  readonly name: string;
  readonly title: string;
  readonly spentToday: number;
  readonly runs: number;
  readonly succeeded: number;
  readonly failed: number;
  // Of the runs that ended done or not, how many were done, or null.
  readonly successRate: number | null;
}

// A group's board (ADR 0075).
export interface GroupDetail extends GroupView {
  // Its group.json as it is on disk, and the group it holds.
  readonly file: string;
  readonly group?: Group;
  readonly routines: readonly RoutineView[];
  readonly work: readonly WorkItem[];
  readonly waiting: readonly {
    readonly routine: string;
    readonly run: Run;
  }[];
  readonly costs: readonly RoutineCost[];
  readonly succeeded: number;
  readonly failed: number;
  readonly successRate: number | null;
  // Its memory's files by name.
  readonly memory: Readonly<Record<string, string>>;
}

// What importing a group made: its routines, the agent and workflow files
// it added to the Profile, and the ones the Profile had already.
export interface Imported {
  readonly name: string;
  readonly routines: readonly string[];
  readonly added: readonly string[];
  readonly kept: readonly string[];
}

// A routine Pipoca drafted from one sentence, for the person to change and
// save (ADR 0075). A drafted routine that doesn't fit says why in error.
export interface RoutineDraft {
  readonly id: string;
  readonly sentence: string;
  readonly state: "drafting" | "ready" | "failed";
  readonly sessionId: string | null;
  readonly name?: string | undefined;
  readonly routine?: unknown;
  readonly summary?: string | undefined;
  readonly error?: string | undefined;
}
