import { useApi, useDraft, useLoaded } from "@pipoca/plugins/web";
import {
  Button,
  Checkbox,
  cn,
  ErrorText,
  Section,
  Select,
  TextArea,
} from "@pipoca/ui";
import { type ReactElement, useEffect, useRef, useState } from "react";
import { artifacts as plugin } from "../plugin";
import { type ArtifactView, type Comment, isText } from "../src/artifacts";
import { type DiffLine, lineDiff } from "../src/diff";

export const base = "/api/ext/artifacts";

const sandbox =
  "allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals allow-forms";

// The artifact in its sandbox. A page may ask for a draft in the Session's
// composer, which the person sends or not (ADR 0078); pages Pipoca draws
// also say what the person selected.
export function Frame({
  artifact,
  version,
  onSelect,
  className,
}: {
  readonly artifact: ArtifactView;
  readonly version: number;
  readonly onSelect?: (text: string) => void;
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

  return (
    <iframe
      ref={frame}
      key={`${artifact.id}-${String(version)}`}
      title={`${artifact.title}, version ${String(version)}`}
      src={`${base}/artifacts/${artifact.id}/view?v=${String(version)}`}
      {...(artifact.kind !== "pdf" && { sandbox })}
      className={cn(
        "h-[75vh] w-full rounded-lg border border-line bg-white",
        className,
      )}
    />
  );
}

async function textOf(id: string, version: number): Promise<string> {
  const response = await fetch(
    `${base}/artifacts/${id}/download?v=${String(version)}`,
  );

  if (!response.ok) {
    throw new Error(`version ${String(version)} didn't load`);
  }

  return response.text();
}

// Two versions as a source diff, or side by side for pictures and PDFs.
export function Compare({
  artifact,
  version,
}: {
  readonly artifact: ArtifactView;
  readonly version: number;
}): ReactElement {
  const [against, setAgainst] = useState(Math.max(1, version - 1));
  const text = isText(artifact.kind);

  const { value: lines } = useLoaded(
    async (): Promise<readonly DiffLine[] | undefined> =>
      text
        ? lineDiff(
            await textOf(artifact.id, against),
            await textOf(artifact.id, version),
          )
        : [],
    `${artifact.id}:${String(against)}:${String(version)}`,
  );

  return (
    <div className="flex flex-col gap-3">
      <label className="flex items-center gap-2 text-label">
        Compare version {version} with
        <Select
          aria-label="Compare with"
          value={String(against)}
          onChange={(event) => {
            setAgainst(Number(event.target.value));
          }}
        >
          {artifact.history
            .filter((each) => each.number !== version)
            .map((each) => (
              <option key={each.number} value={each.number}>
                {`Version ${String(each.number)}`}
              </option>
            ))}
        </Select>
      </label>
      {text ? (
        <DiffView lines={lines} />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          <Frame artifact={artifact} version={against} className="h-[60vh]" />
          <Frame artifact={artifact} version={version} className="h-[60vh]" />
        </div>
      )}
    </div>
  );
}

const marks: Readonly<Record<DiffLine["kind"], string>> = {
  added: "+",
  removed: "-",
  same: " ",
};

function DiffView({
  lines,
}: {
  readonly lines: readonly DiffLine[] | undefined;
}): ReactElement {
  if (lines === undefined) {
    return (
      <p className="text-fg-dim">
        These versions are too long to compare here. Download both to compare
        them.
      </p>
    );
  }

  return (
    <pre
      aria-label="Changes"
      className="max-h-[70vh] overflow-auto rounded-lg border border-line p-3 font-mono text-mono"
    >
      {lines.map((line, at) => (
        <div
          key={at}
          className={cn(
            "whitespace-pre-wrap",
            line.kind === "added" && "bg-done/15",
            line.kind === "removed" && "bg-failed/15 text-fg-dim line-through",
          )}
        >
          {`${marks[line.kind]} ${line.text}`}
        </div>
      ))}
    </pre>
  );
}

// A Markdown artifact's source, saved as a new version that Pi hears about.
export function Editor({
  artifact,
  onDone,
}: {
  readonly artifact: ArtifactView;
  readonly onDone: () => void;
}): ReactElement {
  const api = useApi(plugin);
  const [text, setText] = useState<string>();
  const [problem, setProblem] = useState<string>();

  useEffect(() => {
    void textOf(artifact.id, artifact.versions).then(
      setText,
      (error: unknown) => {
        setProblem(String(error));
      },
    );
  }, [artifact.id, artifact.versions]);

  const save = async (): Promise<void> => {
    try {
      await api.post(`artifacts/${artifact.id}/versions`, { text });
      onDone();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <TextArea
        aria-label="Markdown"
        className="min-h-[60vh] font-mono text-mono"
        value={text ?? ""}
        disabled={text === undefined}
        onChange={(event) => {
          setText(event.target.value);
        }}
      />
      <div className="flex gap-2">
        <Button variant="primary" onClick={() => void save()}>
          Save as a new version
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
      <ErrorText size="caption">{problem}</ErrorText>
    </div>
  );
}

// Threads of comments on the artifact. One sent to Pi reaches the Session
// as the person's message.
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
  const canComment = artifact.access !== "view";

  return (
    <Section
      title="Comments"
      description={
        canComment && artifact.sessionId !== null
          ? "A comment sent to Pi reaches the Session as your message."
          : undefined
      }
    >
      {threads.length === 0 && <p className="text-fg-dim">No comments yet.</p>}
      <ul aria-label="Comments" className="flex flex-col gap-3">
        {threads.map((thread) => (
          <li
            key={thread.id}
            className={cn(
              "flex flex-col gap-2 rounded-lg border border-line p-3",
              thread.resolved && "opacity-60",
            )}
          >
            <CommentBody comment={thread} />
            {all
              .filter((each) => each.parent === thread.id)
              .map((reply) => (
                <div key={reply.id} className="border-l-2 border-line pl-3">
                  <CommentBody comment={reply} />
                </div>
              ))}
            {canComment && (
              <div className="flex flex-wrap items-center gap-2">
                <CommentForm
                  artifact={artifact}
                  version={version}
                  parent={thread.id}
                  onSent={reload}
                />
                <Button
                  variant="ghost"
                  onClick={() =>
                    void api
                      .post(
                        `artifacts/${artifact.id}/comments/${thread.id}/resolve`,
                        { resolved: !thread.resolved },
                      )
                      .then(reload)
                  }
                >
                  {thread.resolved ? "Reopen" : "Resolve"}
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
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
    </Section>
  );
}

function CommentBody({ comment }: { readonly comment: Comment }): ReactElement {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-caption text-fg-dim">
        {comment.author} · version {comment.version} ·{" "}
        {new Date(comment.createdAt).toLocaleString()}
        {comment.sentToPi && " · sent to Pi"}
        {comment.resolved && " · resolved"}
      </span>
      {comment.quote !== "" && (
        <blockquote className="border-l-2 border-line pl-2 text-label text-fg-dim">
          {comment.quote}
        </blockquote>
      )}
      <p className="whitespace-pre-wrap">{comment.body}</p>
    </div>
  );
}

function CommentForm({
  artifact,
  version,
  parent,
  quote = "",
  onSent,
}: {
  readonly artifact: ArtifactView;
  readonly version: number;
  readonly parent?: string;
  readonly quote?: string;
  readonly onSent: () => void;
}): ReactElement {
  const api = useApi(plugin);
  const [body, setBody] = useState("");
  const [toPi, setToPi] = useState(artifact.sessionId !== null);
  const [problem, setProblem] = useState<string>();
  const label = parent === undefined ? "Comment" : "Reply";

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
            toPi,
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
        placeholder={parent === undefined ? "Add a comment" : "Reply"}
        rows={parent === undefined ? 3 : 1}
        value={body}
        onChange={(event) => {
          setBody(event.target.value);
        }}
      />
      <div className="flex flex-wrap items-center gap-3">
        {artifact.sessionId !== null && (
          <Checkbox
            label="Send to Pi"
            size="sm"
            checked={toPi}
            onChange={(event) => {
              setToPi(event.target.checked);
            }}
          />
        )}
        <Button type="submit" disabled={body.trim() === ""}>
          {label}
        </Button>
      </div>
      <ErrorText size="caption">{problem}</ErrorText>
    </form>
  );
}
