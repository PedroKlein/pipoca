import { ago, useApi, useNow } from "@pipoca/plugins/web";
import {
  Badge,
  Button,
  cardClass,
  Checkbox,
  cn,
  ErrorText,
  Segmented,
  TextArea,
} from "@pipoca/ui";
import {
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { artifacts as plugin } from "../plugin";
import {
  type ArtifactView,
  type Comment,
  type CommentKind,
  commentKinds,
  type Presence,
} from "../src/artifacts";
import type { Box, Picked, Pin } from "./collaborate";
import { mentionable, Said, ThreadView, useMentions } from "./thread";

// What a new thread is on: what the person picked, or the whole page.
export type Anchor = Picked | { readonly page: true };

// A thread with the number the page pins it by.
export interface Thread {
  readonly top: Comment;
  readonly replies: readonly Comment[];
  readonly n: number;
}

// Threads oldest first, numbered once so a number never moves.
export function threadsOf(comments: readonly Comment[]): readonly Thread[] {
  return comments
    .filter((each) => each.parent === null)
    .map((top, at) => ({
      top,
      replies: comments.filter((each) => each.parent === top.id),
      n: at + 1,
    }));
}

// Open threads pinned where they sit. An element is found only in the
// version it was written on; quoted text wherever it still reads the same.
export function pinsOf(
  threads: readonly Thread[],
  version: number,
  active: string | undefined,
  anchor: Anchor | undefined,
): readonly Pin[] {
  return [
    ...threads
      .filter(
        ({ top }) =>
          !top.resolved &&
          top.quote !== "" &&
          (top.element === "" || top.version === version),
      )
      .map(({ top, n }) => ({
        n,
        quote: top.quote,
        selector: top.element,
        active: top.id === active,
      })),
    ...(anchor === undefined || "page" in anchor
      ? []
      : [
          {
            n: null,
            quote: "quote" in anchor ? anchor.quote : "",
            selector: "element" in anchor ? anchor.element : "",
            active: false,
          },
        ]),
  ];
}

const kindLabels: Readonly<Record<CommentKind, string>> = {
  comment: "Comment",
  question: "Question",
  decision: "Decision",
  suggestion: "Suggestion",
};

function where(anchor: Anchor): ReactNode {
  if ("page" in anchor) {
    return "On the whole page";
  }

  return "quote" in anchor ? anchor.quote : `On “${anchor.label}”`;
}

// Below what was picked, or above it when there's no room, inside the
// frame. Until the frame has a size, at its top.
function placed(
  rect: Box | undefined,
  area: { readonly width: number; readonly height: number },
  width: number,
): { readonly left: number; readonly top: number } {
  if (area.width === 0) {
    return { left: 16, top: 16 };
  }

  if (rect === undefined) {
    return { left: Math.max(16, (area.width - width) / 2), top: 16 };
  }

  const left = Math.min(Math.max(16, rect.x), area.width - width - 16);
  const below = rect.y + rect.height + 10;

  return {
    left: Math.max(16, left),
    top:
      below + 240 <= area.height || rect.y < 250
        ? below
        : Math.max(16, rect.y - 250),
  };
}

// Where a new comment is written, at what it's on. A thread starts as a
// draft for Pi unless it names @pi; people who can't send to Pi just
// comment.
export function CommentBox({
  artifact,
  version,
  anchor,
  scrolled,
  area,
  people,
  onDone,
}: {
  readonly artifact: ArtifactView;
  readonly version: number;
  readonly anchor: Anchor;
  // Everyone else who can see the artifact, to mention.
  readonly people: readonly string[];
  // How far the page scrolled since the pick.
  readonly scrolled: { readonly x: number; readonly y: number };
  // The frame's size, to keep the box inside it.
  readonly area: { readonly width: number; readonly height: number };
  // With the new thread once saved, and whether it went to Pi at once.
  readonly onDone: (saved?: { id: string; sentToPi: boolean }) => void;
}): ReactElement {
  const api = useApi(plugin);
  const [opener] = useState(() => document.activeElement);
  const [body, setBody] = useState("");
  const [kind, setKind] = useState<CommentKind>("comment");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string>();
  const mentions = useMentions(mentionable(artifact, people));
  const width = area.width === 0 ? 420 : Math.min(420, area.width - 32);

  const at = placed(
    "rect" in anchor
      ? {
          ...anchor.rect,
          x: anchor.rect.x - scrolled.x,
          y: anchor.rect.y - scrolled.y,
        }
      : undefined,
    area,
    width,
  );

  const cancel = (): void => {
    onDone();

    if (opener instanceof HTMLElement && opener.isConnected) {
      opener.focus();
    }
  };

  const save = async (): Promise<void> => {
    setSaving(true);
    setProblem(undefined);

    try {
      const saved = await api.post<{ id: string; sentToPi: boolean }>(
        `artifacts/${artifact.id}/comments`,
        {
          version,
          body: body.trim(),
          kind,
          toPi: false,
          ...("quote" in anchor && { quote: anchor.quote }),
          ...("element" in anchor && {
            quote: anchor.label,
            element: anchor.element,
          }),
        },
      );

      onDone(saved);
    } catch (error) {
      setSaving(false);
      setProblem(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <form
      aria-label="New comment"
      style={{
        left: at.left,
        top: at.top,
        width,
      }}
      className="absolute z-10 flex flex-col gap-3 rounded-xl border border-line bg-elevated p-3.5 shadow-pop"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
      onKeyDown={(event: KeyboardEvent<HTMLFormElement>) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          cancel();
        } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();

          if (body.trim() !== "" && !saving) {
            void save();
          }
        }
      }}
    >
      <p className="truncate border-l-2 border-butter pl-2 text-label text-fg-dim">
        {where(anchor)}
      </p>
      <div className="relative">
        {mentions.menu}
        <TextArea
          aria-label="Comment text"
          aria-keyshortcuts="Control+Enter Meta+Enter"
          className="w-full"
          placeholder={
            artifact.askable
              ? "Add a comment, or @pi to ask now"
              : "Add a comment"
          }
          autoFocus
          rows={2}
          value={body}
          {...mentions.box}
          onChange={(event) => {
            setBody(event.target.value);
          }}
          onKeyDown={(event) => {
            mentions.keyDown(event);
          }}
        />
      </div>
      <div className="flex">
        <Segmented
          label="Kind of comment"
          value={kind}
          options={commentKinds.map((each) => ({
            value: each,
            label: kindLabels[each],
          }))}
          onChange={setKind}
        />
      </div>
      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={cancel}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          size="sm"
          disabled={body.trim() === "" || saving}
        >
          Comment
        </Button>
      </div>
      <ErrorText size="caption">{problem}</ErrorText>
      <p className="text-caption text-fg-dim">{hint(artifact)}</p>
    </form>
  );
}

function hint(artifact: ArtifactView): string {
  if (artifact.askable) {
    return "Saved as a draft for Pi. Send it now with @pi, or later with the others.";
  }

  return artifact.access === "steer"
    ? "Pi can't be asked about this artifact, so this comment is for people."
    : "People who can see this artifact can reply.";
}

// Pinned threads carry the page's pin; the rest just their number.
function PinMark({
  n,
  pinned,
}: {
  readonly n: number;
  readonly pinned: boolean;
}): ReactElement {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid size-5.5 shrink-0 place-items-center text-[11px] font-semibold",
        pinned
          ? "rounded-[11px_11px_11px_2px] bg-butter text-on-butter"
          : "rounded-full bg-hover text-fg-dim",
      )}
    >
      {n}
    </span>
  );
}

// The threads beside the page: open or resolved, the drafts not sent to Pi
// yet with Send for the checked ones, and the one being written.
// Which threads the list shows. A design doc also rolls up its open
// questions.
export type Listed = "open" | "resolved" | "questions";

export function CommentList({
  artifact,
  version,
  threads,
  shown: chosenList,
  onShown,
  margin,
  loaded,
  anchor,
  active,
  saved,
  people,
  presence,
  onFocused,
  onSaid,
  onActive,
  onWholePage,
  onChanged,
  onTyping,
}: {
  readonly artifact: ArtifactView;
  readonly version: number;
  readonly threads: readonly Thread[];
  readonly shown: Listed;
  readonly onShown: (shown: Listed) => void;
  // In a design doc's margin: how far below the list's top each thread's
  // passage sits, by thread id, to line its card up beside it.
  readonly margin?: ReadonlyMap<string, number> | undefined;
  readonly loaded: boolean | "failed";
  // What's being commented on now.
  readonly anchor: Anchor | undefined;
  readonly active: string | undefined;
  // The thread just written, to move focus to.
  readonly saved: string | undefined;
  readonly onFocused: () => void;
  // Says what just happened where screen readers hear it.
  readonly onSaid: (text: string) => void;
  readonly onActive: (id: string | undefined) => void;
  readonly onWholePage: () => void;
  readonly onChanged: () => void;
  // Everyone else who can see the artifact, to mention, and who of them is
  // looking now.
  readonly people: readonly string[];
  readonly presence: readonly Presence[];
  readonly onTyping: (thread: string | null) => void;
}): ReactElement {
  const api = useApi(plugin);
  const now = useNow();
  const [leftOut, setLeftOut] = useState<ReadonlySet<string>>(new Set());
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string>();
  const heading = useRef<HTMLHeadingElement | null>(null);
  const toHeading = useRef(false);
  // The thread just left, whose card takes focus back.
  const [left, setLeft] = useState<string>();
  const open = threads.filter(({ top }) => !top.resolved);
  const resolved = threads.filter(({ top }) => top.resolved);
  const questions = open.filter(({ top }) => top.kind === "question");
  const lists = { open, resolved, questions };

  // Unmarked meanwhile, a doc's questions are just open threads again.
  const shown =
    chosenList === "questions" && artifact.doc === null ? "open" : chosenList;

  const listed =
    margin === undefined
      ? lists[shown]
      : lists[shown].toSorted(
          (a, b) => (margin.get(a.top.id) ?? 0) - (margin.get(b.top.id) ?? 0),
        );

  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);

  const order = listed.map(({ top }) => top.id).join(" ");

  useLayoutEffect(() => {
    lineUp(root.current, list.current, margin);
  }, [margin, order]);

  const drafts = artifact.askable
    ? open.filter(({ top }) => top.sentBy === null)
    : [];

  const chosen = drafts.filter(({ top }) => !leftOut.has(top.id));

  const send = async (): Promise<void> => {
    setSending(true);
    setProblem(undefined);

    try {
      const { sent } = await api.post<{ sent: number }>(
        `artifacts/${artifact.id}/comments/send`,
        { threads: chosen.map(({ top }) => top.id) },
      );

      settled(`Sent ${String(sent)} to Pi`);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setSending(false);
    }
  };

  // The control that did it may be gone, so focus goes back to the top.
  function settled(text: string): void {
    onSaid(text);
    onChanged();
    heading.current?.focus();
  }

  const opened = threads.find(({ top }) => top.id === active);

  if (opened !== undefined) {
    return (
      <ThreadView
        key={opened.top.id}
        artifact={artifact}
        version={version}
        top={opened.top}
        replies={opened.replies}
        people={people}
        typing={presence
          .filter(({ typing }) => typing === opened.top.id)
          .map(({ name }) => name)}
        onBack={() => {
          // A thread resolved meanwhile isn't listed any more.
          if (
            opened.top.resolved === (shown === "resolved") &&
            (shown !== "questions" || opened.top.kind === "question")
          ) {
            setLeft(opened.top.id);
          } else {
            toHeading.current = true;
          }

          onActive(undefined);
        }}
        onSaid={onSaid}
        onChanged={onChanged}
        onTyping={(on) => {
          onTyping(on ? opened.top.id : null);
        }}
      />
    );
  }

  return (
    <div ref={root} className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-line px-3.5 py-2.5">
        <h3
          ref={(element) => {
            heading.current = element;

            if (element !== null && toHeading.current) {
              toHeading.current = false;
              element.focus();
            }
          }}
          tabIndex={-1}
          className="flex-1 text-ui font-medium text-fg-strong focus:outline-none"
        >
          Comments
        </h3>
        <Segmented
          label="Show"
          value={shown}
          options={[
            { value: "open", label: `Open ${String(open.length)}` },
            ...(artifact.doc === null
              ? []
              : [
                  {
                    value: "questions" as const,
                    label: `Questions ${String(questions.length)}`,
                  },
                ]),
            { value: "resolved", label: `Resolved ${String(resolved.length)}` },
          ]}
          onChange={onShown}
        />
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        {artifact.access === "view" && (
          <p className="text-caption text-fg-dim">
            You can read comments here but not add them.
          </p>
        )}
        {shown === "open" && drafts.length > 0 && (
          <div className="flex items-center gap-3 rounded-xl bg-butter/25 p-3">
            <div className="flex min-w-0 flex-1 flex-col">
              <b className="text-label font-medium text-fg-strong">
                {drafts.length === 1
                  ? "1 thread not sent to Pi"
                  : `${String(drafts.length)} threads not sent to Pi`}
              </b>
              <span className="text-caption text-fg">
                {chosen.length === drafts.length
                  ? "Pi handles them in one turn and publishes one version"
                  : leftOutLine(drafts.length - chosen.length)}
              </span>
            </div>
            <Button
              variant="primary"
              size="sm"
              disabled={chosen.length === 0 || sending}
              onClick={() => void send()}
            >
              Send {chosen.length} to Pi
            </Button>
          </div>
        )}
        <ErrorText size="caption">{problem}</ErrorText>
        {loaded === "failed" && (
          <div className="flex items-center gap-2">
            <ErrorText size="caption">
              Comments couldn&apos;t be loaded.
            </ErrorText>
            <Button variant="ghost" size="sm" onClick={onChanged}>
              Try again
            </Button>
          </div>
        )}
        <ul
          ref={list}
          aria-label={listLabels[shown]}
          className="flex flex-col gap-3"
        >
          {listed.map((thread) => (
            <ThreadCard
              key={thread.top.id}
              version={version}
              thread={thread}
              now={now}
              draft={drafts.includes(thread)}
              chosen={!leftOut.has(thread.top.id)}
              focused={thread.top.id === saved || thread.top.id === left}
              onFocused={() => {
                setLeft(undefined);
                onFocused();
              }}
              onChoose={(yes) => {
                const next = new Set(leftOut);

                if (yes) {
                  next.delete(thread.top.id);
                } else {
                  next.add(thread.top.id);
                }

                setLeftOut(next);
              }}
              onOpen={() => {
                onActive(thread.top.id);
              }}
              names={mentionable(artifact, people)}
            />
          ))}
          {shown === "open" && anchor !== undefined && (
            <li
              className={cn(
                cardClass,
                "flex flex-col gap-2 p-3 ring-1 ring-line-strong",
              )}
            >
              <span className="text-label">
                <b className="font-medium text-fg-strong">You</b>{" "}
                <span className="text-caption text-fg-dim">writing…</span>
              </span>
              <p className="truncate border-l-2 border-butter pl-2 text-label text-fg-dim italic">
                {where(anchor)}
              </p>
            </li>
          )}
        </ul>
        {loaded === true && listed.length === 0 && anchor === undefined && (
          <p className="text-label text-fg-dim">{empty(shown, artifact)}</p>
        )}
        {artifact.access !== "view" && shown === "open" && (
          <Button
            variant="ghost"
            size="sm"
            className="self-start"
            onClick={onWholePage}
          >
            Comment on the whole page
          </Button>
        )}
      </div>
    </div>
  );
}

function leftOutLine(count: number): string {
  return count === 1
    ? "The one left out stays a draft"
    : `The ${String(count)} left out stay drafts`;
}

const listLabels: Readonly<Record<Listed, string>> = {
  open: "Open comments",
  resolved: "Resolved comments",
  questions: "Open questions",
};

// Moves each card down to its passage, or as near as the cards above it
// let it.
function lineUp(
  root: HTMLElement | null,
  list: HTMLElement | null,
  margin: ReadonlyMap<string, number> | undefined,
): void {
  if (root === null || list === null) {
    return;
  }

  const origin = root.getBoundingClientRect().top;

  for (const card of list.children) {
    if (!(card instanceof HTMLElement)) {
      continue;
    }

    card.style.marginTop = "";

    const wanted = margin?.get(card.dataset["thread"] ?? "");

    if (wanted !== undefined) {
      const at = card.getBoundingClientRect().top - origin;

      card.style.marginTop = `${String(Math.max(0, wanted - at))}px`;
    }
  }
}

function empty(shown: Listed, artifact: ArtifactView): string {
  if (shown === "resolved") {
    return "Nothing resolved yet.";
  }

  if (shown === "questions") {
    return "No open questions.";
  }

  return artifact.access === "view"
    ? "No comments yet."
    : "Select text or click part of the page to comment on it.";
}

function ThreadCard({
  version,
  thread,
  now,
  draft,
  chosen,
  focused,
  onFocused,
  onChoose,
  onOpen,
  names,
}: {
  readonly version: number;
  readonly thread: Thread;
  // Who its text can mention, to show them.
  readonly names: readonly string[];
  readonly now: number;
  // Not sent to Pi yet, and the viewer can send it.
  readonly draft: boolean;
  readonly chosen: boolean;
  readonly focused: boolean;
  readonly onFocused: () => void;
  readonly onChoose: (yes: boolean) => void;
  readonly onOpen: () => void;
}): ReactElement {
  const said = useId();
  const { top, replies, n } = thread;
  const pinned = top.quote !== "";
  const element = top.element !== "";

  return (
    <li
      data-thread={top.id}
      className={cn(cardClass, "flex flex-col gap-2 p-3")}
    >
      <div className="flex min-w-0 items-center gap-2 text-caption text-fg-dim">
        {draft && (
          <Checkbox
            size="sm"
            label={<span className="sr-only">Send comment {n} to Pi</span>}
            checked={chosen}
            onChange={(event) => {
              onChoose(event.target.checked);
            }}
          />
        )}
        <PinMark n={n} pinned={pinned} />
        <b className="text-label font-medium text-fg-strong">{top.author}</b>
        <span className="min-w-0 flex-1 truncate">
          {element
            ? `on “${top.quote}”`
            : ago(new Date(top.createdAt).toISOString(), now)}
        </span>
        {top.version !== version && (
          <Badge title={`Made on version ${String(top.version)}`}>
            Version {top.version}
          </Badge>
        )}
        {top.kind !== "comment" && <Badge>{kindLabels[top.kind]}</Badge>}
        {top.resolvedByPi && <Badge state="done">Resolved by Pi</Badge>}
      </div>
      <button
        type="button"
        aria-describedby={[
          said,
          ...(replies.length > 0 ? [`${said}-replies`] : []),
          ...(top.sentBy !== null && !top.resolved ? [`${said}-sent`] : []),
        ].join(" ")}
        autoFocus={focused}
        onFocus={focused ? onFocused : undefined}
        aria-label={`Comment ${String(n)} by ${top.author}`}
        onClick={onOpen}
        className="flex cursor-pointer flex-col gap-1.5 rounded-md text-left focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
      >
        {pinned && !element && (
          <span className="truncate border-l-2 border-butter pl-2 text-label text-fg-dim italic">
            {top.quote}
          </span>
        )}
        <span id={said} className="text-label whitespace-pre-wrap text-fg">
          <Said text={top.body} names={names} />
        </span>
        {replies.length > 0 && (
          <span id={`${said}-replies`} className="text-caption text-fg-dim">
            {replies.length === 1
              ? "1 reply"
              : `${String(replies.length)} replies`}
          </span>
        )}
      </button>
      {draft && !chosen && (
        <span className="text-caption text-fg-dim">Left out of this send</span>
      )}
      {top.sentBy !== null && !top.resolved && (
        <span id={`${said}-sent`} className="text-caption text-fg-dim">
          Sent to Pi by {lower(top.sentBy)}
        </span>
      )}
    </li>
  );
}

// The viewer is "You" in what the server sends.
function lower(name: string): string {
  return name === "You" ? "you" : name;
}
