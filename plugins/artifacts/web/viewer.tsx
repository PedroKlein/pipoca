import {
  ago,
  hashParts,
  href,
  useApi,
  useLoaded,
  useNow,
  useOverlay,
} from "@pipoca/plugins/web";
import {
  Button,
  buttonClass,
  cn,
  Dialog,
  ErrorText,
  Icon,
  Mark,
  Menu,
  type MenuItem,
  useConfirm,
} from "@pipoca/ui";
import {
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  useEffect,
  useId,
  useState,
} from "react";
import { artifacts as plugin } from "../plugin";
import type { ArtifactSummary, ArtifactView } from "../src/artifacts";
import {
  artifactHref,
  base,
  Comments,
  Compare,
  Editor,
  Frame,
  loadArtifact,
} from "./collaborate";
import { ShareDialog } from "./share";

type Mode = "modal" | "window";

type Body = "page" | "compare" | "edit";

// A link to an artifact that opens it over the page. Opened in a new tab,
// it shows the artifact alone.
export function ArtifactLink({
  id,
  comments = false,
  className,
  current,
  children,
}: {
  readonly id: string;
  // Opens with its comments beside it.
  readonly comments?: boolean;
  readonly className?: string;
  readonly current?: boolean;
  readonly children: ReactNode;
}): ReactElement {
  const { open } = useOverlay();

  return (
    <a
      href={comments ? href(plugin, `${id}/comments`) : artifactHref(id)}
      aria-current={current === true ? "page" : undefined}
      className={className}
      onClick={(event: MouseEvent) => {
        if (
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) {
          return;
        }

        event.preventDefault();
        open({ artifact: id, ...(comments && { comments: "1" }) });
      }}
    >
      {children}
    </a>
  );
}

// The artifact the address opens over any page, until Esc, Back or Close.
export function ArtifactOverlay(): ReactElement | null {
  const { params, open, close } = useOverlay();
  const titleId = useId();
  const id = params.get("artifact");

  if (id === null || id === "") {
    return null;
  }

  return (
    <Dialog key={id} open size="full" onClose={close} labelledBy={titleId}>
      <Viewer
        id={id}
        mode="modal"
        titleId={titleId}
        version={Number(params.get("v"))}
        comments={params.get("comments") === "1"}
        onVersion={(number) => {
          open(
            {
              artifact: id,
              ...(number !== undefined && { v: String(number) }),
              ...(params.get("comments") === "1" && { comments: "1" }),
            },
            { replace: true },
          );
        }}
        onClose={close}
      />
    </Dialog>
  );
}

// One artifact: its page with a header of what can be done with it, and its
// comments beside it on demand. Over a page, or alone in the window.
export function Viewer({
  id,
  mode,
  version,
  comments: commentsAtFirst = false,
  titleId,
  onVersion,
  onClose,
}: {
  readonly id: string;
  readonly mode: Mode;
  // A version other than the latest, when the address names one.
  readonly version: number | undefined;
  readonly comments?: boolean;
  readonly titleId?: string;
  readonly onVersion: (version: number | undefined) => void;
  readonly onClose: () => void;
}): ReactElement {
  const api = useApi(plugin);

  const { value: loaded, reload } = useLoaded(
    async () => loadArtifact(api, id),
    id,
    { changes: ["artifacts"] },
  );

  // A refresh that fails keeps what's shown, with its drafts and panes.
  const [last, setLast] = useState<ArtifactView>();

  if (typeof loaded === "object" && loaded !== last) {
    setLast(loaded);
  }

  const artifact = loaded === "failed" && last !== undefined ? last : loaded;

  if (artifact === undefined || typeof artifact === "string") {
    return (
      <Placeholder
        mode={mode}
        titleId={titleId}
        state={artifact ?? "loading"}
        onRetry={reload}
        onClose={onClose}
      />
    );
  }

  return (
    <Shown
      artifact={artifact}
      mode={mode}
      shown={
        version !== undefined && Number.isInteger(version) && version >= 1
          ? Math.min(version, artifact.versions)
          : artifact.versions
      }
      commentsAtFirst={commentsAtFirst}
      titleId={titleId}
      onVersion={onVersion}
      onClose={onClose}
    />
  );
}

const placeholders = {
  loading: { title: "Loading…", body: "" },
  missing: {
    title: "This artifact isn't here",
    body: "It was deleted, or it isn't shared with you.",
  },
  failed: {
    title: "The artifact didn't load",
    body: "Check your connection and try again.",
  },
} as const;

// The viewer before there's an artifact to show, still with a way out.
function Placeholder({
  mode,
  titleId,
  state,
  onRetry,
  onClose,
}: {
  readonly mode: Mode;
  readonly titleId: string | undefined;
  readonly state: keyof typeof placeholders;
  readonly onRetry: () => void;
  readonly onClose: () => void;
}): ReactElement {
  const { title, body } = placeholders[state];
  const Heading = headings[mode];

  return (
    <div className={shellClass}>
      <header className={headerClass}>
        <Lead mode={mode} />
        <Heading
          id={titleId}
          aria-busy={state === "loading"}
          className={cn(
            "ml-1.5 flex-1 truncate text-[15px] font-semibold",
            state === "loading" ? "text-fg-dim" : "text-fg-strong",
          )}
        >
          {title}
        </Heading>
        {mode === "modal" && <CloseButton onClose={onClose} />}
      </header>
      <div className="flex flex-1 flex-col items-center justify-center gap-3 bg-panel p-8 text-center">
        {body !== "" && <p className="text-fg-dim">{body}</p>}
        <div className="flex gap-2">
          {state === "failed" && <Button onClick={onRetry}>Try again</Button>}
          {state !== "loading" && mode === "window" && (
            <a href="#" className={buttonClass({})}>
              Go to Pipoca
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

const headings = { modal: "h2", window: "h1" } as const;

const shellClass =
  "flex h-full min-h-0 flex-1 flex-col overflow-hidden rounded-[inherit] bg-elevated";

const headerClass =
  "relative flex min-h-14 flex-wrap items-center gap-1.5 border-b border-line py-2.5 pr-3 pl-4.5";

// Alone in the window, the way back into Pipoca.
function Lead({ mode }: { readonly mode: Mode }): ReactElement {
  return mode === "window" ? (
    <a href="#" aria-label="Pipoca home">
      <Mark className="size-8" />
    </a>
  ) : (
    <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-line bg-panel text-fg-dim">
      <Icon name="file-text" />
    </span>
  );
}

// Focused once the artifact is there, as the placeholder's was.
function CloseButton({
  onClose,
}: {
  readonly onClose: () => void;
}): ReactElement {
  return (
    <Button
      variant="ghost"
      size="sm"
      iconOnly
      aria-label="Close"
      autoFocus
      onClick={onClose}
      className="max-sm:absolute max-sm:top-2.5 max-sm:right-3"
    >
      <Icon name="x" className="size-3.5" />
    </Button>
  );
}

function Shown({
  artifact,
  mode,
  shown,
  commentsAtFirst,
  titleId,
  onVersion,
  onClose,
}: {
  readonly artifact: ArtifactView;
  readonly mode: Mode;
  readonly shown: number;
  readonly commentsAtFirst: boolean;
  readonly titleId: string | undefined;
  readonly onVersion: (version: number | undefined) => void;
  readonly onClose: () => void;
}): ReactElement {
  const api = useApi(plugin);

  // Compare and edit belong to the version they opened on.
  const [opened, setOpened] = useState<{ body: Body; on: number }>({
    body: "page",
    on: shown,
  });

  if (opened.on !== shown) {
    setOpened({ body: "page", on: shown });
  }

  const body = opened.on === shown ? opened.body : "page";

  const setBody = (next: Body): void => {
    setOpened({ body: next, on: shown });
  };

  const [commenting, setCommenting] = useState(commentsAtFirst);
  const [quote, setQuote] = useState("");
  const [sharing, setSharing] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [said, setSaid] = useState<string>();
  const [confirm, confirmDialog] = useConfirm();
  const now = useNow();
  const Heading = headings[mode];
  const latest = shown === artifact.versions;
  const steers = artifact.access === "steer";

  // Marks are a nicety: without them the page still shows.
  const { value: quotes } = useLoaded(
    async () =>
      api
        .get<{ comments: { quote: string; parent: string | null }[] }>(
          `artifacts/${artifact.id}/comments`,
        )
        .then(({ comments }) =>
          comments
            .filter((each) => each.parent === null && each.quote !== "")
            .map((each) => each.quote),
        )
        .catch((): string[] => []),
    `${artifact.id}:quotes`,
    { changes: ["artifacts"] },
  );

  useEffect(() => {
    if (said === undefined) {
      return undefined;
    }

    const timer = setTimeout(() => {
      setSaid(undefined);
    }, 2000);

    return () => {
      clearTimeout(timer);
    };
  }, [said]);

  const acting = async (run: () => Promise<unknown>): Promise<void> => {
    setProblem(undefined);

    try {
      await run();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    }
  };

  const copy = (text: string): void => {
    void acting(async () => {
      await navigator.clipboard.writeText(text);
      setSaid("Link copied");
    });
  };

  const link = (version?: number): string =>
    `${location.origin}${location.pathname}${artifactHref(artifact.id, version)}`;

  const restore = async (): Promise<void> => {
    await acting(async () => {
      await api.post(`artifacts/${artifact.id}/restore`, { version: shown });
      onVersion(undefined);
    });
  };

  const remove = async (): Promise<void> => {
    const yes = await confirm({
      title: `Delete “${artifact.title}”?`,
      description:
        "Every version and comment goes, and links to it stop working. This can't be undone.",
      confirm: "Delete",
      danger: true,
    });

    if (yes) {
      await acting(async () => {
        await api.delete(`artifacts/${artifact.id}`);

        onClose();
      });
    }
  };

  const more: MenuItem[] = [
    {
      label: "Download",
      icon: "download",
      run: () => {
        location.assign(
          `${base}/artifacts/${artifact.id}/download?v=${String(shown)}`,
        );
      },
    },
    {
      label: "Copy link",
      icon: "link",
      run: () => {
        copy(link());
      },
    },
    {
      label: `Copy link to version ${String(shown)}`,
      icon: "link",
      run: () => {
        copy(link(shown));
      },
    },
    {
      label: artifact.pinned ? "Unpin from sidebar" : "Pin to sidebar",
      icon: "pin",
      run: () => {
        void acting(async () =>
          api.put(`artifacts/${artifact.id}/pin`, { pinned: !artifact.pinned }),
        );
      },
    },
    ...(steers && !latest
      ? [
          {
            label: "Restore this version",
            icon: "rotate-ccw" as const,
            run: () => void restore(),
          },
        ]
      : []),
    ...(steers && latest && artifact.kind === "markdown"
      ? [
          {
            label: "Edit",
            icon: "pencil" as const,
            run: () => {
              setBody("edit");
            },
          },
        ]
      : []),
    ...(artifact.sessionId === null
      ? []
      : [
          {
            label: "Go to the Session",
            icon: "chevron-right" as const,
            divided: true,
            run: () => {
              const session = `#${String(artifact.sessionId)}`;

              if (hashParts(location.hash).page === session) {
                onClose();
              } else {
                location.hash = session;
              }
            },
          },
        ]),
    ...(steers
      ? [
          {
            label: "Delete artifact…",
            icon: "trash" as const,
            danger: true,
            divided: true,
            run: () => void remove(),
          },
        ]
      : []),
  ];

  return (
    <div className={shellClass}>
      <header className={headerClass}>
        <Lead mode={mode} />
        <div className="ml-1.5 flex min-w-50 flex-1 flex-col max-sm:pr-8">
          <Heading
            id={titleId}
            className="truncate text-[15px] font-semibold text-fg-strong"
          >
            {artifact.title}
          </Heading>
          <span className="truncate text-caption text-fg-dim">
            {originLine(artifact, mode)}
          </span>
        </div>
        <span role="status" className="text-caption text-fg-dim">
          {said}
        </span>
        <Menu
          label={
            latest
              ? `Version ${String(shown)}, the latest. Versions`
              : `Version ${String(shown)} of ${String(artifact.versions)}. Versions`
          }
          variant="default"
          size="sm"
          align="end"
          trigger={
            <>
              {latest
                ? `Version ${String(shown)} · latest`
                : `Version ${String(shown)} of ${String(artifact.versions)}`}
              <Icon name="chevron-down" className="size-3.5" />
            </>
          }
          items={versionItems(artifact, shown, now, onVersion, () => {
            setBody("compare");
          })}
        />
        <Button
          variant="ghost"
          size="sm"
          aria-pressed={commenting}
          onClick={() => {
            setCommenting(!commenting);
          }}
        >
          <Icon name="chat" className="size-3.5" />
          Comment
          {artifact.openComments > 0 && (
            <span className="text-fg-dim">
              {artifact.openComments}
              <span className="sr-only"> open</span>
            </span>
          )}
        </Button>
        {steers && (
          <Button
            size="sm"
            onClick={() => {
              setSharing(true);
            }}
          >
            Share
          </Button>
        )}
        {mode === "modal" && (
          <a
            href={artifactHref(artifact.id, latest ? undefined : shown)}
            target="_blank"
            rel="noreferrer"
            aria-label="Open in a new tab"
            className={buttonClass({
              variant: "ghost",
              size: "sm",
              iconOnly: true,
              className: "max-sm:hidden",
            })}
          >
            <Icon name="external-link" className="size-3.5" />
          </a>
        )}
        <Menu label="More" size="sm" items={more} />
        {mode === "modal" && <CloseButton onClose={onClose} />}
      </header>
      {!latest && (
        <div className="flex flex-wrap items-center gap-2 border-b border-line bg-hover px-4.5 py-2 text-label text-fg">
          <Icon name="clock" className="size-3.5 text-fg-dim" />
          <span className="flex-1">
            You&apos;re viewing version {shown}. The latest is version{" "}
            {artifact.versions}.
          </span>
          {steers && (
            <Button variant="ghost" size="sm" onClick={() => void restore()}>
              Restore version {shown}
            </Button>
          )}
          <Button
            size="sm"
            onClick={() => {
              onVersion(undefined);
            }}
          >
            Go to latest
          </Button>
        </div>
      )}
      {problem !== undefined && (
        <div className="border-b border-line px-4.5 py-2">
          <ErrorText size="caption">{problem}</ErrorText>
        </div>
      )}
      <div className="flex min-h-0 flex-1 bg-panel">
        <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
          {body === "page" && (
            <Frame
              artifact={artifact}
              version={shown}
              highlights={quotes ?? []}
              className="min-h-0 flex-1"
              onSelect={(text) => {
                setQuote(text);
                setCommenting(true);
              }}
            />
          )}
          {body === "compare" && (
            <div className="flex flex-col gap-3 p-6">
              <Back
                onBack={() => {
                  setBody("page");
                }}
              />
              <Compare artifact={artifact} version={shown} />
            </div>
          )}
          {body === "edit" && (
            <div className="flex flex-col gap-3 p-6">
              <Editor
                artifact={artifact}
                onDone={() => {
                  setBody("page");
                }}
              />
            </div>
          )}
        </div>
        {commenting && (
          <aside
            aria-label="Comments"
            className="flex w-[340px] shrink-0 flex-col gap-4 overflow-y-auto border-l border-line bg-elevated p-4 max-sm:w-full"
          >
            <Comments
              artifact={artifact}
              version={shown}
              quote={quote}
              onQuoted={() => {
                setQuote("");
              }}
            />
          </aside>
        )}
      </div>
      <ShareDialog
        artifact={artifact}
        version={shown}
        open={sharing}
        onClose={() => {
          setSharing(false);
        }}
      />
      {confirmDialog}
    </div>
  );
}

function Back({ onBack }: { readonly onBack: () => void }): ReactElement {
  return (
    <Button variant="ghost" size="sm" className="self-start" onClick={onBack}>
      <Icon name="chevron-left" className="size-3.5" />
      Back to the page
    </Button>
  );
}

function versionItems(
  artifact: ArtifactView,
  shown: number,
  now: number,
  onVersion: (version: number | undefined) => void,
  onCompare: () => void,
): MenuItem[] {
  return [
    ...[...artifact.history].reverse().map((each) => ({
      label: `Version ${String(each.number)}`,
      description: versionLine(each, artifact.versions, now),
      checked: each.number === shown,
      run: () => {
        onVersion(each.number === artifact.versions ? undefined : each.number);
      },
    })),
    ...(artifact.versions > 1
      ? [
          {
            label: "Compare versions…",
            divided: true,
            run: onCompare,
          },
        ]
      : []),
  ];
}

function versionLine(
  version: ArtifactView["history"][number],
  last: number,
  now: number,
): string {
  return [
    ...(version.number === last ? ["latest"] : []),
    version.by,
    ago(new Date(version.createdAt).toISOString(), now),
    ...(version.note === "" ? [] : [version.note]),
  ].join(" · ");
}

// Where it comes from and who opens it. Alone in the window, whose it is
// comes first, since nothing around it says.
function originLine(artifact: ArtifactSummary, mode: Mode): string {
  const from =
    artifact.sessionId === null
      ? []
      : [`“${artifact.sessionTitle ?? "its Session"}”`];

  return mode === "window"
    ? [`By ${artifact.owner}`, ...from.map((each) => `from ${each}`)].join(
        " · ",
      )
    : [...from.map((each) => `From ${each}`), audienceLabel(artifact)].join(
        " · ",
      );
}

export function audienceLabel(artifact: ArtifactSummary): string {
  if (artifact.audience === "team") {
    return "Team";
  }

  if (artifact.audience === "named") {
    return `Shared with ${artifact.sharedWith.join(", ")}`;
  }

  return artifact.yours ? "Only you" : `From ${artifact.owner}`;
}
