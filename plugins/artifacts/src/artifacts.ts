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
  // Who made it, for people: Pi or the person's name.
  readonly by: string;
  // What changed, in Pi's or the person's words.
  readonly note: string;
  readonly createdAt: number;
}

// Who opens it besides the people who see its Session: only them, people
// named on it too, or the whole team.
export type Audience = "you" | "named" | "team";

export interface ArtifactSummary {
  readonly id: string;
  readonly title: string;
  readonly kind: Kind;
  readonly sessionId: string | null;
  readonly sessionTitle: string | null;
  // The person whose work it is, or Team.
  readonly owner: string;
  // Whether the viewer steers it, so it's theirs.
  readonly yours: boolean;
  readonly audience: Audience;
  readonly sharedWith: readonly string[];
  readonly openComments: number;
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
  // Whether the viewer can send threads to Pi: they steer its Session, and
  // the Session is there and not archived.
  readonly askable: boolean;
  readonly shares: readonly Share[];
  readonly pinned: boolean;
}

export const commentKinds = [
  "comment",
  "question",
  "decision",
  "suggestion",
] as const;

export type CommentKind = (typeof commentKinds)[number];

export interface Comment {
  readonly id: string;
  readonly kind: CommentKind;
  readonly version: number;
  // The comment it replies to.
  readonly parent: string | null;
  // A person, or for Pi's reply the person who sent Pi the thread.
  readonly author: string;
  readonly byPi: boolean;
  // The text it's about, as the person selected it, or what names the
  // element it's on.
  readonly quote: string;
  // The element it's on, as a selector in its version, or empty.
  readonly element: string;
  readonly body: string;
  // On a thread: who last sent it to Pi, or null.
  readonly sentBy: string | null;
  readonly resolved: boolean;
  readonly resolvedByPi: boolean;
  readonly createdAt: number;
  readonly reactions: readonly Reaction[];
}

export const reactionEmoji = ["👍", "🎉", "👀", "✅"] as const;

// One reaction on a comment and who gave it, the viewer as "You".
export interface Reaction {
  readonly emoji: (typeof reactionEmoji)[number];
  readonly people: readonly string[];
  readonly mine: boolean;
}

// Someone else looking at the artifact, and the thread they type in.
export interface Presence {
  readonly name: string;
  readonly typing: string | null;
}

// The threads one notice told Pi about, for its row in the chat.
export interface Batch {
  readonly senders: readonly string[];
  readonly threads: readonly {
    readonly artifact: string;
    readonly title: string;
    readonly comment: Comment;
  }[];
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
  readonly kind: Kind;
}

const kindLabels: Readonly<Record<Kind, string>> = {
  html: "Page",
  markdown: "Markdown",
  svg: "SVG",
  image: "Image",
  pdf: "PDF",
  csv: "Table",
};

export function kindLabel(kind: Kind): string {
  return kindLabels[kind];
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
