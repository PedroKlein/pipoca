import { frontMatter, type PreviewKind, previewKind } from "@pipoca/plugins";

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
  // On a living doc, what makes this save a version, such as Approved by
  // Ana, or null for an edit.
  readonly label: string | null;
}

// ADR 0082: a Markdown doc or HTML page is edited in place, and only its
// labelled saves are versions. Every save of any other artifact is one.
export function living(kind: Kind): boolean {
  return kind === "markdown" || kind === "html";
}

// The version a save is, numbered among versions, or null for an edit.
export function versionOf(
  artifact: Pick<ArtifactView, "living" | "history">,
  save: number,
): number | null {
  if (!artifact.living) {
    return save;
  }

  const saves = artifact.history.slice(0, save);

  return (saves.at(-1)?.label ?? null) === null
    ? null
    : saves.filter(({ label }) => label !== null).length;
}

// How many versions it has, for a list: none on a living doc no one named
// or approved yet.
export function versionTag(
  artifact: Pick<ArtifactSummary, "named">,
): readonly string[] {
  return artifact.named === 0 ? [] : [`v${String(artifact.named)}`];
}

// What people call a save: Version 2 · Approved by Ana, Version 3, or on a
// living doc an edit.
export function saveName(
  artifact: Pick<ArtifactView, "living" | "history">,
  save: number,
): string {
  const number = versionOf(artifact, save);
  const label = artifact.history[save - 1]?.label ?? null;

  if (number === null) {
    return "Edit";
  }

  return label === null
    ? `Version ${String(number)}`
    : `Version ${String(number)} · ${label}`;
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
  // How many saves it has, the newest being that number.
  readonly versions: number;
  // Whether it's edited in place, and how many of its saves are versions.
  readonly living: boolean;
  readonly named: number;
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

// Only a person decides, so a file can't say a doc is decided.
const statusWords: Readonly<Record<string, DocStatus>> = {
  draft: "draft",
  review: "review",
  "in review": "review",
};

// What a file says it is: Markdown front matter such as doc: design and
// status: in review, or an HTML page's pipoca:doc and pipoca:status meta
// tags.
export function docMark(kind: Kind, text: string): DocMark | undefined {
  const readers: Partial<
    Record<Kind, (text: string) => Readonly<Record<string, string>>>
  > = {
    markdown: (each) => frontMatter(each).fields,
    html: metaTags,
  };

  const said = readers[kind]?.(text) ?? {};

  const type = said["doc"]?.replace(/ doc$/, "");
  const status = statusWords[said["status"] ?? ""];

  if (!docTypes.includes(type as DocType)) {
    return undefined;
  }

  return { type: type as DocType, ...(status !== undefined && { status }) };
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
  // On a reply of Pi's, the edit it suggests.
  readonly suggestion: Suggestion | null;
  // The reader wrote it or steers the artifact.
  readonly deletable: boolean;
}

// Replacing find, once in the version Pi read, with replace.
export interface Suggestion {
  readonly find: string;
  readonly replace: string;
  readonly version: number;
  readonly state: "open" | "accepted" | "rejected";
  // Who accepted or rejected it.
  readonly by: string | null;
  // The version accepting it saved.
  readonly saved: number | null;
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

export type ActivityKind = "mention" | "review" | "reply" | "comment";

// What a person asks to be told of: mentions and review requests, replies
// in threads they're in, and every comment on their own artifacts.
export const activityTopics = ["asked", "replies", "comments"] as const;

export type ActivityTopic = (typeof activityTopics)[number];

export type ActivitySettings = Readonly<Record<ActivityTopic, boolean>>;

export const topicOf: Readonly<Record<ActivityKind, ActivityTopic>> = {
  mention: "asked",
  review: "asked",
  reply: "replies",
  comment: "comments",
};

// One thing a person was told of, or for what they follow, one comment.
export interface ActivityItem {
  readonly id: string;
  readonly kind: ActivityKind;
  // What it's on: an artifact, or the team work someone named them in.
  readonly artifact: string | null;
  readonly session: string | null;
  readonly title: string;
  // The thread it's in, by its first comment.
  readonly thread: string | null;
  // What the thread is on.
  readonly quote: string;
  readonly by: string;
  readonly byPi: boolean;
  readonly suggested: boolean;
  readonly excerpt: string;
  readonly doc: DocType | null;
  readonly version: number;
  readonly at: number;
  readonly read: boolean;
}

export function headline(
  item: Pick<
    ActivityItem,
    "kind" | "by" | "byPi" | "suggested" | "title" | "session"
  >,
): string {
  switch (item.kind) {
    case "mention":
      return `${item.by} mentioned you ${item.session === null ? "on" : "in"} ${item.title}`;
    case "review":
      return `${item.by} asked you to review ${item.title}`;
    case "comment":
      return `${item.by} commented on ${item.title}`;
    case "reply":
      if (!item.byPi) {
        return `${item.by} replied in a thread you're in`;
      }

      return item.suggested
        ? "Pi suggested an edit in a thread you're in"
        : "Pi replied in a thread you're in";
  }
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
