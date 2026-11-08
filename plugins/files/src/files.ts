// A file a Session keeps on the server: one Pi made in outputs/, or one a
// person gave it in uploads/ (ADR 0078).
export interface SessionFile {
  readonly place: Place;
  // Under the place's folder, with forward slashes.
  readonly path: string;
  readonly hash: string;
  readonly size: number;
  readonly savedAt: number;
  readonly by: string | null;
}

export type Place = "outputs" | "uploads";

export const places: readonly Place[] = ["outputs", "uploads"];

// The notice Pi gets when a person adds an upload, which tells the Session
// part to copy it into uploads/.
export const uploadNotice = "files";

export interface UploadNoticeData {
  readonly path: string;
  readonly size: number;
}

// What the Session part publishes under "files" for its view.
export interface FilesState {
  // Outputs the server doesn't have yet.
  readonly unsaved: readonly string[];
  readonly problem?: string;
}

const maxPath = 1024;

// A path under outputs/ as the Session reports it: relative, without "." or
// ".." parts.
export function cleanPath(path: string): string | undefined {
  const parts = path.split("/");

  return path.length <= maxPath &&
    parts.every((part) => part !== "" && part !== "." && part !== "..") &&
    !path.includes("\\") &&
    !path.includes("\0")
    ? path
    : undefined;
}

export function bytes(size: number): string {
  if (size < 1024) {
    return `${String(size)} B`;
  }

  if (size < 1024 * 1024) {
    return `${String(Math.round(size / 1024))} KB`;
  }

  if (size < 1024 ** 3) {
    return `${(size / 1024 / 1024).toFixed(1)} MB`;
  }

  return `${(size / 1024 ** 3).toFixed(1)} GB`;
}

// A file a snapshot changed against its checkout's HEAD.
export interface SnapshotChange {
  readonly path: string;
  readonly change: "new" | "changed" | "deleted";
}

// How many of a snapshot's changed files people see by name.
export const shownChanges = 50;
