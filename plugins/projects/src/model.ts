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

// A file in a Project's folder, which every Session in the Project sees as
// project/ (ADR 0078). path uses forward slashes.
export interface FolderFile {
  readonly path: string;
  readonly hash: string;
  readonly size: number;
  readonly actor: string;
  readonly updatedAt: number;
}

// One write to the folder; hash is null when the file was removed. A
// conflict is a copy kept because another Session changed the file first.
export interface FolderWrite {
  readonly id: string;
  readonly path: string;
  readonly hash: string | null;
  readonly size: number;
  readonly actor: string;
  readonly conflict: boolean;
  readonly at: number;
}

// What a Session changed since it last synced: base is the hash it started
// from, and hash is null when it removed the file.
export interface FolderChange {
  readonly path: string;
  readonly hash: string | null;
  readonly base: string | null;
}

export interface FolderSync {
  readonly files: readonly FolderFile[];
  // Changes kept under another name, since another Session got there first.
  readonly conflicts: readonly {
    readonly path: string;
    readonly copy: string;
  }[];
}

export const pathRule =
  "folder paths are names joined by /, each up to 200 characters, not only dots, not starting or ending with whitespace, and without \\, control characters or text direction controls";

const maxPath = 1024;

export function validPath(path: string): boolean {
  return path.length <= maxPath && path.split("/").every(validName);
}

// Direction controls can make "photo\u202Egnp.exe" display as "photoexe.png".
function validName(name: string): boolean {
  return (
    name !== "" &&
    name.length <= 200 &&
    !/^\.+$/.test(name) &&
    !/^\s|\s$/u.test(name) &&
    !/[/\\\p{Cc}\p{Bidi_Control}]/u.test(name)
  );
}

export function bytes(size: number): string {
  if (size < 1024) {
    return `${String(size)} B`;
  }

  if (size < 1024 * 1024) {
    return `${String(Math.round(size / 1024))} KB`;
  }

  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

// What a Session part learns of the Session it runs in.
export interface Membership {
  readonly projectId: string;
  readonly role: Role;
  readonly assistant: boolean;
}
