import { ago, useApi, useNow, useViewer } from "@pipoca/plugins/web";
import {
  Avatar,
  Badge,
  Button,
  cn,
  ErrorText,
  Icon,
  Menu,
  TextArea,
  type Typed,
  useCompletion,
} from "@pipoca/ui";
import {
  type ReactElement,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { artifacts as plugin } from "../plugin";
import {
  type ArtifactView,
  type Comment,
  type Reaction,
  reactionEmoji,
} from "../src/artifacts";

const reactionNames: Readonly<Record<Reaction["emoji"], string>> = {
  "👍": "Thumbs up",
  "🎉": "Celebrate",
  "👀": "Looking",
  "✅": "Done",
};

// The people a comment can name, and Pi where it can be asked.
export function mentionable(
  artifact: ArtifactView,
  people: readonly string[],
): readonly string[] {
  return artifact.askable ? ["pi", ...people] : people;
}

// A textarea's @ list of the people it can mention.
export function useMentions(
  names: readonly string[],
): ReturnType<typeof useCompletion> {
  return useCompletion({
    find: (text, caret): Typed | undefined => {
      const before = text.slice(0, caret);

      if (/^\S/.test(text.slice(caret))) {
        return undefined;
      }

      const typed = /(?:^|\s)@(\S*)$/.exec(before);
      const query = typed?.[1];

      return query === undefined
        ? undefined
        : { query, from: caret - query.length - 1, label: "People" };
    },
    options: ({ query }) => {
      const needle = query.toLowerCase();

      return names
        .filter((name) => name.toLowerCase().includes(needle))
        .sort(
          (a, b) =>
            Number(!a.toLowerCase().startsWith(needle)) -
            Number(!b.toLowerCase().startsWith(needle)),
        )
        .map((name) => ({
          value: `@${name}`,
          detail: name === "pi" ? "Asks Pi in this thread" : null,
        }));
    },
  });
}

// A comment's text with the people it names in bold.
export function Said({
  text,
  names,
}: {
  readonly text: string;
  readonly names: readonly string[];
}): ReactElement {
  const known = [...names, "pi"]
    .sort((a, b) => b.length - a.length)
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

  const parts = text.split(
    new RegExp(`((?:^|(?<=\\s))@(?:${known.join("|")})(?![\\w-]))`, "i"),
  );

  return (
    <>
      {parts.map((part, at) =>
        at % 2 === 1 ? (
          <b key={at} className="font-semibold text-fg-strong">
            {part}
          </b>
        ) : (
          part
        ),
      )}
    </>
  );
}

function typingLine(names: readonly string[]): string {
  if (names.length === 0) {
    return "";
  }

  if (names.length === 1) {
    return `${names[0] ?? ""} is typing…`;
  }

  return `${names.slice(0, -1).join(", ")} and ${names.at(-1) ?? ""} are typing…`;
}

// One thread as a small chat: its messages with their reactions, who is
// typing, and a reply box that mentions people and Pi.
export function ThreadView({
  artifact,
  version,
  top,
  replies,
  people,
  typing,
  onBack,
  onSaid,
  onChanged,
  onTyping,
}: {
  readonly artifact: ArtifactView;
  readonly version: number;
  readonly top: Comment;
  readonly replies: readonly Comment[];
  // Everyone else who can see the artifact, to mention.
  readonly people: readonly string[];
  // Who is typing in this thread now.
  readonly typing: readonly string[];
  readonly onBack: () => void;
  readonly onSaid: (text: string) => void;
  readonly onChanged: () => void;
  // Whether the person is typing a reply, false once it's sent.
  readonly onTyping: (on: boolean) => void;
}): ReactElement {
  const api = useApi(plugin);
  const now = useNow();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const canComment = artifact.access !== "view";
  const names = mentionable(artifact, people);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    heading.current?.focus();
  }, [top.id]);

  const resolve = (): void => {
    setProblem(undefined);
    setBusy(true);

    void api
      .post(`artifacts/${artifact.id}/comments/${top.id}/resolve`, {
        resolved: !top.resolved,
      })
      .then(() => {
        onSaid(top.resolved ? "Reopened" : "Resolved");
        onChanged();
      })
      .catch((error: unknown) => {
        setProblem(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <section aria-label="Thread" className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          aria-label="All comments"
          onClick={onBack}
        >
          <Icon name="chevron-left" className="size-4" />
        </Button>
        <h3
          ref={heading}
          tabIndex={-1}
          title={top.quote === "" ? undefined : top.quote}
          className="min-w-0 flex-1 truncate text-ui font-medium text-fg-strong focus:outline-none"
        >
          {titleOf(top)}
        </h3>
        {top.sentBy !== null && !top.resolved && (
          <span className="rounded-md bg-butter px-1.5 py-0.5 text-caption text-on-butter">
            Sent to Pi
          </span>
        )}
        {top.resolved && <Badge state="done">Resolved</Badge>}
        {canComment && (
          <Button size="sm" disabled={busy} onClick={resolve}>
            {top.resolved ? "Reopen" : "Resolve"}
          </Button>
        )}
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3.5 py-3">
        <ErrorText size="caption">{problem}</ErrorText>
        <ol aria-label="Messages" className="flex flex-col gap-4">
          {[top, ...replies].map((each) => (
            <Message
              key={each.id}
              artifact={artifact}
              comment={each}
              names={names}
              now={now}
              canReact={canComment}
              onChanged={onChanged}
            >
              {each === top && top.kind !== "comment" && (
                <Badge>{kindWord(top.kind)}</Badge>
              )}
            </Message>
          ))}
        </ol>
        <p role="status" className="text-caption text-fg-dim">
          {typingLine(typing)}
        </p>
      </div>
      {canComment && !top.resolved && (
        <Composer
          artifact={artifact}
          version={version}
          thread={top}
          names={names}
          onTyping={onTyping}
          onChanged={onChanged}
        />
      )}
    </section>
  );
}

const quoteShown = 32;

// Long quotes keep their start and end, as the page shows both.
function titleOf(top: Comment): string {
  if (top.quote === "") {
    return "Thread on the whole page";
  }

  const { quote } = top;
  const half = quoteShown / 2;

  return quote.length <= quoteShown
    ? `Thread on “${quote}”`
    : `Thread on “${quote.slice(0, half).trimEnd()} … ${quote.slice(-half).trimStart()}”`;
}

function kindWord(kind: Comment["kind"]): string {
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

function Message({
  artifact,
  comment,
  names,
  now,
  canReact,
  onChanged,
  children,
}: {
  readonly artifact: ArtifactView;
  readonly comment: Comment;
  readonly names: readonly string[];
  readonly now: number;
  readonly canReact: boolean;
  readonly onChanged: () => void;
  // Beside the name, such as the thread's kind.
  readonly children?: ReactNode;
}): ReactElement {
  const api = useApi(plugin);
  const [problem, setProblem] = useState<string>();
  const viewer = useViewer();
  // The reactions a press was made on: until they load again, another press
  // would repeat it rather than undo it.
  const [pressedOn, setPressedOn] = useState<readonly Reaction[]>();
  const busy = pressedOn === comment.reactions;
  const who = comment.byPi ? "Pi" : comment.author;

  const react = (emoji: Reaction["emoji"], on: boolean): void => {
    if (busy) {
      return;
    }

    setPressedOn(comment.reactions);
    setProblem(undefined);

    void api
      .put(`artifacts/${artifact.id}/comments/${comment.id}/reactions`, {
        emoji,
        on,
      })
      .then(onChanged)
      .catch((error: unknown) => {
        setPressedOn(undefined);
        setProblem(error instanceof Error ? error.message : String(error));
      });
  };

  const mine = (emoji: Reaction["emoji"]): boolean =>
    comment.reactions.some((each) => each.emoji === emoji && each.mine);

  return (
    <li className="group flex gap-2.5">
      <Avatar
        name={comment.author === "You" ? viewer.person.name : comment.author}
        pi={comment.byPi}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex min-h-6 flex-wrap items-center gap-x-2 text-caption text-fg-dim">
          <b className="text-label font-medium text-fg-strong">{who}</b>
          {[
            ...(comment.byPi
              ? [`via ${comment.author === "You" ? "you" : comment.author}`]
              : []),
            ago(new Date(comment.createdAt).toISOString(), now),
          ].join(" · ")}
          {children}
          {canReact && (
            <span className="ml-auto focus-within:opacity-100 group-hover:opacity-100 has-aria-expanded:opacity-100 pointer-fine:opacity-0">
              <Menu
                label="Add a reaction"
                align="end"
                size="sm"
                variant="ghost"
                icon="smile-plus"
                items={reactionEmoji.map((emoji) => ({
                  label: reactionNames[emoji],
                  mark: <span aria-hidden="true">{emoji}</span>,
                  checked: mine(emoji),
                  run: () => {
                    react(emoji, !mine(emoji));
                  },
                }))}
              />
            </span>
          )}
        </span>
        <p className="text-label whitespace-pre-wrap text-fg">
          <Said text={comment.body} names={names} />
        </p>
        {comment.reactions.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {comment.reactions.map((each) => (
              <button
                key={each.emoji}
                type="button"
                aria-pressed={each.mine}
                aria-label={`${reactionNames[each.emoji]} from ${each.people.join(", ")}`}
                disabled={!canReact || busy}
                onClick={() => {
                  react(each.emoji, !each.mine);
                }}
                className={cn(
                  "inline-flex h-6 cursor-pointer items-center gap-1 rounded-full border px-2 text-caption disabled:cursor-default",
                  each.mine
                    ? "border-line-strong bg-hover text-fg-strong"
                    : "border-line text-fg",
                )}
              >
                <span aria-hidden="true">{each.emoji}</span>
                <span aria-hidden="true">{each.people.join(", ")}</span>
              </button>
            ))}
          </div>
        )}
        <ErrorText size="caption">{problem}</ErrorText>
      </div>
    </li>
  );
}

function Composer({
  artifact,
  version,
  thread,
  names,
  onTyping,
  onChanged,
}: {
  readonly artifact: ArtifactView;
  readonly version: number;
  readonly thread: Comment;
  readonly names: readonly string[];
  readonly onTyping: (on: boolean) => void;
  readonly onChanged: () => void;
}): ReactElement {
  const api = useApi(plugin);
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string>();
  const mentions = useMentions(names);

  const send = (): void => {
    if (sending || body.trim() === "") {
      return;
    }

    setProblem(undefined);
    setSending(true);

    void api
      .post(`artifacts/${artifact.id}/comments`, {
        version,
        body: body.trim(),
        parent: thread.id,
        toPi: false,
      })
      .then(() => {
        setBody("");
        onTyping(false);
        onChanged();
      })
      .catch((error: unknown) => {
        setProblem(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        setSending(false);
      });
  };

  return (
    <form
      aria-label="Reply"
      className="flex flex-col gap-2 border-t border-line p-3"
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      <div className="relative">
        {mentions.menu}
        <TextArea
          aria-label="Reply"
          aria-keyshortcuts="Control+Enter Meta+Enter"
          className="w-full"
          placeholder={
            artifact.askable
              ? "Reply to the thread. @ mentions people or Pi."
              : "Reply to the thread. @ mentions people."
          }
          rows={2}
          value={body}
          {...mentions.box}
          onChange={(event) => {
            setBody(event.target.value);
            onTyping(true);
          }}
          onKeyDown={(event) => {
            if (mentions.keyDown(event)) {
              return;
            }

            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              send();
            }
          }}
        />
      </div>
      <div className="flex items-center gap-2">
        <span className="flex-1 text-caption text-fg-dim">
          {hint(artifact, thread)}
        </span>
        <Button
          type="submit"
          size="sm"
          variant="primary"
          disabled={body.trim() === "" || sending}
          title="Reply (Ctrl+Enter or ⌘↵)"
        >
          Reply
        </Button>
      </div>
      <ErrorText size="caption">{problem}</ErrorText>
    </form>
  );
}

function hint(artifact: ArtifactView, thread: Comment): string {
  if (thread.sentBy !== null) {
    return artifact.askable
      ? "This thread is sent to Pi: replies wake it until it's resolved."
      : "This thread is sent to Pi: replies from people who can act in its Session reach it.";
  }

  return artifact.askable
    ? "Write @pi to ask Pi in this thread."
    : "People who can see this artifact can reply.";
}
