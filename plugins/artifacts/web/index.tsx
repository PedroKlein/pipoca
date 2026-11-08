import {
  defineWeb,
  href,
  type MountedSession,
  SessionTab,
  type NavItemsProps,
  type PageProps,
  type ToolCallProps,
  useApi,
  useLoaded,
  useNow,
} from "@pipoca/plugins/web";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Icon,
  Page,
  plural,
  Row,
  Rows,
  Segmented,
  Select,
  TextInput,
} from "@pipoca/ui";
import { type ReactElement, useState } from "react";
import { artifacts as plugin } from "../plugin";
import {
  type ArtifactSummary,
  type ArtifactView,
  kindLabel,
  type Published,
} from "../src/artifacts";
import { Frame } from "./collaborate";
import {
  ArtifactPage,
  audienceLabel,
  galleryLine,
  ShareDialog,
  versionHref,
} from "./page";

export const web = defineWeb(plugin, {
  pages: [
    {
      path: "",
      label: "Artifacts",
      Page: ArtifactsPage,
      nav: { fills: (path) => path !== "", Items: Pinned },
    },
  ],
  settings: { group: "server", form: "auto" },
  slots: {
    "session.header": SessionArtifacts,
    "session.toolCall:publish_artifact": PublishedCard,
  },
});

function ArtifactsPage({ path }: PageProps): ReactElement {
  const [id = "", ...rest] = path.split("/");

  if (id === "") {
    return <ArtifactList />;
  }

  return rest[0] === "v" ? (
    <ArtifactPage key={id} id={id} version={Number(rest[1])} />
  ) : (
    <ArtifactPage
      key={id}
      id={id}
      version={undefined}
      {...(rest[0] === "comments" && { rail: "comments" as const })}
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
                    <a
                      href={href(plugin, each.id)}
                      className="text-fg-strong hover:underline"
                    >
                      {each.title}
                    </a>
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

// Where Pi published an artifact in the chat.
function PublishedCard({ call }: ToolCallProps): ReactElement {
  const details = call.result?.details as Partial<Published> | undefined;

  const published =
    call.status === "done" && typeof details?.id === "string"
      ? (details as Published)
      : undefined;

  const title =
    details?.title ??
    (call.args as { title?: string } | undefined)?.title ??
    "Artifact";

  return (
    <Card
      padding="none"
      aria-label={`Artifact ${title}`}
      className="flex items-center gap-3 px-3 py-2"
    >
      <Icon name="paperclip" className="size-4 shrink-0 text-fg-dim" />
      <div className="flex min-w-0 flex-1 flex-col">
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
          {cardStatus(call, published)}
        </span>
      </div>
      {published !== undefined && (
        <a
          href={href(plugin, published.id)}
          className="text-label text-accent hover:underline"
        >
          Open
        </a>
      )}
    </Card>
  );
}

// The Session panel's Artifacts tab: what the Session published, the newest
// open beside the chat.
function SessionArtifacts({
  session,
}: {
  readonly session: MountedSession;
}): ReactElement | null {
  const api = useApi(plugin);
  const [picked, setPicked] = useState<string>();
  const [version, setVersion] = useState<number>();
  const [sharing, setSharing] = useState(false);

  const { value } = useLoaded(
    async () =>
      (
        await api.get<{ artifacts: ArtifactSummary[] }>(
          `sessions/${session.id}/artifacts`,
        )
      ).artifacts,
    session.id,
    { changes: ["artifacts"] },
  );

  const shownId = picked ?? value?.[0]?.id;

  const { value: shown } = useLoaded(
    async () =>
      shownId === undefined
        ? undefined
        : api.get<ArtifactView>(`artifacts/${shownId}`),
    shownId ?? "",
    { changes: ["artifacts"] },
  );

  if (value === undefined || value.length === 0) {
    return null;
  }

  const number = Math.min(version ?? Infinity, shown?.versions ?? 1);

  return (
    <SessionTab
      name="artifacts"
      order={10}
      label={`Artifacts ${String(value.length)}`}
      button={`Artifacts, ${String(value.length)} published`}
      icon="paperclip"
    >
      {shown !== undefined && (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            {value.length > 1 ? (
              <Select
                aria-label="Artifact"
                className="min-w-0 flex-1"
                value={shownId}
                onChange={(event) => {
                  setPicked(event.target.value);
                  setVersion(undefined);
                }}
              >
                {value.map((each) => (
                  <option key={each.id} value={each.id}>
                    {each.title}
                  </option>
                ))}
              </Select>
            ) : (
              <span className="min-w-0 flex-1 truncate text-label font-medium text-fg-strong">
                {shown.title}
              </span>
            )}
            <Select
              aria-label="Version"
              value={String(number)}
              onChange={(event) => {
                setVersion(Number(event.target.value));
              }}
            >
              {[...shown.history].reverse().map((each) => (
                <option key={each.number} value={each.number}>
                  {`Version ${String(each.number)} of ${String(shown.versions)}`}
                </option>
              ))}
            </Select>
            <a
              href={href(plugin, `${shown.id}/comments`)}
              className="text-label text-accent hover:underline"
            >
              {`Comments ${String(shown.openComments)}`}
            </a>
            {shown.access === "steer" && (
              <Button
                variant="ghost"
                onClick={() => {
                  setSharing(true);
                }}
              >
                Share
              </Button>
            )}
            <a
              href={versionHref(shown.id, number, shown.versions)}
              aria-label="Open on its own page"
              className="text-fg-dim hover:text-fg"
            >
              <Icon name="external-link" className="size-4" />
            </a>
          </div>
          <Frame artifact={shown} version={number} className="h-[70vh]" />
          <p className="text-caption text-fg-dim">
            Shown in a sandbox: scripts run, but the page can&apos;t reach
            Pipoca or your sign-in.
          </p>
          <ShareDialog
            artifact={shown}
            version={number}
            open={sharing}
            onClose={() => {
              setSharing(false);
            }}
          />
        </div>
      )}
    </SessionTab>
  );
}

// The artifacts the person pinned, under Artifacts in the sidebar.
function Pinned({ path }: NavItemsProps): ReactElement | null {
  const api = useApi(plugin);

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
          <a
            href={href(plugin, each.id)}
            aria-current={
              path?.startsWith(each.id) === true ? "page" : undefined
            }
            className="block truncate rounded-md px-3 py-1 pl-11 text-label text-fg-dim hover:bg-hover hover:text-fg aria-[current=page]:text-fg-strong"
          >
            {each.title}
          </a>
        </li>
      ))}
    </ul>
  );
}

function cardStatus(
  call: ToolCallProps["call"],
  published: Published | undefined,
): string {
  if (call.status === "running") {
    return "Publishing";
  }

  if (call.status === "failed") {
    return call.result?.text ?? "Not published";
  }

  return published?.kind === undefined
    ? `Version ${String(published?.version ?? 1)}`
    : `${kindLabel(published.kind)} · version ${String(published.version)}`;
}
