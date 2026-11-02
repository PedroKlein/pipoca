// What the session part publishes about runs and writes into the transcript,
// and the web part draws (ADR 0057).

export type ChildState = "queued" | "running" | "done" | "failed" | "stopped";

export type Shape = "single" | "parallel" | "chain";

// One line of what a child did: something it said, or a tool it called.
export interface Activity {
  readonly kind: "text" | "tool";
  readonly text: string;
  readonly failed?: boolean;
}

export interface ChildView {
  readonly agent: string;
  readonly task: string;
  readonly state: ChildState;
  readonly model?: string;
  readonly startedAt?: number;
  readonly endedAt?: number;
  // The tool it is running now.
  readonly tool?: string;
  readonly toolCount: number;
  // The latest of what it did, oldest first.
  readonly activity: readonly Activity[];
  readonly output?: string;
  readonly error?: string;
}

export interface RunView {
  readonly id: string;
  readonly shape: Shape;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly children: readonly ChildView[];
}

// The plugin data key that holds every run of the Session.
export const runsKey = "runs";

// The notice kind that brings a finished run's outputs to the parent.
export const finishedKind = "finished";

// A tool result's details for a call that started a run.
export interface Started {
  readonly runId: string;
}

export function runState(run: RunView): ChildState {
  const states = run.children.map(({ state }) => state);

  for (const state of ["running", "queued", "failed", "stopped"] as const) {
    if (states.includes(state)) {
      return state;
    }
  }

  return "done";
}

// A call that names a task starts runs, whatever action a model also fills in.
export function manages(args: object): boolean {
  return (
    "action" in args &&
    !("task" in args) &&
    !("tasks" in args) &&
    !("chain" in args)
  );
}
