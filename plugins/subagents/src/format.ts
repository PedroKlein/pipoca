// What the session part publishes about runs and writes into the transcript,
// and the web part draws (ADR 0057).

export type ChildState =
  | "queued"
  | "running"
  | "done"
  | "failed"
  | "stopped"
  // Cut off when the Session's process stopped, and can be resumed.
  | "interrupted";

export type Shape = "single" | "parallel" | "chain" | "workflow";

// A script that starts and combines runs (ADR 0058).
export interface Workflow {
  // A saved workflow's name; an inline one has none.
  readonly name?: string;
  readonly script: string;
  readonly args?: unknown;
}

// One line of what a child did: something it said, or a tool it called.
export interface Activity {
  readonly kind: "text" | "tool";
  readonly text: string;
  readonly failed?: boolean;
}

export interface ChildView {
  // A workflow's name for the step, which finds its output again when the
  // workflow runs again.
  readonly key?: string;
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
  // The child's own Pi session file, to carry on from after an interruption.
  readonly sessionFile?: string;
}

export interface RunView {
  readonly id: string;
  readonly shape: Shape;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly children: readonly ChildView[];
  readonly workflow?: Workflow;
  // What a workflow's script returned or logged, and why it failed.
  readonly output?: string;
  readonly error?: string;
}

// The plugin data key that holds every run of the Session.
export const runsKey = "runs";

// The notice kind that brings a finished run's outputs to the parent.
export const finishedKind = "finished";

// The notice kind that says why /workflow didn't start a workflow.
export const workflowFailedKind = "workflow_failed";

// The notice kind that tells the parent which runs a restart cut off.
export const interruptedKind = "interrupted";

// The transcript entry that keeps a run as it was at its last change, so the
// run outlasts the Session's process (ADR 0058).
export const recordType = "subagents-run";

// A tool result's details for a call that started a run, with the run as it
// stood when the call returned.
export interface Started {
  readonly runId: string;
  readonly run?: RunView;
}

export function runState(run: RunView): ChildState {
  const states = run.children.map(({ state }) => state);

  if (run.shape === "workflow" && run.endedAt === undefined) {
    return "running";
  }

  if (cutOffWorkflow(run)) {
    return "interrupted";
  }

  for (const state of [
    "running",
    "queued",
    "failed",
    "interrupted",
    "stopped",
  ] as const) {
    if (states.includes(state)) {
      return state;
    }
  }

  return run.error === undefined ? "done" : "failed";
}

// A workflow whose script a restart cut off, which runs again on resume.
export function cutOffWorkflow(run: RunView): boolean {
  return (
    run.shape === "workflow" &&
    run.endedAt !== undefined &&
    run.output === undefined &&
    run.error === undefined
  );
}

// A call that names a task starts runs, whatever action a model also fills in.
export function manages(args: object): boolean {
  return (
    "action" in args &&
    !("task" in args) &&
    !("tasks" in args) &&
    !("chain" in args) &&
    !("workflow" in args)
  );
}

// A run as a restart left it: what hadn't ended is interrupted.
export function interrupted(run: RunView, at: number): RunView {
  return {
    ...run,
    endedAt: run.endedAt ?? at,
    children: run.children.map((child) =>
      child.state === "running" || child.state === "queued"
        ? {
            ...child,
            state: "interrupted",
            ...(child.startedAt !== undefined && {
              endedAt: child.endedAt ?? at,
            }),
          }
        : child,
    ),
  };
}

export type Importance = "low" | "medium" | "high";

// What the watchdog found wrong with a turn's changes (ADR 0058).
export interface Finding {
  readonly importance: Importance;
  readonly summary: string;
  readonly evidence: string;
  readonly action: string;
}

// The notice kind that shows a watchdog review. Only its high findings reach
// the model, and none once they are stuck.
export const watchdogKind = "watchdog";

export interface Review {
  readonly findings: readonly Finding[];
  // The same high findings came back too many times in a row, so they were
  // not sent again.
  readonly stuck?: boolean;
  readonly error?: string;
}

// A question a mission puts to the person, which the agent waits on.
export interface Decision {
  readonly id: string;
  readonly question: string;
  readonly options: readonly string[];
  readonly answer?: string;
}

// A link to something a mission produced, such as a pull request.
export interface Receipt {
  readonly label: string;
  readonly url: string;
}

// An objective the agent delegates work toward (ADR 0058).
export interface MissionView {
  readonly id: string;
  readonly title: string;
  readonly objective: string;
  readonly createdAt: number;
  readonly closedAt?: number;
  // How it ended, as the agent said when it closed it.
  readonly summary?: string;
  readonly runIds: readonly string[];
  readonly decisions: readonly Decision[];
  readonly receipts: readonly Receipt[];
  // What its workflows keep between runs, as JSON.
  readonly state?: unknown;
}

// The plugin data key that holds every mission of the Session.
export const missionsKey = "missions";

// The transcript entry that keeps a mission as it was at its last change.
export const missionRecordType = "subagents-mission";

// The notice kind that brings the person's decision to the agent.
export const decidedKind = "decided";

export function openDecisions(
  missions: readonly MissionView[],
): readonly Decision[] {
  return missions
    .filter(({ closedAt }) => closedAt === undefined)
    .flatMap(({ decisions }) =>
      decisions.filter(({ answer }) => answer === undefined),
    );
}
