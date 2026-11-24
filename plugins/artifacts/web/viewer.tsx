import { errorText } from "@pipoca/protocol";
import {
  hashParts,
  href,
  useApi,
  useLoaded,
  useNow,
  sessionHref,
  useOverlay,
  ViewerClose,
  viewerHeaderClass,
  viewerHeadings,
  ViewerLead,
  type ViewerMode,
  viewerShellClass,
  ViewerTitle,
} from "@pipoca/plugins/web";
import {
  Avatar,
  Badge,
  Button,
  buttonClass,
  cn,
  Dialog,
  ErrorText,
  Icon,
  Menu,
  type MenuItem,
  Segmented,
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
  useRef,
  useState,
} from "react";
import { artifacts as plugin } from "../plugin";
import {
  type ArtifactSummary,
  type ArtifactView,
  type Comment,
  saveName,
  versionOf,
} from "../src/artifacts";
import { audienceLabel, shownLine, versionChoices } from "./chrome";
import { artifactHref, base, Frame, loadArtifact } from "./collaborate";
import {
  type Anchor,
  CommentBox,
  CommentList,
  type Listed,
  pinsOf,
  threadsOf,
} from "./comments";
import {
  docLabel,
  DocStatusPill,
  type Outline,
  OutlineNav,
  ReviewBar,
} from "./doc";
import { useDock, usePhone } from "./dock";
import { FolderFiles } from "./folder";
import { usePresence } from "./presence";
import { SaveVersionDialog } from "./save-version";
import {
  type At,
  deckKeys,
  DeckJob,
  DeckView,
  type Export,
  exportItems,
  type Job,
  moved,
  Presenter,
  type Slide,
  SlideGrid,
  slideName,
  typing,
  usePresenting,
  within,
  useShared,
} from "./slides";
import { useSize } from "./size";
import { SaveTemplateDialog } from "./templates";
import { ShareDialog } from "./share";
import { Compare, Editor } from "./versions";

type Body = "page" | "files" | "compare" | "edit" | "grid";

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
  const { params, close } = useOverlay();
  const { docked } = useDock();
  const titleId = useId();
  const id = params.get("artifact");

  if (docked || id === null || id === "") {
    return null;
  }

  return (
    <Dialog key={id} open size="full" onClose={close} labelledBy={titleId}>
      <Addressed id={id} mode="modal" titleId={titleId} />
    </Dialog>
  );
}

// The same, beside the page while docked.
export function ArtifactDock(): ReactElement | null {
  const { params } = useOverlay();
  const { docked } = useDock();
  const titleId = useId();
  const id = params.get("artifact");

  if (!docked || id === null || id === "") {
    return null;
  }

  return (
    <aside
      key={id}
      aria-labelledby={titleId}
      data-dock
      className="flex w-[56%] min-w-0 shrink-0 flex-col border-l border-line bg-elevated"
    >
      <Addressed id={id} mode="docked" titleId={titleId} />
    </aside>
  );
}

function Addressed({
  id,
  mode,
  titleId,
}: {
  readonly id: string;
  readonly mode: ViewerMode;
  readonly titleId: string;
}): ReactElement {
  const { params, open, close } = useOverlay();
  const comments = params.get("comments") === "1";

  return (
    <Viewer
      id={id}
      mode={mode}
      titleId={titleId}
      version={Number(params.get("v"))}
      comments={comments}
      {...(params.get("thread") !== null && {
        thread: params.get("thread") ?? "",
      })}
      onVersion={(number) => {
        open(
          {
            artifact: id,
            ...(number !== undefined && { v: String(number) }),
            ...(comments && { comments: "1" }),
          },
          { replace: true },
        );
      }}
      onClose={close}
    />
  );
}

// One artifact: its page with a header of what can be done with it, and its
// comments beside it on demand. Over a page, or alone in the window.
export function Viewer({
  id,
  mode,
  version,
  comments: commentsAtFirst = false,
  thread: threadAtFirst,
  titleId,
  onVersion,
  onClose,
}: {
  readonly id: string;
  readonly mode: ViewerMode;
  // A version other than the latest, when the address names one.
  readonly version: number | undefined;
  readonly comments?: boolean;
  // The thread open at first, such as one Activity links to.
  readonly thread?: string;
  readonly titleId?: string;
  readonly onVersion: (version: number | undefined) => void;
  readonly onClose: () => void;
}): ReactElement {
  const api = useApi(plugin);
  // Only the first load of an open marks it opened, not the reloads that
  // follow other changes.
  const opened = useRef<string>(undefined);

  const { value: loaded, reload } = useLoaded(
    async () => {
      const first = opened.current !== id;

      opened.current = id;

      return loadArtifact(api, id, { opened: first });
    },
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
      commentsAtFirst={commentsAtFirst || threadAtFirst !== undefined}
      threadAtFirst={threadAtFirst}
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
  readonly mode: ViewerMode;
  readonly titleId: string | undefined;
  readonly state: keyof typeof placeholders;
  readonly onRetry: () => void;
  readonly onClose: () => void;
}): ReactElement {
  const { title, body } = placeholders[state];
  const Heading = viewerHeadings[mode];

  return (
    <div className={viewerShellClass}>
      <header className={viewerHeaderClass}>
        <ViewerLead mode={mode} />
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
        {mode !== "window" && <ViewerClose onClose={onClose} />}
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
  threadAtFirst,
  titleId,
  onVersion,
  onClose,
}: {
  readonly artifact: ArtifactView;
  readonly mode: ViewerMode;
  // The version the address names, or null for the latest.
  readonly asked: number | null;
  readonly shown: number;
  readonly commentsAtFirst: boolean;
  readonly threadAtFirst: string | undefined;
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

  // A version of one file has no files to show.
  const files = artifact.history[shown - 1]?.files ?? 1;

  const deck = artifact.type === "slides";

  const body =
    opened.on !== asked ||
    (opened.body === "files" && files === 1) ||
    (opened.body === "grid" && !deck)
      ? "page"
      : opened.body;

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

  const [active, setActive] = useState(threadAtFirst);
  const [saved, setSaved] = useState<string>();
  const [measured, area] = useSize();
  const [sharing, setSharing] = useState(false);
  const [naming, setNaming] = useState(false);
  const [templating, setTemplating] = useState<"save" | "settings">();
  const [since, setSince] = useState<number>();
  const [problem, setProblem] = useState<string>();
  const [said, setSaid] = useState<string>();
  const [confirm, confirmDialog] = useConfirm();
  const now = useNow();
  const latest = shown === artifact.versions;

  // A version Pi publishes while the person has the artifact open, often
  // answering their threads; what was there when it opened isn't news.
  const [heard, setHeard] = useState(artifact.versions);
  const newest = artifact.history.at(-1);

  const fromPi =
    latest &&
    artifact.versions > heard &&
    newest?.author.startsWith("session:") === true
      ? newest
      : undefined;

  const steers = artifact.access === "steer";
  const dock = useDock();
  const phone = usePhone();
  const compact = phone || mode === "docked";

  // On a phone the comments are a sheet over the page, which can go while
  // comment mode stays for picking a passage.
  const [sheet, setSheet] = useState(true);

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
  const [listed, setListed] = useState<Listed>("open");
  // The page's headings and pins, as the version shown told them.
  const [outline, setOutline] = useState<Outline & { on: string }>();
  const page = `${artifact.id}:${String(shown)}`;
  const told = outline?.on === page ? outline : undefined;
  const [goto, setGoto] = useState<{ section: number }>();
  const { doc } = artifact;
  // Docked or on a phone there's no room beside a doc's page.
  const roomy = doc !== null && !phone && mode !== "docked";

  const margin = useMemo(
    () =>
      roomy && told !== undefined
        ? new Map(
            threads.flatMap(({ top, n }) => {
              const at = told.tops.find((each) => each.n === n);

              return at === undefined
                ? []
                : [[top.id, at.top - told.scrolled] as const];
            }),
          )
        : undefined,
    [roomy, told, threads],
  );

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
      setSheet(true);
      setCommenting(true);
    },
    [threads, setAnchor],
  );

  const stopWriting = useCallback(() => {
    setAnchor(undefined);
  }, [setAnchor]);

  const follow = useCallback((by: { x: number; y: number }) => {
    setOutline((was) =>
      was === undefined ? was : { ...was, scrolled: was.scrolled + by.y },
    );

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
    () => pinsOf(threads, active, anchor),
    [threads, active, anchor],
  );

  const shell = useRef<HTMLDivElement>(null);

  const [reported, setReported] = useState<{
    slides: readonly Slide[];
    duration: string;
    on: string;
  }>();

  const [placed, setPlaced] = useState<{
    pins: readonly { n: number; slide: number }[];
    on: string;
  }>();

  const [mine, setMine] = useState<At>({ slide: 0, step: 0 });
  // The presentation the person stopped following, so the next one is
  // followed again.
  const [unfollowed, setUnfollowed] = useState<string>();
  const [presenting, setPresenting] = useState<number>();
  const [blank, setBlank] = useState(false);
  const [job, setJob] = useState<{ job: Job; at: number }>();
  const live = usePresenting(artifact.id, deck);
  const talk = live === null ? undefined : `${live.by}:${String(live.since)}`;
  const following = live !== null && !live.yours && unfollowed !== talk;
  const presence = usePresence(artifact.id, deck ? following : undefined);
  const elsewhere = live !== null && !live.yours ? live.by : undefined;

  // Following shows the version the presenter has open.
  const presented =
    following && live.version <= artifact.versions ? live.version : undefined;

  useEffect(() => {
    if (presented !== undefined && presented !== shown) {
      onVersion(presented === artifact.versions ? undefined : presented);
    }
  }, [artifact.versions, onVersion, presented, shown]);

  const slides = deck && reported?.on === page ? reported.slides : [];

  const toldDeck = useCallback(
    (next: { slides: readonly Slide[]; duration: string }) => {
      setReported({ ...next, on: page });
    },
    [page],
  );

  const at = within(slides, following ? live : mine);

  const shared = useShared(
    artifact.id,
    presenting === undefined ? undefined : { ...at, version: shown, blank },
  );

  const onSlide = useMemo(
    () => (placed?.on === page ? placed.pins : []),
    [placed, page],
  );

  const counts = useMemo(() => {
    const each = new Map<number, number>();

    for (const { slide } of onSlide) {
      each.set(slide, (each.get(slide) ?? 0) + 1);
    }

    return each;
  }, [onSlide]);

  const go = (next: At): void => {
    setUnfollowed(talk);
    setMine(next);
  };

  const press = (key: string): void => {
    if (key === "click" && following) {
      return;
    }

    const next = moved(slides, at, key);

    if (next !== undefined) {
      go(next);
    }
  };

  const activate = (id: string | undefined): void => {
    setActive(id);

    const n = threads.find(({ top }) => top.id === id)?.n;
    const slide = onSlide.find((each) => each.n === n)?.slide;

    if (slide !== undefined && slide !== at.slide) {
      go({ slide, step: slides[slide]?.steps ?? 0 });
    }
  };

  const present = (): void => {
    void Promise.resolve()
      .then(async () => shell.current?.requestFullscreen())
      .catch(() => undefined);

    setMine(at);
    setBlank(false);
    setPresenting(Date.now());
  };

  const endPresenting = useCallback(() => {
    setPresenting(undefined);

    if (document.fullscreenElement instanceof Element) {
      void document.exitFullscreen().catch(() => undefined);
    }
  }, []);

  useEffect(() => {
    const left = (): void => {
      if (!(document.fullscreenElement instanceof Element)) {
        setPresenting(undefined);
      }
    };

    document.addEventListener("fullscreenchange", left);

    return () => {
      document.removeEventListener("fullscreenchange", left);
    };
  }, []);

  useEffect(() => {
    if (
      !deck ||
      presenting !== undefined ||
      body !== "page" ||
      slides.length === 0
    ) {
      return undefined;
    }

    const pressed = (event: KeyboardEvent): void => {
      const inside =
        event.target instanceof Node &&
        (shell.current?.contains(event.target) === true ||
          (mode === "window" && event.target === document.body));

      if (
        !inside ||
        !deckKeys.has(event.key) ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        typing(event.target) ||
        (event.key === " " &&
          event.target instanceof Element &&
          event.target.closest("button, a") !== null)
      ) {
        return;
      }

      event.preventDefault();
      press(event.key);
    };

    document.addEventListener("keydown", pressed);

    return () => {
      document.removeEventListener("keydown", pressed);
    };
  });

  const jobDone = useCallback((failed?: string) => {
    setJob(undefined);

    if (failed !== undefined) {
      setProblem(failed);
    }
  }, []);

  const exportDeck = (as: Export): void => {
    setProblem(undefined);

    setJob((was) => ({
      job: as === "png" ? { slide: at.slide } : { notes: as === "notes" },
      at: (was?.at ?? 0) + 1,
    }));
  };

  const askPi = async (slide: number | null, text: string): Promise<void> => {
    const on = slide === null ? undefined : slides[slide];

    await api.post(`artifacts/${artifact.id}/comments`, {
      version: shown,
      body: text,
      toPi: true,
      ...(on !== undefined &&
        slide !== null && {
          quote: slideName(slides, slide),
          element: on.selector,
        }),
    });

    setSaid("Sent to Pi");
    reload();
  };

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
      setProblem(errorText(error));
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

  const download = (): void => {
    location.assign(
      `${base}/artifacts/${artifact.id}/download?v=${String(shown)}`,
    );
  };

  const versionLine = shownLine(artifact, shown, now);
  const open = saveName(artifact, shown);
  const edit = versionOf(artifact, shown) === null;

  // The version last approved or decided, while the latest text is newer.
  const approved = latest
    ? artifact.history.findLast(
        ({ label, number }) =>
          number < shown &&
          label !== null &&
          /\b(Approved|Decided) by /.test(label),
      )?.number
    : undefined;

  const versions = versionItems(artifact, shown, now, onVersion, () => {
    setBody("compare");
  });

  const put = (path: string, sent: object): void => {
    void acting(async () => api.put(`artifacts/${artifact.id}/${path}`, sent));
  };

  const downloadLabel = files > 1 ? "Download .zip" : "Download";

  // A folder's page or its files. On a phone it sits under the title, which
  // keeps the header's room.
  const viewSwitch = (
    <Segmented
      label="View"
      value={body === "files" ? "files" : "page"}
      options={[
        { value: "page", label: deck ? "Slides" : "Page" },
        { value: "files", label: `Files ${String(files)}` },
      ]}
      onChange={setBody}
    />
  );

  // On a phone Download is at the bottom, and the files offer their .zip
  // beside them.
  const downloadItem: MenuItem[] =
    phone || body === "files"
      ? []
      : [{ label: downloadLabel, icon: "download", run: download }];

  const more: MenuItem[] = [
    ...(phone ? versions : downloadItem),
    ...(deck
      ? exportItems(exportDeck, { more: true, busy: job !== undefined })
      : []),
    {
      label: "Copy link",
      icon: "link",
      divided: phone,
      run: () => {
        copy(link());
      },
    },
    // The latest text of a living doc has only the one link.
    ...(artifact.living && latest && edit
      ? []
      : [
          {
            label: edit
              ? "Copy link to this edit"
              : `Copy link to ${open.split(" · ")[0]?.toLowerCase() ?? "version"}`,
            icon: "link" as const,
            run: () => {
              copy(link(shown));
            },
          },
        ]),
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
            label: edit ? "Restore this edit" : "Restore this version",
            icon: "rotate-ccw" as const,
            run: () => void restore(),
          },
        ]
      : []),
    ...(steers
      ? [
          doc === null
            ? {
                label: "Mark as design doc",
                icon: "file-text" as const,
                run: () => {
                  put("doc", { type: "design" });
                },
              }
            : {
                label: `Not a ${docLabel(doc).toLowerCase()}`,
                icon: "file-text" as const,
                run: () => {
                  put("doc", { type: null });
                },
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
    ...(steers && latest && artifact.living && edit
      ? [
          {
            label: "Save version…",
            icon: "star" as const,
            run: () => {
              setNaming(true);
            },
          },
        ]
      : []),
    {
      label: "Save as template…",
      icon: "file-text",
      divided: true,
      run: () => {
        setTemplating("save");
      },
    },
    ...(steers && artifact.template !== null
      ? [
          {
            label: "Template settings…",
            icon: "pencil" as const,
            run: () => {
              setTemplating("settings");
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
              const session = sessionHref(String(artifact.sessionId));

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

  const writing = (
    room: { readonly width: number; readonly height: number },
    scale: number,
  ): ReactNode =>
    held !== undefined &&
    anchor !== undefined && (
      <CommentBox
        artifact={artifact}
        version={shown}
        anchor={scaledAnchor(anchor, scale)}
        scrolled={held.scrolled}
        area={room}
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
    );

  const toPage = (): void => {
    setBody("page");
  };

  if (body === "compare") {
    return (
      <div className={viewerShellClass}>
        <Compare
          artifact={artifact}
          mode={mode}
          titleId={titleId}
          version={shown}
          since={since}
          onBack={() => {
            setSince(undefined);
            toPage();
          }}
          onClose={onClose}
        />
      </div>
    );
  }

  if (body === "edit") {
    return (
      <div className={viewerShellClass}>
        <Editor
          artifact={artifact}
          mode={mode}
          titleId={titleId}
          onDone={(published) => {
            if (published !== undefined) {
              setSaid(
                artifact.living
                  ? "Saved"
                  : `Saved as version ${String(published)}`,
              );
            }

            toPage();
          }}
          onClose={onClose}
        />
      </div>
    );
  }

  return (
    <div ref={shell} className={viewerShellClass}>
      <header className={viewerHeaderClass}>
        <ViewerLead mode={mode} />
        <ViewerTitle
          mode={mode}
          titleId={titleId}
          title={artifact.title}
          line={
            phone
              ? versionLine
              : [
                  ...(doc === null ? [] : [docLabel(doc)]),
                  ...(deck
                    ? [
                        "Slides",
                        ...(slides.length > 0
                          ? [
                              `${String(slides.length)} ${slides.length === 1 ? "slide" : "slides"}`,
                            ]
                          : []),
                      ]
                    : []),
                  ...(files > 1 && !deck ? [`${String(files)} files`] : []),
                  originLine(artifact, mode),
                ].join(" · ")
          }
        />
        <span role="status" className="text-caption text-fg-dim">
          {said}
        </span>
        {artifact.template !== null && <Badge>Template</Badge>}
        {doc !== null && (
          <DocStatusPill
            doc={doc}
            steers={steers}
            onStatus={(status) => {
              put("status", { status });
            }}
          />
        )}
        <Here people={presence.people.map(({ name }) => name)} />
        {!phone && (
          <Menu
            label={`${versionLine.replace(" · latest", ", the latest")}. Versions`}
            heading={
              artifact.living
                ? "Versions and edits · every edit is kept"
                : "Versions · every publish is kept"
            }
            variant="default"
            size="sm"
            align="end"
            trigger={
              <>
                {versionLine}
                <Icon name="chevron-down" className="size-3.5" />
              </>
            }
            items={versions}
          />
        )}
        {files > 1 && !phone && viewSwitch}
        {body === "files" && !phone && (
          <Button size="sm" onClick={download}>
            Download .zip
          </Button>
        )}
        {/* Comments are on the page, so the files offer none. */}
        {body === "page" && (
          <Button
            variant={commenting && canComment ? "primary" : "ghost"}
            size="sm"
            aria-pressed={commenting}
            onClick={() => {
              setAnchor(undefined);
              setSheet(true);

              if (!commenting || sheet || !phone) {
                setCommenting(!commenting);
              }
            }}
          >
            <Icon name="chat" className="size-3.5" />
            <span className={compact ? "sr-only" : ""}>
              {canComment ? "Comment" : "Comments"}
            </span>
            {artifact.openComments > 0 && (
              <span className={commenting && canComment ? "" : "text-fg-dim"}>
                {artifact.openComments}
                <span className="sr-only"> open</span>
              </span>
            )}
          </Button>
        )}
        {steers && !phone && (
          <Button
            size="sm"
            onClick={() => {
              setSharing(true);
            }}
          >
            Share
          </Button>
        )}
        {deck && body !== "files" && (
          <>
            <Button
              variant="primary"
              size="sm"
              disabled={
                slides.length === 0 ||
                !canComment ||
                (elsewhere !== undefined && !steers)
              }
              {...(elsewhere !== undefined && {
                title: `${elsewhere} is presenting`,
              })}
              onClick={present}
            >
              <Icon name="play" className="size-3.5" />
              <span className={compact ? "sr-only" : ""}>
                {elsewhere !== undefined && steers ? "Take over" : "Present"}
              </span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              aria-label="All slides"
              aria-pressed={body === "grid"}
              className="aria-pressed:bg-hover aria-pressed:text-fg-strong"
              onClick={() => {
                setBody(body === "grid" ? "page" : "grid");
              }}
            >
              <Icon name="layout-grid" className="size-3.5" />
            </Button>
          </>
        )}
        {mode !== "window" && dock.offered && (
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label="Dock beside the page"
            title={dock.docked ? "Open over the page" : "Dock beside the page"}
            aria-pressed={dock.docked}
            className="aria-pressed:bg-hover aria-pressed:text-fg-strong"
            onClick={() => {
              dock.setDocked(!dock.docked);
            }}
          >
            <Icon name="panel-right" className="size-3.5" />
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
        {mode !== "window" && <ViewerClose onClose={onClose} />}
      </header>
      {!latest && (
        <div className="flex flex-wrap items-center gap-2 border-b border-line bg-hover px-4.5 py-2 text-label text-fg">
          <Icon name="clock" className="size-3.5 text-fg-dim" />
          <span className="flex-1">
            {artifact.living
              ? `You're viewing ${edit ? `an edit by ${artifact.history[shown - 1]?.by ?? "someone"}` : open}, not the latest text.`
              : `You're viewing version ${String(shown)}. The latest is version ${String(artifact.versions)}.`}
          </span>
          {steers && (
            <Button variant="ghost" size="sm" onClick={() => void restore()}>
              {edit
                ? "Restore this edit"
                : `Restore ${open.split(" · ")[0]?.toLowerCase() ?? "version"}`}
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
      <div role="status" className="contents">
        {fromPi !== undefined && (
          <div
            role="group"
            aria-label="New version"
            className="flex flex-wrap items-center gap-2 border-b border-line bg-done-tint px-4.5 py-2 text-label text-fg"
          >
            <Icon name="check" className="size-3.5 text-done" />
            <span className="min-w-0 flex-1 truncate">
              {fromPi.by} published version {fromPi.number}
              {fromPi.note !== "" && ` · “${fromPi.note}”`}
            </span>
            {fromPi.number > 1 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setHeard(fromPi.number);
                  setBody("compare");
                }}
              >
                Compare with {fromPi.number - 1}
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              aria-label="Dismiss"
              onClick={() => {
                setHeard(fromPi.number);
              }}
            >
              <Icon name="x" className="size-3.5" />
            </Button>
          </div>
        )}
      </div>
      {deck && live !== null && !live.yours && (
        <div
          role="group"
          aria-label="Presenting"
          aria-live="polite"
          className="flex flex-wrap items-center gap-2 border-b border-line bg-hover px-4.5 py-2 text-label text-fg"
        >
          <Icon name="monitor" className="size-3.5 text-fg-dim" />
          <span className="min-w-0 flex-1 truncate">
            {live.by} is presenting
            {following
              ? `, on slide ${String(at.slide + 1)}. You follow their slide.`
              : "."}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setMine(at);
              setUnfollowed(following ? talk : undefined);
            }}
          >
            {following ? "Stop following" : `Follow ${live.by}`}
          </Button>
        </div>
      )}
      {doc !== null && (
        <ReviewBar
          doc={doc}
          threads={threads}
          people={people ?? []}
          steers={steers}
          onReviewers={(reviewers) => {
            put("reviewers", { reviewers });
          }}
          onVerdict={(verdict) => {
            put("review", { verdict });
          }}
          onSinceApproval={
            approved === undefined
              ? undefined
              : () => {
                  setSince(approved);
                  setBody("compare");
                }
          }
        />
      )}
      {problem !== undefined && (
        <div className="border-b border-line px-4.5 py-2">
          <ErrorText size="caption">{problem}</ErrorText>
        </div>
      )}
      {files > 1 && phone && (
        <div className="flex border-b border-line px-3 py-2">{viewSwitch}</div>
      )}
      {body === "files" && <FolderFiles artifact={artifact} version={shown} />}
      {body === "grid" && (
        <Frame
          artifact={artifact}
          version={shown}
          onDeck={toldDeck}
          unseen
          className="pointer-events-none fixed top-0 -left-[200vw] border-0"
          style={{ width: 1280, height: 720 }}
        />
      )}
      {body === "grid" && (
        <SlideGrid
          artifact={artifact}
          version={shown}
          slides={slides}
          at={at}
          counts={counts}
          askable={artifact.askable && latest}
          onOpen={(slide) => {
            if (slide !== at.slide) {
              go({ slide, step: 0 });
            }

            setBody("page");
          }}
          onAsk={askPi}
          onExport={exportDeck}
          exporting={job !== undefined}
        />
      )}
      {body === "page" && (
        <div className="flex min-h-0 flex-1 bg-panel">
          {roomy && (
            <OutlineNav
              outline={told}
              threads={threads}
              onSection={(section) => {
                setGoto({ section });
              }}
              onQuestions={() => {
                setListed("questions");
                setActive(undefined);
                setSheet(true);
                setCommenting(true);
              }}
            />
          )}
          {deck ? (
            <DeckView
              artifact={artifact}
              version={shown}
              slides={slides}
              at={at}
              counts={counts}
              onGo={(slide) => {
                go({ slide, step: 0 });
              }}
              onKey={press}
              stage={(style) => (
                <>
                  <Frame
                    artifact={artifact}
                    version={shown}
                    commenting={commenting && canComment}
                    pins={pins}
                    onPick={(picked) => {
                      pick(
                        "label" in picked
                          ? {
                              ...picked,
                              label: `Slide ${String(at.slide + 1)}: ${picked.label}`,
                            }
                          : picked,
                      );
                    }}
                    onPin={showPin}
                    onEscape={stopWriting}
                    onDeck={toldDeck}
                    onPinned={(next) => {
                      setPlaced({ pins: next, on: page });
                    }}
                    onKey={press}
                    slide={at}
                    className="border-0"
                    style={style}
                  />
                  {following && live.blank && (
                    <div
                      role="img"
                      aria-label={`${live.by} blanked the screen`}
                      className="absolute inset-0 bg-blank"
                    />
                  )}
                </>
              )}
              writing={writing}
            />
          ) : (
            <div
              ref={measured}
              className="relative flex min-w-0 flex-1 flex-col overflow-hidden"
            >
              <Frame
                artifact={artifact}
                version={shown}
                commenting={commenting && canComment}
                pins={pins}
                badges={
                  !(
                    roomy &&
                    commenting &&
                    listed === "open" &&
                    active === undefined
                  )
                }
                className="min-h-0 flex-1"
                onPick={pick}
                onPin={showPin}
                onEscape={stopWriting}
                onScroll={follow}
                onOutline={(next) => {
                  setOutline({ ...next, on: page });
                }}
                goto={goto}
              />
              {writing(area, 1)}
            </div>
          )}
          {commenting && sheet && phone && (
            <button
              type="button"
              aria-label="Back to the page"
              className="fixed inset-0 z-10 bg-scrim"
              onClick={() => {
                setSheet(false);
              }}
            />
          )}
          {commenting && (sheet || !phone) && (
            <aside
              aria-label="Comments"
              className={cn(
                "flex w-[420px] shrink-0 flex-col border-l border-line max-sm:fixed max-sm:inset-x-0 max-sm:bottom-0 max-sm:z-10 max-sm:h-[70dvh] max-sm:w-full max-sm:rounded-t-2xl max-sm:border-t max-sm:border-l-0 max-sm:shadow-pop",
                roomy ? "bg-panel" : "bg-elevated",
              )}
            >
              {phone && (
                <span
                  aria-hidden
                  className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-line-strong"
                />
              )}
              <CommentList
                artifact={artifact}
                version={shown}
                threads={threads}
                onPage={
                  told === undefined
                    ? undefined
                    : new Set(told.tops.map(({ n }) => n))
                }
                shown={listed}
                onShown={setListed}
                margin={margin}
                loaded={
                  comments === "failed" ? "failed" : comments !== undefined
                }
                anchor={anchor}
                active={active}
                saved={saved}
                onFocused={() => {
                  setSaved(undefined);
                }}
                onSaid={setSaid}
                onActive={activate}
                onWholePage={() => {
                  const on = slides[at.slide];

                  setAnchor(
                    on === undefined
                      ? { page: true }
                      : {
                          element: on.selector,
                          label: slideName(slides, at.slide),
                          rect: { x: 24, y: 24, width: 0, height: 0 },
                        },
                  );
                }}
                onChanged={reload}
                people={people ?? []}
                presence={presence.people}
                onTyping={presence.typing}
              />
            </aside>
          )}
        </div>
      )}
      {phone && (
        <div
          role="group"
          aria-label="Artifact actions"
          className="flex gap-3 border-t border-line p-3 *:h-11"
        >
          {steers && (
            <Button
              className="flex-1"
              onClick={() => {
                setSharing(true);
              }}
            >
              Share
            </Button>
          )}
          <Button className="flex-1" onClick={download}>
            {downloadLabel}
          </Button>
        </div>
      )}
      <ShareDialog
        key={artifact.id}
        artifact={artifact}
        version={shown}
        open={sharing}
        onClose={() => {
          setSharing(false);
        }}
      />
      <SaveTemplateDialog
        artifact={artifact}
        settings={templating === "settings"}
        open={templating !== undefined}
        onSaved={(line) => {
          setTemplating(undefined);
          setSaid(line);
        }}
        onClose={() => {
          setTemplating(undefined);
        }}
      />
      <SaveVersionDialog
        artifact={artifact}
        open={naming}
        onSaved={(label) => {
          setNaming(false);
          setSaid(`Saved as a version: ${label}`);
        }}
        onClose={() => {
          setNaming(false);
        }}
      />
      {presenting !== undefined && (
        <Presenter
          artifact={artifact}
          version={shown}
          slides={slides}
          at={at}
          blank={blank}
          duration={reported?.duration ?? ""}
          following={
            presence.people.filter((each) => each.following === true).length
          }
          asked={threads
            .filter(({ top }) => top.createdAt >= presenting)
            .map(({ top, n }) => ({
              id: top.id,
              author: top.author,
              body: top.body,
              slide: onSlide.find((each) => each.n === n)?.slide,
            }))}
          problem={shared}
          onKey={press}
          onBlank={setBlank}
          onEnd={endPresenting}
        />
      )}
      {job !== undefined && (
        <DeckJob
          key={job.at}
          artifact={artifact}
          version={shown}
          job={job.job}
          onDone={jobDone}
        />
      )}
      {confirmDialog}
    </div>
  );
}

function scaledAnchor(anchor: Anchor, scale: number): Anchor {
  if (scale === 1 || !("rect" in anchor)) {
    return anchor;
  }

  const { x, y, width, height } = anchor.rect;

  return {
    ...anchor,
    rect: {
      x: x * scale,
      y: y * scale,
      width: width * scale,
      height: height * scale,
    },
  };
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
function originLine(artifact: ArtifactSummary, mode: ViewerMode): string {
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
