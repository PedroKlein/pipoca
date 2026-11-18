import { type PreviewKind, previewKind } from "@pipoca/plugins";

// What an artifact is drawn as, from its file's extension (ADR 0078).
export type Kind = Exclude<PreviewKind, "text">;

export const supported =
  "HTML, Markdown, SVG, PNG, JPEG, GIF, WebP, PDF and CSV files";

export function kindOf(name: string): Kind | undefined {
  const kind = previewKind(name);

  return kind === "text" ? undefined : kind;
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
  // When the viewer last opened it, or null.
  readonly openedAt: number | null;
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
  readonly doc: Doc | null;
}

export const docTypes = ["design", "spec", "plan"] as const;

export type DocType = (typeof docTypes)[number];

export const docStatuses = ["draft", "review", "decided"] as const;

export type DocStatus = (typeof docStatuses)[number];

export type Verdict = "approved" | "changes";

export interface Reviewer {
  readonly name: string;
  readonly you: boolean;
  readonly verdict: Verdict | null;
}

// A design doc, spec or plan, which people review (ADR 0081): marked by its
// file or by a person who steers it.
export interface Doc {
  readonly type: DocType;
  readonly status: DocStatus;
  readonly marked: "file" | "person";
  readonly reviewers: readonly Reviewer[];
}

export interface DocMark {
  readonly type: DocType;
  readonly status?: DocStatus;
}

const statusWords: Readonly<Record<string, DocStatus>> = {
  draft: "draft",
  review: "review",
  "in review": "review",
  decided: "decided",
};

// What a file says it is: Markdown front matter such as doc: design and
// status: in review, or an HTML page's pipoca:doc and pipoca:status meta
// tags.
export function docMark(kind: Kind, text: string): DocMark | undefined {
  const said =
    kind === "markdown"
      ? frontMatter(text)
      : kind === "html"
        ? metaTags(text)
        : {};
  const type = said["doc"]?.replace(/ doc$/, "");
  const status = statusWords[said["status"] ?? ""];

  if (!docTypes.includes(type as DocType)) {
    return undefined;
  }

  return { type: type as DocType, ...(status !== undefined && { status }) };
}

function frontMatter(text: string): Readonly<Record<string, string>> {
  const block = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(text)?.[1] ?? "";

  return Object.fromEntries(
    block.split(/\r?\n/).flatMap((line) => {
      const pair = /^(\w+):\s*(.*?)\s*$/.exec(line);

      return pair === null
        ? []
        : [
            [
              pair[1] ?? "",
              (pair[2] ?? "").replace(/^["']|["']$/g, "").toLowerCase(),
            ],
          ];
    }),
  );
}

function metaTags(text: string): Readonly<Record<string, string>> {
  return Object.fromEntries(
    [...text.slice(0, 20_000).matchAll(/<meta\s[^>]*>/gi)].flatMap(([tag]) => {
      const name = /\sname=["']pipoca:(\w+)["']/i.exec(tag)?.[1];
      const content = /\scontent=["']([^"']*)["']/i.exec(tag)?.[1];

      return name === undefined || content === undefined
        ? []
        : [[name.toLowerCase(), content.trim().toLowerCase()]];
    }),
  );
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
  csv: "Table",
  svg: "SVG",
  image: "Image",
  pdf: "PDF",
};

export const kinds = Object.keys(kindLabels) as readonly Kind[];

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
