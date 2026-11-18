import { isHttpError } from "@pipoca/plugins";
import {
  ago,
  href,
  useApi,
  useLoaded,
  useNow,
  useOverlay,
} from "@pipoca/plugins/web";
import {
  Button,
  buttonClass,
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
  label,
  children,
}: {
  readonly id: string;
  // Opens with its comments beside it.
  readonly comments?: boolean;
  readonly className?: string;
  readonly current?: boolean;
  readonly label?: string;
  readonly children: ReactNode;
}): ReactElement {
  const { open } = useOverlay();

  return (
    <a
      href={artifactHref(id)}
      aria-label={label}
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

  const version = Number(params.get("v"));

  return (
    <Dialog open size="full" onClose={close} labelledBy={titleId}>
      <Viewer
        key={id}
        id={id}
        mode="modal"
        titleId={titleId}
        version={Number.isInteger(version) && version > 0 ? version : undefined}
        comments={params.get("comments") === "1"}
        onVersion={(number) => {
          open(
            {
              artifact: id,
              ...(number !== undefined && { v: String(number) }),
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
  // A version other than the latest, when one is picked.
  readonly version: number | undefined;
  readonly comments?: boolean;
  readonly titleId?: string;
  readonly onVersion: (version: number | undefined) => void;
  readonly onClose: () => void;
}): ReactElement {
  const api = useApi(plugin);

  const { value: artifact } = useLoaded(
    async () =>
      api.get<ArtifactView>(`artifacts/${id}`).catch((error: unknown) => {
        if (isHttpError(error) && error.status === 404) {
          return null;
        }

        throw error;
      }),
    id,
    { changes: ["artifacts"] },
  );

  if (artifact === undefined) {
    return <div className="flex h-full min-h-0 flex-1 flex-col bg-elevated" />;
  }

  if (artifact === null) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 bg-elevated p-8 text-center">
        <h2 id={titleId} className="text-prose font-semibold text-fg-strong">
          This artifact isn&apos;t here
        </h2>
        <p className="text-fg-dim">
          It was deleted, or it isn&apos;t shared with you.
        </p>
        {mode === "modal" && <Button onClick={onClose}>Close</Button>}
      </div>
    );
  }

  return (
    <Shown
      artifact={artifact}
      mode={mode}
      shown={Math.min(version ?? artifact.versions, artifact.versions)}
      commentsAtFirst={commentsAtFirst}
      titleId={titleId}
      onVersion={onVersion}
      onClose={onClose}
    />
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
  const [body, setBody] = useState<Body>("page");
  const [commenting, setCommenting] = useState(commentsAtFirst);
  const [quote, setQuote] = useState("");
  const [sharing, setSharing] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [said, setSaid] = useState<string>();
  const [confirm, confirmDialog] = useConfirm();
  const now = useNow();
  const latest = shown === artifact.versions;
  const steers = artifact.access === "steer";

  const { value: quotes } = useLoaded(
    async () =>
      (
        await api.get<{ comments: { quote: string; parent: string | null }[] }>(
          `artifacts/${artifact.id}/comments`,
        )
      ).comments
        .filter((each) => each.parent === null && each.quote !== "")
        .map((each) => each.quote),
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
    void navigator.clipboard.writeText(text).then(() => {
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

        if (mode === "modal") {
          onClose();
        } else {
          location.hash = href(plugin, "");
        }
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
              location.hash = `#${artifact.sessionId ?? ""}`;
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
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden rounded-[inherit] bg-elevated">
      <header className="flex min-h-14 flex-wrap items-center gap-1.5 border-b border-line py-2.5 pr-3 pl-4.5">
        {mode === "window" ? (
          <Mark className="size-8" />
        ) : (
          <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-line bg-panel text-fg-dim">
            <Icon name="file-text" />
          </span>
        )}
        <div className="ml-1.5 flex min-w-50 flex-1 flex-col">
          <h2
            id={titleId}
            className="truncate text-[15px] font-semibold text-fg-strong"
          >
            {artifact.title}
          </h2>
          <span className="truncate text-caption text-fg-dim">
            {originLine(artifact, mode)}
          </span>
        </div>
        <span role="status" className="text-caption text-fg-dim">
          {said}
        </span>
        <Menu
          label="Versions"
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
          <span className="text-fg-dim">{artifact.openComments}</span>
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
            })}
          >
            <Icon name="external-link" className="size-3.5" />
          </a>
        )}
        <Menu label="More" size="sm" items={more} />
        {mode === "modal" && (
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label="Close"
            onClick={onClose}
          >
            <Icon name="x" className="size-3.5" />
          </Button>
        )}
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
