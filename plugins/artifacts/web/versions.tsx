import { isHttpError } from "@pipoca/plugins";
import { useApi, useLoaded, useNow } from "@pipoca/plugins/web";
import {
  Button,
  cn,
  ErrorText,
  Icon,
  Menu,
  Segmented,
  useConfirm,
} from "@pipoca/ui";
import {
  type KeyboardEvent,
  type ReactElement,
  useDeferredValue,
  useEffect,
  useState,
} from "react";
import { artifacts as plugin } from "../plugin";
import { type ArtifactView, isText, kindLabel } from "../src/artifacts";
import { type DiffLine, lineDiff, type Span, textChanges } from "../src/diff";
import { previewed } from "../src/page";
import {
  audienceLabel,
  byline,
  CloseButton,
  headerClass,
  Lead,
  type Mode,
  Title,
} from "./chrome";
import { base, Frame } from "./collaborate";

async function fetched(
  id: string,
  version: number,
  as: "download" | "view",
): Promise<string> {
  const response = await fetch(
    `${base}/artifacts/${id}/${as}?v=${String(version)}`,
  );

  if (!response.ok) {
    throw new Error(`version ${String(version)} didn't load`);
  }

  return response.text();
}

// A page's text as its frame reads it: every text node outside scripts and
// styles, in order.
function pageText(html: string): string[] {
  const page = new DOMParser().parseFromString(html, "text/html");
  const walker = page.createTreeWalker(page.body, NodeFilter.SHOW_TEXT);
  const pieces: string[] = [];

  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if ((node.parentElement?.closest("script, style") ?? null) === null) {
      pieces.push((node as Text).data);
    }
  }

  return pieces;
}

interface Marks {
  readonly removed: readonly Span[];
  readonly added: readonly Span[];
  readonly before: string;
  readonly after: string;
}

type How = "side" | "source";

// Two versions inside the viewer: both drawn side by side with the words
// that changed marked, or their sources as a diff.
export function Compare({
  artifact,
  mode,
  titleId,
  version,
  onBack,
  onClose,
}: {
  readonly artifact: ArtifactView;
  readonly mode: Mode;
  readonly titleId: string | undefined;
  readonly version: number;
  readonly onBack: () => void;
  readonly onClose: () => void;
}): ReactElement {
  const now = useNow();
  const text = isText(artifact.kind);
  const [how, setHow] = useState<How>("side");

  const [pair, setPair] = useState(() =>
    version > 1
      ? { from: version - 1, to: version }
      : { from: 1, to: Math.min(2, artifact.versions) },
  );

  const { from, to } = pair;
  const key = `${artifact.id}:${String(from)}:${String(to)}`;

  // Marks are a nicety: without them both versions still show.
  const { value: marks } = useLoaded(async (): Promise<Marks | null> => {
    if (!text) {
      return null;
    }

    try {
      const [before, after] = await Promise.all([
        fetched(artifact.id, from, "view").then(pageText),
        fetched(artifact.id, to, "view").then(pageText),
      ]);

      const changes = textChanges(before, after);

      return changes === undefined
        ? null
        : { ...changes, before: before.join(""), after: after.join("") };
    } catch {
      return null;
    }
  }, `${key}:marks`);

  const { value: lines } = useLoaded(
    async (): Promise<readonly DiffLine[] | "long" | "failed"> =>
      how === "source"
        ? Promise.all([
            fetched(artifact.id, from, "download"),
            fetched(artifact.id, to, "download"),
          ]).then(
            ([before, after]) => lineDiff(before, after) ?? "long",
            () => "failed",
          )
        : [],
    `${key}:${how}`,
  );

  const label = (number: number): string =>
    number === artifact.versions
      ? `Version ${String(number)} · latest`
      : `Version ${String(number)}`;

  const picker = (
    side: "from" | "to",
    shown: number,
    other: number,
  ): ReactElement => (
    <Menu
      label={side === "from" ? "Older version" : "Newer version"}
      variant="default"
      size="sm"
      align="end"
      trigger={
        <>
          {label(shown)}
          <Icon name="chevron-down" className="size-3.5" />
        </>
      }
      items={[...artifact.history]
        .reverse()
        .filter((each) => each.number !== other)
        .map((each) => ({
          label: `Version ${String(each.number)}`,
          ...(each.number === artifact.versions && { badge: "latest" }),
          description: byline(each, now),
          checked: each.number === shown,
          run: () => {
            setPair({ ...pair, [side]: each.number });
          },
        }))}
    />
  );

  const strip = (number: number): string => {
    const found = artifact.history[number - 1];

    return found === undefined
      ? `Version ${String(number)}`
      : `Version ${String(number)} · ${byline(found, now)}`;
  };

  return (
    <>
      <header className={headerClass}>
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          aria-label={`Back to version ${String(version)}`}
          onClick={onBack}
        >
          <Icon name="chevron-left" className="size-3.5" />
        </Button>
        <Title
          mode={mode}
          titleId={titleId}
          title={artifact.title}
          line="Comparing two versions"
        />
        {picker("from", from, to)}
        <Icon name="arrow-right" className="size-3.5 text-fg-dim" />
        {picker("to", to, from)}
        {text && (
          <Segmented
            label="Show"
            value={how}
            options={[
              { value: "side", label: "Side by side" },
              { value: "source", label: "Source diff" },
            ]}
            onChange={setHow}
          />
        )}
        {mode === "modal" && <CloseButton onClose={onClose} />}
      </header>
      {how === "side" ? (
        <div className="grid min-h-0 flex-1 grid-cols-2 bg-panel max-md:grid-cols-1">
          {[
            { number: from, kind: "removed" as const },
            { number: to, kind: "added" as const },
          ].map(({ number, kind }) => (
            <section
              key={kind}
              aria-label={`Version ${String(number)}`}
              className="flex min-h-0 flex-col border-line not-last:border-r"
            >
              <p className="border-b border-line bg-hover px-4 py-1.5 text-label text-fg">
                {strip(number)}
              </p>
              <Frame
                artifact={artifact}
                version={number}
                className="min-h-0 flex-1"
                {...(marks !== undefined &&
                  marks !== null && {
                    changes: {
                      kind,
                      spans: marks[kind].map((span) => ({
                        ...span,
                        text: (kind === "removed"
                          ? marks.before
                          : marks.after
                        ).slice(span.start, span.end),
                      })),
                    },
                  })}
              />
            </section>
          ))}
        </div>
      ) : (
        <DiffView lines={lines} />
      )}
    </>
  );
}

const signs: Readonly<Record<DiffLine["kind"], string>> = {
  added: "+",
  removed: "-",
  same: " ",
};

function DiffView({
  lines,
}: {
  readonly lines: readonly DiffLine[] | "long" | "failed" | undefined;
}): ReactElement {
  if (lines === "long" || lines === "failed") {
    return (
      <p className="flex-1 bg-panel p-6 text-fg-dim">
        {lines === "long"
          ? "These versions are too long to compare here. Download both to compare them."
          : "The versions didn't load. Check your connection and try again."}
      </p>
    );
  }

  return (
    <pre
      aria-label="Changes"
      aria-busy={lines === undefined}
      className="min-h-0 flex-1 overflow-auto bg-panel p-4 font-mono text-mono"
    >
      {(lines ?? []).map((line, at) => (
        <div
          key={at}
          className={cn(
            "whitespace-pre-wrap",
            line.kind === "added" && "bg-done/15",
            line.kind === "removed" && "bg-failed/15 text-fg-dim line-through",
          )}
        >
          {`${signs[line.kind]} ${line.text}`}
        </div>
      ))}
    </pre>
  );
}

// A Markdown artifact's source beside the page it makes, saved as a new
// version that Pi hears about. If someone saves meanwhile, the person
// chooses between theirs and that one.
export function Editor({
  artifact,
  mode,
  titleId,
  onDone,
  onClose,
}: {
  readonly artifact: ArtifactView;
  readonly mode: Mode;
  readonly titleId: string | undefined;
  readonly onDone: () => void;
  readonly onClose: () => void;
}): ReactElement {
  const api = useApi(plugin);
  const [editing] = useState(artifact.versions);
  const [original, setOriginal] = useState<string>();
  const [text, setText] = useState<string>();
  const [problem, setProblem] = useState<string>();
  const [refused, setRefused] = useState(false);
  const [confirm, confirmDialog] = useConfirm();
  const preview = useDeferredValue(text ?? "");
  const latest = artifact.history.at(-1);
  const name = latest?.name ?? "artifact.md";
  const stale = refused || artifact.versions > editing;
  const changed = text !== undefined && text !== original;

  useEffect(() => {
    void fetched(artifact.id, editing, "download").then(
      (loaded) => {
        setOriginal(loaded);
        setText(loaded);
      },
      (error: unknown) => {
        setProblem(error instanceof Error ? error.message : String(error));
      },
    );
  }, [artifact.id, editing]);

  const save = async (anyway: boolean): Promise<void> => {
    setProblem(undefined);

    try {
      await api.post(`artifacts/${artifact.id}/versions`, {
        text,
        ...(!anyway && { base: editing }),
      });

      onDone();
    } catch (error) {
      if (isHttpError(error) && error.code === "stale") {
        setRefused(true);
      } else {
        setProblem(error instanceof Error ? error.message : String(error));
      }
    }
  };

  const leave = async (then: () => void): Promise<void> => {
    const sure =
      !changed ||
      (await confirm({
        title: "Discard your changes?",
        description: "What you typed here isn't saved anywhere.",
        confirm: "Discard",
        danger: true,
      }));

    if (sure) {
      then();
    }
  };

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      onKeyDown={(event: KeyboardEvent) => {
        if (event.key === "Escape" && !event.defaultPrevented) {
          // Escape leaves the editor first, not the viewer around it.
          event.preventDefault();
          void leave(onDone);
        }
      }}
    >
      <header className={headerClass}>
        <Lead mode={mode} />
        <Title
          mode={mode}
          titleId={titleId}
          title={artifact.title}
          line={[
            kindLabel(artifact.kind),
            audienceLabel(artifact),
            `editing version ${String(editing)}`,
          ].join(" · ")}
        />
        <Button variant="ghost" size="sm" onClick={() => void leave(onDone)}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="sm"
          disabled={!changed || stale}
          onClick={() => void save(false)}
        >
          Save as version {editing + 1}
        </Button>
        {mode === "modal" && (
          <CloseButton onClose={() => void leave(onClose)} />
        )}
      </header>
      {stale && latest !== undefined && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 border-b border-line bg-hover px-4.5 py-2 text-label text-fg"
        >
          <span className="flex-1">
            {latest.by} saved version {latest.number} while you were editing.
          </span>
          <Button variant="ghost" size="sm" onClick={() => void leave(onDone)}>
            Open version {latest.number}
          </Button>
          <Button size="sm" disabled={!changed} onClick={() => void save(true)}>
            Save anyway as version {artifact.versions + 1}
          </Button>
        </div>
      )}
      {problem !== undefined && (
        <div className="border-b border-line px-4.5 py-2">
          <ErrorText size="caption">{problem}</ErrorText>
        </div>
      )}
      <div className="grid min-h-0 flex-1 grid-cols-2 max-md:grid-cols-1">
        <textarea
          aria-label="Markdown"
          spellCheck
          value={text ?? ""}
          disabled={text === undefined}
          onChange={(event) => {
            setText(event.target.value);
          }}
          className="size-full min-h-0 resize-none border-line bg-elevated p-6 font-mono text-mono text-fg outline-none md:border-r"
        />
        <iframe
          title="Preview"
          sandbox=""
          srcDoc={previewed(name, preview)}
          className="size-full min-h-0 bg-white max-md:hidden"
        />
      </div>
      {confirmDialog}
    </div>
  );
}
