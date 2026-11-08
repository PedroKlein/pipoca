// What an artifact is drawn as, from its file's extension (ADR 0078).
export type Kind = "html" | "markdown" | "svg" | "image" | "pdf" | "csv";

const kinds: Readonly<Record<string, Kind>> = {
  html: "html",
  htm: "html",
  md: "markdown",
  markdown: "markdown",
  svg: "svg",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  pdf: "pdf",
  csv: "csv",
};

export const supported =
  "HTML, Markdown, SVG, PNG, JPEG, GIF, WebP, PDF and CSV files";

export function kindOf(name: string): Kind | undefined {
  const ext = name.split(".").at(-1)?.toLowerCase() ?? "";

  return name.includes(".") ? kinds[ext] : undefined;
}

export interface Version {
  readonly number: number;
  readonly name: string;
  readonly size: number;
  // An actor: user:<id> or session:<id>.
  readonly author: string;
  readonly createdAt: number;
}

export interface ArtifactSummary {
  readonly id: string;
  readonly title: string;
  readonly kind: Kind;
  readonly sessionId: string | null;
  readonly versions: number;
  readonly updatedAt: number;
}

export type Role = "view" | "comment";

export interface Share {
  readonly userId: string;
  readonly name: string;
  readonly role: Role;
}

// What the viewer may do: steer (share, restore, edit), comment, or view.
export type Access = "steer" | "comment" | "view";

export interface ArtifactView extends ArtifactSummary {
  readonly history: readonly Version[];
  readonly access: Access;
  readonly shares: readonly Share[];
  readonly pinned: boolean;
}

export interface Comment {
  readonly id: string;
  readonly version: number;
  // The comment it replies to.
  readonly parent: string | null;
  readonly author: string;
  // The text it's about, as the person selected it.
  readonly quote: string;
  readonly body: string;
  readonly sentToPi: boolean;
  readonly resolved: boolean;
  readonly createdAt: number;
}

export function isText(kind: Kind): boolean {
  return (
    kind === "html" || kind === "markdown" || kind === "svg" || kind === "csv"
  );
}

// What publish_artifact returns, for the card drawn in the chat.
export interface Published {
  readonly id: string;
  readonly title: string;
  readonly version: number;
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
