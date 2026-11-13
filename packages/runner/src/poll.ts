import {
  type Attempt,
  leaseMs,
  type Log,
  loggedStart,
  type ModelInfo,
  movable,
  type ReachedHost,
  type Removal,
  type SessionStart,
  type Work,
  type WorkPoll,
  type Workspace,
} from "@pipoca/protocol";
import { backoff } from "./backoff";

export interface ControlPlane {
  work: (poll: WorkPoll, signal: AbortSignal) => Promise<Work>;
}

interface PollOptions {
  readonly controlPlane: ControlPlane;
  readonly start: (assignment: SessionStart) => void;
  readonly unload: (attempt: Attempt) => void;
  readonly remove: (removal: Removal) => void;
  // Every Profile that still exists, after each poll.
  readonly profiles: (ids: readonly string[]) => void;
  readonly running: () => readonly Attempt[];
  readonly folders: readonly string[];
  readonly capacity?: number;
  readonly session?: string;
  readonly models: () => readonly ModelInfo[];
  readonly registeredModels?: () => readonly ModelInfo[];
  readonly reach?: () => readonly ReachedHost[];
  readonly log: Log;
  readonly signal: AbortSignal;
  readonly retry?: { readonly initialMs: number; readonly maxMs: number };
  readonly leaseMs?: number;
}

export async function pollForWork(options: PollOptions): Promise<void> {
  const {
    controlPlane,
    start,
    unload,
    remove,
    profiles,
    running,
    folders,
    models,
    log,
    signal,
  } = options;

  const { initialMs, maxMs } = options.retry ?? {
    initialMs: 1000,
    maxMs: 20_000,
  };

  const retry = backoff(initialMs, maxMs);

  const workspaces = new Map<string, Workspace>();

  // Half the server's lease, so these Sessions stop before the server can
  // start them on another runner (ADR 0032).
  const stopMovableAfterMs = (options.leaseMs ?? leaseMs) / 2;

  const stopMovable = (): void => {
    for (const attempt of running()) {
      const workspace = workspaces.get(attempt.sessionId);
      if (workspace !== undefined && movable(workspace)) {
        log("stopping session after losing its lease", { ...attempt });
        unload(attempt);
      }
    }
  };

  let leaseTimer = setTimeout(stopMovable, stopMovableAfterMs);
  let polls = 0;
  let started = 0;
  log("provider polling for work");
  while (!signal.aborted) {
    try {
      const work = await controlPlane.work(
        {
          running: running(),
          folders,
          models: models(),
          ...(options.registeredModels && {
            registeredModels: options.registeredModels(),
          }),
          ...(options.capacity !== undefined && {
            capacity: options.capacity,
          }),
          ...(options.session !== undefined && { session: options.session }),
          ...(options.reach && { reach: [...options.reach()] }),
        },
        signal,
      );

      polls++;
      retry.reset();
      clearTimeout(leaseTimer);
      leaseTimer = setTimeout(stopMovable, stopMovableAfterMs);

      const live = new Set(running().map(({ sessionId }) => sessionId));
      for (const sessionId of workspaces.keys()) {
        if (!live.has(sessionId)) {
          workspaces.delete(sessionId);
        }
      }

      for (const assignment of work.start) {
        started++;
        workspaces.set(assignment.sessionId, assignment.workspace);
        log("starting session", { ...loggedStart(assignment), started });
        start(assignment);
      }

      for (const attempt of work.unload) {
        log("unloading session", { ...attempt });
        unload(attempt);
      }

      work.remove.forEach(remove);
      // An older server sends none, which mustn't read as every Profile gone.
      if (Array.isArray(work.profiles)) {
        profiles(work.profiles);
      }
    } catch (error) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- the signal can abort while the await above is pending
      if (signal.aborted) {
        break;
      }

      log("work poll failed", {
        error: String(error),
        retryInMs: retry.delayMs(),
      });

      await retry.wait(signal);
    }
  }

  clearTimeout(leaseTimer);
  log("provider stopped", { polls, started });
}
