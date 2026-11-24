import {
  defineWeb,
  href,
  type NavItemsProps,
  type NoticeProps,
  type PageProps,
  type SessionAttachProps,
  type SessionPartProps,
  type ToolCallProps,
  useApi,
  useLoaded,
  useOverlay,
} from "@pipoca/plugins/web";
import {
  Button,
  cardClass,
  cn,
  Icon,
  type IconName,
  Page,
  plural,
} from "@pipoca/ui";
import { type ReactElement, useState } from "react";
import { artifacts as plugin } from "../plugin";
import {
  type ArtifactSummary,
  type ArtifactView,
  type Batch,
  type Published,
  typeLabel,
  type Version,
} from "../src/artifacts";
import { ActivityCount, ActivityPage } from "./activity";
import { artifactHref, loadArtifact } from "./collaborate";
import { audienceLabel } from "./chrome";
import { useDock } from "./dock";
import { Gallery } from "./gallery";
import { AttachArtifact, PublishFile, SessionArtifacts } from "./files";
import { StartedCard, StartFromTemplate, TemplatePicker } from "./templates";
import { Audience } from "./slides";
import { PickSystem, ServerSettings, SystemSettings } from "./systems";
import { ArtifactDock, ArtifactLink, ArtifactOverlay, Viewer } from "./viewer";

export const web = defineWeb(plugin, {
  pages: [
    {
      path: "activity",
      label: "Activity",
      icon: "bell",
      Page: ActivityPage,
      nav: { Count: ActivityCount, pinned: true },
    },
    {
      path: "",
      label: "Artifacts",
      Page: ArtifactsPage,
      nav: { fills: (path) => path !== "", Items: Pinned },
      bare: (path) => path !== "",
    },
  ],
  settings: { group: "server", Section: ServerSettings },
  slots: {
    "settings.general": SystemSettings,
    overlay: ArtifactOverlay,
    dock: ArtifactDock,
    "session.panel": SessionArtifacts,
    "session.composer": Waiting,
    "file.actions": PublishFile,
    "session.attach": Attach,
    "project.artifacts": Gallery,
    "session.toolCall:publish_artifact": PublishedCard,
    "session.toolCall:start_artifact": StartedCard,
    "notice:artifact_comments": CommentsNotice,
    "notice:artifact_version": VersionNotice,
  },
});

// The gallery, or one artifact alone in the window from a link to it.
function ArtifactsPage({ path }: PageProps): ReactElement {
  const [id = "", ...rest] = path.split("/");

  if (id === "") {
    return <ArtifactList />;
  }

  if (rest[0] === "audience") {
    return <Audience id={id} />;
  }

  const version = rest[0] === "v" ? Number(rest[1]) : undefined;

  return (
    <Viewer
      key={`${id}/${rest[0] === "comments" ? (rest[1] ?? "") : ""}`}
      id={id}
      mode="window"
      version={version}
      comments={rest[0] === "comments"}
      {...(rest[0] === "comments" &&
        rest[1] !== undefined && { thread: rest[1] })}
      onVersion={(number) => {
        location.replace(artifactHref(id, number));
      }}
      onClose={() => {
        location.hash = href(plugin, "");
      }}
    />
  );
}

function ArtifactList(): ReactElement {
  const [picking, setPicking] = useState(false);

  return (
    <Page
      title="Artifacts"
      description="Pages, documents and pictures Pi published. Each keeps one link and every version."
      actions={
        <Button
          variant="primary"
          onClick={() => {
            setPicking(true);
          }}
        >
          <Icon name="plus" />
          New
        </Button>
      }
    >
      <Gallery />
      <TemplatePicker
        open={picking}
        onClose={() => {
          setPicking(false);
        }}
      />
    </Page>
  );
}

// The composer's + menu rows: an artifact to attach, a template to start
// from, and the design system Pi makes things with here.
function Attach(props: SessionAttachProps): ReactElement {
  return (
    <>
      <AttachArtifact {...props} />
      <StartFromTemplate {...props} />
      <PickSystem {...props} />
    </>
  );
}

// Where Pi published an artifact in the chat. It shows the artifact as it
// is now, and opens it over the chat.
function PublishedCard({ call }: ToolCallProps): ReactElement {
  const api = useApi(plugin);
  const { docked } = useDock();
  const details = call.result?.details as Partial<Published> | undefined;

  const published =
    call.status === "done" && typeof details?.id === "string"
      ? (details as Published)
      : undefined;

  const { value: now } = useLoaded(
    async () =>
      published === undefined
        ? undefined
        : loadArtifact(api, published.id).then((loaded) => {
            if (loaded === "missing") {
              return null;
            }

            return loaded === "failed" ? undefined : loaded;
          }),
    published?.id ?? "",
    { changes: ["artifacts"] },
  );

  const title =
    now?.title ??
    details?.title ??
    (call.args as { title?: string } | undefined)?.title ??
    "Artifact";

  const inside = (
    <FileCardBody
      icon="file-text"
      title={title}
      detail={cardStatus(call, published, now, docked)}
      failed={call.status === "failed"}
    />
  );

  return published !== undefined && now !== null ? (
    <ArtifactLink
      id={published.id}
      className={cn(fileCardClass, "hover:bg-hover")}
    >
      {inside}
      <Icon name="chevron-right" className="text-fg-dim" />
    </ArtifactLink>
  ) : (
    <div className={fileCardClass}>{inside}</div>
  );
}

const noticeClass =
  "rounded-lg border border-dashed border-line px-3 py-1.5 text-label text-fg-dim";

// Threads people sent Pi, as one row in the chat. Their text stays on the
// artifact; the row shows it on demand.
function CommentsNotice({ data }: NoticeProps): ReactElement {
  const api = useApi(plugin);
  const { batch } = (data ?? {}) as { batch?: unknown };
  const id = typeof batch === "string" ? batch : "";

  const { value } = useLoaded(
    async () => api.get<Batch>(`comment-batches/${id}`),
    id,
    { changes: ["artifacts"] },
  );

  const threads = value?.threads ?? [];
  const titles = [...new Set(threads.map(({ title }) => title))];
  const first = threads[0];

  const line =
    value === undefined
      ? "Comment threads sent to Pi"
      : `${value.senders.join(" and ")} sent ${plural(threads.length, "comment thread")} on `;

  return (
    <div className={cn(noticeClass, "relative")}>
      <details className="group">
        <summary
          className={cn(
            "flex min-w-0 list-none items-center gap-2",
            threads.length > 0 && "cursor-pointer",
          )}
        >
          <Icon name="chat" className="size-4 shrink-0" />
          <span className="min-w-0 truncate">
            {line}
            {value !== undefined && (
              <b className="font-medium text-fg">
                {titles.length === 1
                  ? titles[0]
                  : plural(titles.length, "artifact")}
              </b>
            )}
          </span>
          <span className="flex-1" />
          <span className="w-10 shrink-0" />
          {threads.length > 0 && (
            <Icon
              name="chevron-right"
              className="size-4 shrink-0 group-open:rotate-90"
            />
          )}
        </summary>
        <ul
          aria-label="Sent comments"
          className="mt-2 mb-1 flex flex-col gap-2"
        >
          {threads.map(({ comment }) => (
            <li
              key={comment.id}
              className={cn(cardClass, "flex flex-col gap-1 p-3")}
            >
              <span className="text-caption">
                <b className="font-medium text-fg-strong">{comment.author}</b>
                {comment.quote === ""
                  ? " on the whole page"
                  : ` on “${comment.quote}”`}
              </span>
              <p className="break-words whitespace-pre-wrap text-fg">
                {comment.body}
              </p>
            </li>
          ))}
        </ul>
      </details>
      {first !== undefined && (
        <ArtifactLink
          id={first.artifact}
          comments
          className="absolute top-1.5 right-9 text-fg-dim hover:text-fg"
        >
          Open
        </ArtifactLink>
      )}
    </div>
  );
}

// A version a person saved by hand or restored, as one row in the chat. Pi
// reads it as context; no turn starts.
function VersionNotice({ data }: NoticeProps): ReactElement {
  const api = useApi(plugin);

  const { artifact: id, version } = (data ?? {}) as {
    artifact?: unknown;
    version?: unknown;
  };

  const shown = typeof id === "string" ? id : "";
  const number = typeof version === "number" ? version : undefined;

  const { value } = useLoaded(
    async () =>
      shown === ""
        ? null
        : loadArtifact(api, shown).then((loaded) =>
            typeof loaded === "string" ? null : loaded,
          ),
    `${shown}:version`,
    { changes: ["artifacts"] },
  );

  const made = number === undefined ? undefined : value?.history[number - 1];

  return (
    <div className={cn(noticeClass, "flex items-center gap-2")}>
      <Icon name="pencil" className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">
        {made === undefined || value === undefined || value === null ? (
          "A new version of an artifact"
        ) : (
          <>
            {savedLine(value, made)}
            <b className="font-medium text-fg">{value.title}</b>
          </>
        )}
      </span>
      {value !== null && value !== undefined && (
        <ArtifactLink
          id={shown}
          {...(number !== undefined && { version: number })}
          className="shrink-0 text-fg-dim hover:text-fg"
        >
          Open
        </ArtifactLink>
      )}
    </div>
  );
}

// Threads sent while Pi works, which it reads in one more turn once this
// one ends.
function Waiting({ session }: SessionPartProps): ReactElement | null {
  const api = useApi(plugin);

  const { value } = useLoaded(
    async () =>
      api.get<{ threads: number }>("waiting", { session: session.id }),
    `${session.id}:waiting`,
    { changes: ["artifacts"] },
  );

  if (value === undefined || value.threads === 0) {
    return null;
  }

  return (
    <p className="flex min-w-0 items-center gap-2 text-caption text-fg-dim">
      <span className="flex shrink-0 items-center gap-1.5 rounded-full border border-line bg-panel px-2.5 py-1 text-label text-fg">
        <Icon name="chat" className="size-3.5" />
        {plural(value.threads, "more thread")} waiting
      </span>
      <span className="truncate">Pi reads them when this turn ends</span>
    </p>
  );
}

// The artifacts the person pinned, under Artifacts in the sidebar.
function Pinned({ path }: NavItemsProps): ReactElement | null {
  const api = useApi(plugin);
  const { params } = useOverlay();
  const shown = params.get("artifact") ?? path?.split("/")[0];

  const { value } = useLoaded(
    async () =>
      (await api.get<{ artifacts: ArtifactSummary[] }>("pins")).artifacts,
    "pins",
    { changes: ["artifacts"] },
  );

  if (value === undefined || value.length === 0) {
    return null;
  }

  return (
    <ul aria-label="Pinned artifacts" className="flex flex-col">
      {value.map((each) => (
        <li key={each.id}>
          <ArtifactLink
            id={each.id}
            current={shown === each.id}
            className="block truncate rounded-md px-3 py-1 pl-11 text-label text-fg-dim hover:bg-hover hover:text-fg aria-[current=page]:text-fg-strong"
          >
            {each.title}
          </ArtifactLink>
        </li>
      ))}
    </ul>
  );
}

function cardStatus(
  call: ToolCallProps["call"],
  published: Published | undefined,
  now: ArtifactSummary | null | undefined,
  docked: boolean,
): string {
  if (call.status === "running") {
    return "Publishing";
  }

  if (call.status === "failed") {
    return call.result?.text ?? "Not published";
  }

  if (now === null) {
    return "Deleted";
  }

  if (now === undefined) {
    return `Version ${String(published?.version ?? 1)}`;
  }

  return [
    ...(docked ? ["Open beside the chat"] : [typeLabel(now.type)]),
    now.living ? "edited in place" : `version ${String(now.versions)}`,
    ...(docked ? [] : [audienceLabel(now)]),
  ].join(" · ");
}

// Who saved what: on a living doc an edit, or what restoring or accepting
// made; otherwise the version it is.
function savedLine(artifact: ArtifactView, made: Version): string {
  const did =
    made.note.startsWith("restored ") || made.note.startsWith("accepted ");

  if (artifact.living) {
    return did ? `${made.by} ${made.note} in ` : `${made.by} edited `;
  }

  return did
    ? `${made.by} ${made.note} as version ${String(made.number)} of `
    : `${made.by} saved version ${String(made.number)} of `;
}

const fileCardClass = cn(
  cardClass,
  "flex max-w-[420px] min-w-0 items-center gap-3 px-3 py-2.5 text-left",
);

// What a card in the chat says about a file or an artifact.
function FileCardBody({
  icon,
  title,
  detail,
  failed = false,
}: {
  readonly icon: IconName;
  readonly title: string;
  readonly detail: string;
  readonly failed?: boolean;
}): ReactElement {
  return (
    <>
      <span className="grid size-11 shrink-0 place-items-center rounded-lg border border-line bg-panel text-fg-dim">
        <Icon name={icon} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-label font-medium text-fg-strong">
          {title}
        </span>
        <span
          className={cn(
            "truncate text-caption",
            failed ? "text-failed" : "text-fg-dim",
          )}
        >
          {detail}
        </span>
      </span>
    </>
  );
}
