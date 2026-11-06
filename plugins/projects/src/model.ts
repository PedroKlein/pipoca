export const workStates = [
  "in_progress",
  "blocked",
  "review_ready",
  "done",
  "failed",
] as const;

export type WorkState = (typeof workStates)[number];

export type RunState =
  "working" | "waiting" | "idle" | "offline" | "interrupted" | "archived";

// A former coordinator was swapped for a fresh one and stays readable.
export type Role = "coordinator" | "thread" | "former";

export interface ProjectSummary {
  readonly id: string;
  readonly name: string;
  readonly coordinatorId: string;
  readonly coordinatorState: RunState;
  readonly repositories: number;
  readonly threads: number;
  // Threads that are blocked or wait on an answer.
  readonly needsYou: number;
  readonly team: boolean;
}

export interface ThreadView {
  readonly sessionId: string;
  readonly title: string;
  readonly runState: RunState;
  readonly workState: WorkState;
  readonly environmentId: string;
  readonly branch: string | null;
  readonly lastActivity: string;
}

export interface ThreadLinkView extends ThreadView {
  readonly projectId: string;
}

export interface MemoryFileView {
  readonly name: string;
  readonly size: number;
  readonly updatedAt: string;
  readonly actor: string;
}

export interface ProjectView {
  readonly id: string;
  readonly name: string;
  readonly goal: string;
  readonly instructions: string;
  readonly repositories: readonly string[];
  readonly environmentId: string | null;
  readonly profileId: string | null;
  readonly threadModel: string | null;
  readonly coordinatorId: string;
  readonly coordinatorState: RunState;
  // The person's Pipoca assistant (ADR 0052).
  readonly assistant: boolean;
  readonly team: boolean;
  // Earlier coordinators, oldest first.
  readonly formerCoordinators: readonly string[];
  readonly threads: readonly ThreadView[];
  readonly memory: readonly MemoryFileView[];
}

// The data of each notice a Project chat draws, by kind (ADR 0028).
export interface ProjectNotices {
  readonly thread: {
    readonly threadId: string;
    readonly title: string;
    readonly event: string;
    readonly runState: RunState;
    readonly workState: WorkState;
    readonly reply?: string;
  };
  readonly thread_message: {
    readonly threadId: string;
    readonly title: string;
    readonly text: string;
  };
  readonly coordinator_message: { readonly text: string };
}

export type ProjectNotice = {
  readonly [K in keyof ProjectNotices]: {
    readonly kind: K;
    readonly data: ProjectNotices[K];
  };
}[keyof ProjectNotices];

export interface LibraryFile {
  readonly name: string;
  readonly size: number;
  readonly actor: string;
  readonly updatedAt: string;
}

export interface LibraryWrite {
  readonly name: string;
  readonly size: number;
  readonly actor: string;
  readonly at: string;
}

export const nameRule =
  "file names can't be empty, longer than 200 characters or only dots, can't start or end with whitespace, and can't contain /, \\, control characters or text direction controls";

export function sizeRule(limit: number): string {
  return `library files are limited to ${String(limit / 1024 / 1024)} MB`;
}

// Direction controls can make "photo\u202Egnp.exe" display as "photoexe.png".
export function validName(name: string): boolean {
  return (
    name !== "" &&
    name.length <= 200 &&
    !/^\.+$/.test(name) &&
    !/^\s|\s$/u.test(name) &&
    !/[/\\\p{Cc}\p{Bidi_Control}]/u.test(name)
  );
}

// What a Session part learns of the Session it runs in.
export interface Membership {
  readonly projectId: string;
  readonly role: Role;
  readonly assistant: boolean;
}
