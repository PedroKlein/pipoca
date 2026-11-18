import {
  hashParts,
  href,
  useApi,
  useLoaded,
  useNow,
  useOverlay,
} from "@pipoca/plugins/web";
import {
  Avatar,
  Button,
  buttonClass,
  cn,
  Dialog,
  ErrorText,
  Icon,
  Menu,
  type MenuItem,
  useConfirm,
} from "@pipoca/ui";
import {
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
} from "react";
import { artifacts as plugin } from "../plugin";
import type { ArtifactSummary, ArtifactView, Comment } from "../src/artifacts";
import {
  audienceLabel,
  CloseButton,
  headerClass,
  headings,
  Lead,
  type Mode,
  shellClass,
  Title,
  versionChoices,
} from "./chrome";
import { artifactHref, base, Frame, loadArtifact } from "./collaborate";
import {
  type Anchor,
  CommentBox,
  CommentList,
  pinsOf,
  threadsOf,
} from "./comments";
import { usePresence } from "./presence";
import { ShareDialog } from "./share";
import { Compare, Editor } from "./versions";

type Body = "page" | "compare" | "edit";

// A link to an artifact that opens it over the page. Opened in a new tab,
// it shows the artifact alone.
export function ArtifactLink({
  id,
  version,
  comments = false,
  className,
  current,
  children,
}: {
  readonly id: string;
  // A version other than the latest.
  readonly version?: number;
  // Opens with its comments beside it.
  readonly comments?: boolean;
  readonly className?: string;
  readonly current?: boolean;
  readonly children: ReactNode;
}): ReactElement {
  const { open } = useOverlay();

  return (
    <a
      href={
        comments ? href(plugin, `${id}/comments`) : artifactHref(id, version)
      }
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

        open({
          artifact: id,
          ...(version !== undefined && { v: String(version) }),
          ...(comments && { comments: "1" }),
        });
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

  const asked =
    version !== undefined && Number.isInteger(version) && version >= 1
      ? version
      : null;

  return (
    <Shown
      artifact={artifact}
      mode={mode}
      asked={asked}
      shown={
        asked === null ? artifact.versions : Math.min(asked, artifact.versions)
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

function Shown({
  artifact,
  mode,
  asked,
  shown,
  commentsAtFirst,
  titleId,
  onVersion,
  onClose,
}: {
  readonly artifact: ArtifactView;
  readonly mode: Mode;
  // The version the address names, or null for the latest.
  readonly asked: number | null;
  readonly shown: number;
  readonly commentsAtFirst: boolean;
  readonly titleId: string | undefined;
  readonly onVersion: (version: number | undefined) => void;
  readonly onClose: () => void;
}): ReactElement {
  const api = useApi(plugin);

  // Compare and edit belong to the address they opened on: Back leaves
  // them, and a version someone publishes meanwhile doesn't.
  const [opened, setOpened] = useState<{ body: Body; on: number | null }>({
    body: "page",
    on: asked,
  });

  if (opened.on !== asked) {
    setOpened({ body: "page", on: asked });
  }

  const body = opened.on === asked ? opened.body : "page";

  const setBody = (next: Body): void => {
    setOpened({ body: next, on: asked });
  };

  const [commenting, setCommenting] = useState(commentsAtFirst);

  // What's being commented on belongs to the version it was picked on, and
  // the box follows the page as it scrolls.
  const [held, setHeld] = useState<{
    anchor: Anchor;
    on: number;
    scrolled: { x: number; y: number };
  }>();

  if (held !== undefined && held.on !== shown) {
    setHeld(undefined);
  }

  const anchor = held?.on === shown ? held.anchor : undefined;

  const setAnchor = useCallback(
    (next: Anchor | undefined) => {
      setHeld(
        next === undefined
          ? undefined
          : { anchor: next, on: shown, scrolled: { x: 0, y: 0 } },
      );
    },
    [shown],
  );

  const [active, setActive] = useState<string>();
  const [saved, setSaved] = useState<string>();
  const [measured, area] = useSize();
  const [sharing, setSharing] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [said, setSaid] = useState<string>();
  const [confirm, confirmDialog] = useConfirm();
  const now = useNow();
  const latest = shown === artifact.versions;
  const steers = artifact.access === "steer";

  // Without comments the page still shows.
  const { value: comments, reload } = useLoaded(
    async () =>
      api
        .get<{ comments: Comment[] }>(`artifacts/${artifact.id}/comments`)
        .then(({ comments: all }) => all)
        .catch(() => "failed" as const),
    `${artifact.id}:comments`,
    { changes: ["artifacts"] },
  );

  const presence = usePresence(artifact.id);

  const { value: people } = useLoaded(
    async () =>
      api
        .get<{ people: string[] }>(`artifacts/${artifact.id}/people`)
        .then(({ people: all }) => all)
        .catch((): string[] => []),
    `${artifact.id}:people`,
    { changes: ["artifacts"] },
  );

  const threads = useMemo(
    () =>
      comments === undefined || comments === "failed"
        ? []
        : threadsOf(comments),
    [comments],
  );

  const canComment = artifact.access !== "view";

  // Only while commenting: a page can't open the box on its own.
  const pick = useCallback(
    (picked: Anchor) => {
      if (canComment && commenting) {
        setAnchor(picked);
        setActive(undefined);
      }
    },
    [canComment, commenting, setAnchor],
  );

  const showPin = useCallback(
    (n: number) => {
      setActive(threads.find((each) => each.n === n)?.top.id);

      setAnchor(undefined);
      setCommenting(true);
    },
    [threads, setAnchor],
  );

  const stopWriting = useCallback(() => {
    setAnchor(undefined);
  }, [setAnchor]);

  const follow = useCallback((by: { x: number; y: number }) => {
    setHeld((was) =>
      was === undefined
        ? was
        : {
            ...was,
            scrolled: { x: was.scrolled.x + by.x, y: was.scrolled.y + by.y },
          },
    );
  }, []);

  const pins = useMemo(
    () => pinsOf(threads, shown, active, anchor),
    [threads, shown, active, anchor],
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

  const toPage = (): void => {
    setBody("page");
  };

  if (body === "compare") {
    return (
      <div className={shellClass}>
        <Compare
          artifact={artifact}
          mode={mode}
          titleId={titleId}
          version={shown}
          onBack={toPage}
          onClose={onClose}
        />
      </div>
    );
  }

  if (body === "edit") {
    return (
      <div className={shellClass}>
        <Editor
          artifact={artifact}
          mode={mode}
          titleId={titleId}
          onDone={(published) => {
            if (published !== undefined) {
              setSaid(`Saved as version ${String(published)}`);
            }

            toPage();
          }}
          onClose={onClose}
        />
      </div>
    );
  }

  return (
    <div className={shellClass}>
      <header className={headerClass}>
        <Lead mode={mode} />
        <Title
          mode={mode}
          titleId={titleId}
          title={artifact.title}
          line={originLine(artifact, mode)}
        />
        <span role="status" className="text-caption text-fg-dim">
          {said}
        </span>
        <Here people={presence.people.map(({ name }) => name)} />
        <Menu
          label={
            latest
              ? `Version ${String(shown)}, the latest. Versions`
              : `Version ${String(shown)} of ${String(artifact.versions)}. Versions`
          }
          heading="Versions · every publish is kept"
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
          variant={commenting && canComment ? "primary" : "ghost"}
          size="sm"
          aria-pressed={commenting}
          onClick={() => {
            setCommenting(!commenting);
            setAnchor(undefined);
          }}
        >
          <Icon name="chat" className="size-3.5" />
          {canComment ? "Comment" : "Comments"}
          {artifact.openComments > 0 && (
            <span className={commenting && canComment ? "" : "text-fg-dim"}>
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
        <div
          ref={measured}
          className="relative flex min-w-0 flex-1 flex-col overflow-hidden"
        >
          <Frame
            artifact={artifact}
            version={shown}
            commenting={commenting && canComment}
            pins={pins}
            className="min-h-0 flex-1"
            onPick={pick}
            onPin={showPin}
            onEscape={stopWriting}
            onScroll={follow}
          />
          {held !== undefined && anchor !== undefined && (
            <CommentBox
              artifact={artifact}
              version={shown}
              anchor={anchor}
              scrolled={held.scrolled}
              area={area}
              people={people ?? []}
              onDone={(done) => {
                setAnchor(undefined);

                if (done !== undefined) {
                  setSaved(done.id);
                  setSaid(savedLine(artifact, done.sentToPi));
                  reload();
                }
              }}
            />
          )}
        </div>
        {commenting && (
          <aside
            aria-label="Comments"
            className="flex w-[420px] shrink-0 flex-col border-l border-line bg-elevated max-sm:w-full"
          >
            <CommentList
              artifact={artifact}
              version={shown}
              threads={threads}
              loaded={comments === "failed" ? "failed" : comments !== undefined}
              anchor={anchor}
              active={active}
              saved={saved}
              onFocused={() => {
                setSaved(undefined);
              }}
              onSaid={setSaid}
              onActive={setActive}
              onWholePage={() => {
                setAnchor({ page: true });
              }}
              onChanged={reload}
              people={people ?? []}
              presence={presence.people}
              onTyping={presence.typing}
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

// The others looking at the artifact now.
function Here({
  people,
}: {
  readonly people: readonly string[];
}): ReactElement | null {
  if (people.length === 0) {
    return null;
  }

  return (
    <span
      role="img"
      aria-label={`Also here: ${people.join(", ")}`}
      title={`Also here: ${people.join(", ")}`}
      className="flex -space-x-1.5"
    >
      {people.slice(0, 3).map((name, at) => (
        <Avatar
          key={`${String(at)}:${name}`}
          name={name}
          size="xs"
          className="ring-2 ring-elevated"
        />
      ))}
      {people.length > 3 && (
        <Avatar
          name={`+${String(people.length - 3)}`}
          size="xs"
          className="ring-2 ring-elevated"
        >
          {`+${String(people.length - 3)}`}
        </Avatar>
      )}
    </span>
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
    ...versionChoices(artifact, now, shown, (number) => {
      onVersion(number === artifact.versions ? undefined : number);
    }),
    ...(artifact.versions > 1
      ? [
          {
            label: "Compare versions…",
            icon: "arrow-up-down" as const,
            divided: true,
            run: onCompare,
          },
        ]
      : []),
  ];
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

function savedLine(artifact: ArtifactView, sentToPi: boolean): string {
  if (sentToPi) {
    return "Sent to Pi";
  }

  return artifact.askable ? "Saved as a draft for Pi" : "Comment saved";
}

// An element's size as it changes, such as the frame the comment box sits
// in.
function useSize(): readonly [
  (element: HTMLDivElement | null) => void,
  { readonly width: number; readonly height: number },
] {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    if (element === null || typeof ResizeObserver === "undefined") {
      return undefined;
    }

    const observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined) {
        setSize({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        });
      }
    });

    observer.observe(element);

    return () => {
      observer.disconnect();
    };
  }, [element]);

  return [setElement, size] as const;
}
