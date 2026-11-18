import {
  ago,
  defineWeb,
  href,
  type NavItemsProps,
  type NoticeProps,
  type PageProps,
  type ToolCallProps,
  useApi,
  useLoaded,
  useNow,
  useOverlay,
} from "@pipoca/plugins/web";
import {
  Badge,
  cardClass,
  cn,
  EmptyState,
  Icon,
  Page,
  plural,
  Row,
  Rows,
  Segmented,
  TextInput,
} from "@pipoca/ui";
import { type ReactElement, useState } from "react";
import { artifacts as plugin } from "../plugin";
import {
  type ArtifactSummary,
  type Batch,
  kindLabel,
  type Published,
} from "../src/artifacts";
import { artifactHref, loadArtifact } from "./collaborate";
import { audienceLabel } from "./chrome";
import { ArtifactLink, ArtifactOverlay, Viewer } from "./viewer";

export const web = defineWeb(plugin, {
  pages: [
    {
      path: "",
      label: "Artifacts",
      Page: ArtifactsPage,
      nav: { fills: (path) => path !== "", Items: Pinned },
      bare: (path) => path !== "",
    },
  ],
  settings: { group: "server", form: "auto" },
  slots: {
    overlay: ArtifactOverlay,
    "session.toolCall:publish_artifact": PublishedCard,
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

  const version = rest[0] === "v" ? Number(rest[1]) : undefined;

  return (
    <Viewer
      key={id}
      id={id}
      mode="window"
      version={version}
      comments={rest[0] === "comments"}
      onVersion={(number) => {
        location.replace(artifactHref(id, number));
      }}
      onClose={() => {
        location.hash = href(plugin, "");
      }}
    />
  );
}

type Shelf = "yours" | "shared" | "team";

const shelves: Readonly<Record<Shelf, (artifact: ArtifactSummary) => boolean>> =
  {
    yours: (artifact) => artifact.audience !== "team" && artifact.yours,
    shared: (artifact) => artifact.audience !== "team" && !artifact.yours,
    team: (artifact) => artifact.audience === "team",
  };

const emptyShelves: Readonly<Record<Shelf, string>> = {
  yours:
    "Nothing yet. When Pi publishes something from your Sessions, it shows here.",
  shared: "No one has shared an artifact with you yet.",
  team: "No team work has published anything yet.",
};

function ArtifactList(): ReactElement {
  const api = useApi(plugin);
  const now = useNow();
  const [shelf, setShelf] = useState<Shelf>("yours");
  const [search, setSearch] = useState("");

  const { value } = useLoaded(
    async () =>
      (await api.get<{ artifacts: ArtifactSummary[] }>("artifacts")).artifacts,
    "list",
    { changes: ["artifacts"] },
  );

  const words = search.toLowerCase().split(/\s+/).filter(Boolean);

  const shown = (value ?? [])
    .filter(shelves[shelf])
    .filter((each) =>
      words.every((word) =>
        `${each.title} ${each.sessionTitle ?? ""}`.toLowerCase().includes(word),
      ),
    );

  return (
    <Page
      title="Artifacts"
      description="Pages, documents and pictures Pi published. Each keeps one link and every version."
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <TextInput
            type="search"
            aria-label="Search"
            placeholder="Search titles and Sessions"
            className="min-w-0 flex-1"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
            }}
          />
          <Segmented
            label="Show"
            value={shelf}
            options={[
              { value: "yours", label: "Yours" },
              { value: "shared", label: "Shared with you" },
              { value: "team", label: "Team" },
            ]}
            onChange={setShelf}
          />
        </div>
        {value !== undefined && shown.length === 0 ? (
          <EmptyState>
            {words.length > 0 ? "Nothing matches." : emptyShelves[shelf]}
          </EmptyState>
        ) : (
          <Rows label="Artifacts">
            {shown.map((each) => (
              <Row
                key={each.id}
                title={
                  <span className="flex items-center gap-2">
                    <ArtifactLink
                      id={each.id}
                      className="text-fg-strong hover:underline"
                    >
                      {each.title}
                    </ArtifactLink>
                    {each.openComments > 0 && (
                      <Badge>{plural(each.openComments, "comment")}</Badge>
                    )}
                  </span>
                }
                description={galleryLine(each, now)}
              >
                <span className="ml-auto text-caption text-fg-dim">
                  {audienceLabel(each)}
                </span>
              </Row>
            ))}
          </Rows>
        )}
        <p className="text-caption text-fg-dim">
          Pi finds these with list_artifacts and a search. It never gets the
          whole list.
        </p>
      </div>
    </Page>
  );
}

// Where Pi published an artifact in the chat. It shows the artifact as it
// is now, and opens it over the chat.
function PublishedCard({ call }: ToolCallProps): ReactElement {
  const api = useApi(plugin);
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
    <>
      <span className="grid size-11 shrink-0 place-items-center rounded-lg border border-line bg-panel text-fg-dim">
        <Icon name="file-text" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-label font-medium text-fg-strong">
          {title}
        </span>
        <span
          className={
            call.status === "failed"
              ? "truncate text-caption text-failed"
              : "truncate text-caption text-fg-dim"
          }
        >
          {cardStatus(call, published, now)}
        </span>
      </span>
    </>
  );

  const card = cn(
    cardClass,
    "flex max-w-[420px] items-center gap-3 px-3 py-2.5",
  );

  return published !== undefined && now !== null ? (
    <ArtifactLink id={published.id} className={cn(card, "hover:bg-hover")}>
      {inside}
      <Icon name="chevron-right" className="text-fg-dim" />
    </ArtifactLink>
  ) : (
    <div className={card}>{inside}</div>
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
                  ? ` on version ${String(comment.version)}`
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
            {made.note.startsWith("restored ")
              ? `${made.by} ${made.note} as version ${String(made.number)} of `
              : `${made.by} saved version ${String(made.number)} of `}
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
    kindLabel(now.kind),
    `version ${String(now.versions)}`,
    audienceLabel(now),
  ].join(" · ");
}

function galleryLine(artifact: ArtifactSummary, now: number): string {
  return [
    kindLabel(artifact.kind),
    `v${String(artifact.versions)}`,
    ago(new Date(artifact.updatedAt).toISOString(), now),
  ].join(" · ");
}
