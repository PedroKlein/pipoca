export interface WakeUp {
  readonly id: string;
  readonly sessionId: string;
  readonly dueAt: string;
  readonly reason: string;
  readonly message: string;
}

export type RunOutcome =
  "running" | "queued" | "ok" | "nothing" | "failed" | "skipped" | "blocked";

export interface Run {
  readonly id: string;
  readonly firedAt: string;
  // What fired it: schedule or by hand.
  readonly cause: string;
  readonly sessionId: string | null;
  readonly outcome: RunOutcome;
  readonly reason: string | null;
  readonly endedAt: string | null;
}

export interface RoutineView {
  readonly name: string;
  readonly title: string;
  // Why the routine's file doesn't load.
  readonly error?: string;
  readonly paused: string | null;
  readonly nextAt: string | null;
  readonly lastRun: Run | null;
}

export interface RoutineDetail extends RoutineView {
  // The routine's JSON file as it is on disk.
  readonly file: string;
  readonly runs: readonly Run[];
  // Where a webhook trigger takes deliveries, signed with the secret as
  // sha256=<HMAC-SHA256 of the body in hex>.
  readonly webhook?: { readonly path: string; readonly secret: string };
}
