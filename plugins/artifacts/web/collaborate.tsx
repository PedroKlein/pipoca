import {
  ago,
  href,
  useApi,
  useDraft,
  useLoaded,
  useNow,
} from "@pipoca/plugins/web";
import {
  Badge,
  Button,
  cardClass,
  Checkbox,
  cn,
  ErrorText,
  TextArea,
} from "@pipoca/ui";
import {
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { isHttpError, type TypedClient } from "@pipoca/plugins";
import { artifacts as plugin } from "../plugin";
import type { ArtifactView, Comment } from "../src/artifacts";
import type { Span } from "../src/diff";

export const base = "/api/ext/artifacts";

// The link that opens an artifact alone in the window, and that people
// share. A version's link keeps showing that version.
export function artifactHref(id: string, version?: number): string {
  return href(
    plugin,
    version === undefined ? id : `${id}/v/${String(version)}`,
  );
}

// An artifact as the viewer and the chat's cards load it. A missing one was
// deleted or isn't shared with the person.
export async function loadArtifact(
  api: TypedClient,
  id: string,
): Promise<ArtifactView | "missing" | "failed"> {
  return api
    .get<ArtifactView>(`artifacts/${id}`)
    .catch((error: unknown) =>
      isHttpError(error) && error.status === 404 ? "missing" : "failed",
    );
}

const sandbox =
  "allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals allow-forms";

// The artifact in its sandbox. A page may ask for a draft in the Session's
// composer, which the person sends or not (ADR 0078); pages Pipoca draws
// also say what the person selected.
export function Frame({
  artifact,
  version,
  onSelect,
  highlights,
  changes,
  className,
}: {
  readonly artifact: ArtifactView;
  readonly version: number;
  readonly onSelect?: (text: string) => void;
  // Text comments quote, which the page marks.
  readonly highlights?: readonly string[];
  // Words this version took out or put in, compared with another.
  readonly changes?: {
    readonly kind: "removed" | "added";
    readonly spans: readonly (Span & { readonly text: string })[];
  };
  // Its size and edge, in place of a bordered box three quarters as tall as
  // the window.
  readonly className?: string;
}): ReactElement {
  const frame = useRef<HTMLIFrameElement>(null);
  const draft = useDraft();
  const { sessionId } = artifact;
  const steers = artifact.access === "steer";

  useEffect(() => {
    const heard = (event: MessageEvent): void => {
      if (event.source !== frame.current?.contentWindow) {
        return;
      }

      const data = event.data as { pipoca?: unknown; text?: unknown } | null;

      if (typeof data?.text !== "string") {
        return;
      }

      if (data.pipoca === "draft" && sessionId !== null && steers) {
        draft(sessionId, data.text);
      } else if (data.pipoca === "selection") {
        onSelect?.(data.text);
      }
    };

    addEventListener("message", heard);

    return () => {
      removeEventListener("message", heard);
    };
  }, [draft, onSelect, sessionId, steers]);

  const marked = (highlights ?? []).join("\n");

  const highlight = useCallback(() => {
    frame.current?.contentWindow?.postMessage(
      { pipoca: "highlight", quotes: marked === "" ? [] : marked.split("\n") },
      "*",
    );
  }, [marked]);

  useEffect(highlight, [highlight]);

  const changed = JSON.stringify(changes ?? { kind: "added", spans: [] });

  const markChanges = useCallback(() => {
    frame.current?.contentWindow?.postMessage(
      { pipoca: "changes", ...(JSON.parse(changed) as object) },
      "*",
    );
  }, [changed]);

  useEffect(markChanges, [markChanges]);

  return (
    <iframe
      ref={frame}
      key={`${artifact.id}-${String(version)}`}
      title={`${artifact.title}, version ${String(version)}`}
      src={`${base}/artifacts/${artifact.id}/view?v=${String(version)}`}
      {...(artifact.kind !== "pdf" && { sandbox })}
      onLoad={() => {
        highlight();
        markChanges();
      }}
      className={cn(
        "w-full shrink-0 bg-white",
        className ?? "h-[75vh] rounded-lg border border-line",
      )}
    />
  );
}

// Threads of comments on the artifact, beside it. One sent to Pi reaches
// its Session as a notice, and Pi answers in the thread (ADR 0081).
export function Comments({
  artifact,
  version,
  quote,
  onQuoted,
}: {
  readonly artifact: ArtifactView;
  readonly version: number;
  readonly quote: string;
  readonly onQuoted: () => void;
}): ReactElement {
  const api = useApi(plugin);
  const now = useNow();

  const { value, reload } = useLoaded(
    async () =>
      (
        await api.get<{ comments: Comment[] }>(
          `artifacts/${artifact.id}/comments`,
        )
      ).comments,
    artifact.id,
    { changes: ["artifacts"] },
  );

  const all = value ?? [];
  const threads = all.filter((each) => each.parent === null);
  const open = threads.filter((each) => !each.resolved);
  const resolved = threads.filter((each) => each.resolved);
  const canComment = artifact.access !== "view";
  const quoted = threads.filter((each) => each.quote !== "");

  const thread = (top: Comment): ReactElement => (
    <li key={top.id} className={cn(cardClass, "flex flex-col gap-3 p-3")}>
      <CommentBody
        comment={top}
        now={now}
        {...(quoted.includes(top) && { mark: quoted.indexOf(top) + 1 })}
        {...(top.resolvedByPi && {
          badge: <Badge state="done">Resolved by Pi</Badge>,
        })}
      />
      {all
        .filter((each) => each.parent === top.id)
        .map((each) => (
          <div key={each.id} className="border-t border-line pt-3">
            <CommentBody comment={each} now={now} />
          </div>
        ))}
      <ThreadState artifact={artifact} thread={top} onSent={reload} />
      {canComment && (
        <CommentForm
          artifact={artifact}
          version={version}
          parent={top.id}
          hidden={top.resolved}
          onSent={reload}
        >
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              void api
                .post(`artifacts/${artifact.id}/comments/${top.id}/resolve`, {
                  resolved: !top.resolved,
                })
                .then(reload)
            }
          >
            {top.resolved ? "Reopen" : "Resolve"}
          </Button>
        </CommentForm>
      )}
    </li>
  );

  return (
    <div className="flex flex-col gap-3">
      <p className="text-caption text-fg-dim">
        {open.length === 0 ? "Nothing open" : `${String(open.length)} open`}
        {artifact.askable
          ? ". Pi sees a thread once you send it, and answers in it."
          : ""}
      </p>
      {canComment && (
        <CommentForm
          artifact={artifact}
          version={version}
          quote={quote}
          onSent={() => {
            onQuoted();
            reload();
          }}
        />
      )}
      {threads.length === 0 && (
        <p className="text-label text-fg-dim">No comments yet.</p>
      )}
      <ul aria-label="Comments" className="flex flex-col gap-3">
        {open.map(thread)}
      </ul>
      {resolved.length > 0 && (
        <details className="flex flex-col gap-3">
          <summary className="cursor-pointer text-label text-fg-dim">
            {`${String(resolved.length)} resolved`}
          </summary>
          <ul
            aria-label="Resolved comments"
            className="mt-3 flex flex-col gap-3"
          >
            {resolved.map(thread)}
          </ul>
        </details>
      )}
    </div>
  );
}

function CommentBody({
  comment,
  now,
  mark,
  badge,
}: {
  readonly comment: Comment;
  readonly now: number;
  // Its number on the passage the page marks.
  readonly mark?: number;
  readonly badge?: ReactNode;
}): ReactElement {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <span className="flex min-w-0 items-center gap-2 text-caption text-fg-dim">
        {comment.byPi && (
          <span
            aria-hidden="true"
            className="grid size-6 shrink-0 place-items-center rounded-full bg-accent text-caption font-semibold text-on-accent"
          >
            Pi
          </span>
        )}
        <b className="font-medium text-fg-strong">
          {comment.byPi ? "Pi" : comment.author}
        </b>
        <span className="min-w-0 flex-1 truncate">
          {[
            comment.byPi
              ? `via ${lower(comment.author)}`
              : `on version ${String(comment.version)}`,
            ago(new Date(comment.createdAt).toISOString(), now),
          ].join(" · ")}
        </span>
        {badge}
      </span>
      {comment.quote !== "" && (
        <blockquote className="border-l-2 border-accent pl-2 text-label text-fg-dim italic">
          {comment.quote}
          {mark !== undefined && <sup className="ml-1 not-italic">{mark}</sup>}
        </blockquote>
      )}
      <p className="text-label whitespace-pre-wrap">{comment.body}</p>
    </div>
  );
}

function lower(name: string): string {
  return name === "You" ? "you" : name;
}

// Whether Pi has the thread, and Send to Pi for people who can act in its
// Session.
function ThreadState({
  artifact,
  thread,
  onSent,
}: {
  readonly artifact: ArtifactView;
  readonly thread: Comment;
  readonly onSent: () => void;
}): ReactElement | null {
  const api = useApi(plugin);
  const [problem, setProblem] = useState<string>();

  if (thread.resolved) {
    return null;
  }

  if (thread.sentBy !== null) {
    return (
      <span className="text-caption text-fg-dim">
        {`Sent to Pi by ${lower(thread.sentBy)}`}
      </span>
    );
  }

  if (!artifact.askable) {
    return null;
  }

  return (
    <div className="flex flex-col gap-1">
      <Button
        variant="ghost"
        size="sm"
        className="self-start"
        onClick={() => {
          setProblem(undefined);

          void api
            .post(`artifacts/${artifact.id}/comments/send`, {
              threads: [thread.id],
            })
            .then(onSent)
            .catch((error: unknown) => {
              setProblem(
                error instanceof Error ? error.message : String(error),
              );
            });
        }}
      >
        Send to Pi
      </Button>
      <ErrorText size="caption">{problem}</ErrorText>
    </div>
  );
}

function CommentForm({
  artifact,
  version,
  parent,
  quote = "",
  hidden = false,
  onSent,
  children,
}: {
  readonly artifact: ArtifactView;
  readonly version: number;
  readonly parent?: string;
  readonly quote?: string;
  // Only the other actions show, such as Reopen on a resolved thread.
  readonly hidden?: boolean;
  readonly onSent: () => void;
  // More actions beside the send button.
  readonly children?: ReactNode;
}): ReactElement {
  const api = useApi(plugin);
  const [body, setBody] = useState("");
  const asks = parent === undefined && artifact.askable;
  const [toPi, setToPi] = useState(asks);
  const [problem, setProblem] = useState<string>();
  const label = parent === undefined ? "Comment" : "Reply";

  if (hidden) {
    return <div className="flex gap-2">{children}</div>;
  }

  return (
    <form
      aria-label={label}
      className="flex w-full flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        setProblem(undefined);

        void api
          .post(`artifacts/${artifact.id}/comments`, {
            version,
            body: body.trim(),
            toPi: asks && toPi,
            ...(quote !== "" && { quote }),
            ...(parent !== undefined && { parent }),
          })
          .then(() => {
            setBody("");
            onSent();
          })
          .catch((error: unknown) => {
            setProblem(error instanceof Error ? error.message : String(error));
          });
      }}
    >
      {quote !== "" && (
        <blockquote className="border-l-2 border-accent pl-2 text-label text-fg-dim">
          {quote}
        </blockquote>
      )}
      <TextArea
        aria-label={label}
        placeholder={parent === undefined ? "Add a comment" : "Reply…"}
        rows={parent === undefined ? 3 : 1}
        {...(parent !== undefined && { className: "min-h-0" })}
        value={body}
        onChange={(event) => {
          setBody(event.target.value);
        }}
      />
      <div className="flex flex-wrap items-center gap-3">
        {asks && (
          <Checkbox
            label="Send to Pi"
            size="sm"
            checked={toPi}
            onChange={(event) => {
              setToPi(event.target.checked);
            }}
          />
        )}
        <span className="flex-1" />
        {children}
        <Button type="submit" disabled={body.trim() === ""}>
          {label}
        </Button>
      </div>
      <ErrorText size="caption">{problem}</ErrorText>
    </form>
  );
}
