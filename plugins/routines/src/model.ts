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
}

export interface RoutineView {
  readonly name: string;
  readonly title: string;
  // Why the routine's file doesn't load.
  readonly error?: string;
  readonly paused: string | null;
  // When the pause ends by itself, such as the day after the spend cap.
  readonly pausedUntil: string | null;
  readonly nextAt: string | null;
  readonly lastRun: Run | null;
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
  // Where a webhook trigger takes deliveries, signed with the secret as
  // sha256=<HMAC-SHA256 of the body in hex>.
  readonly webhook?: { readonly path: string; readonly secret: string };
}
