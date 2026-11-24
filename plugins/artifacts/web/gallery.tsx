import { ago, useApi, useLoaded, useNow } from "@pipoca/plugins/web";
import {
  Badge,
  Button,
  cn,
  EmptyState,
  Icon,
  linkCardClass,
  SearchInput,
  Segmented,
  Select,
} from "@pipoca/ui";
import { type ReactElement, useEffect, useRef, useState } from "react";
import { artifacts as plugin } from "../plugin";
import {
  type ArtifactSummary,
  type ArtifactType,
  typeLabel,
  types,
  versionTag,
} from "../src/artifacts";
import { base } from "./collaborate";
import { ArtifactLink } from "./viewer";

type Shelf = "yours" | "shared" | "team";

const shelves: Readonly<Record<Shelf, (artifact: ArtifactSummary) => boolean>> =
  {
    yours: (artifact) => artifact.audience !== "team" && artifact.yours,
    shared: (artifact) => artifact.audience !== "team" && !artifact.yours,
    team: (artifact) => artifact.audience === "team",
  };

const shelfLabels: Readonly<Record<Shelf, string>> = {
  yours: "Mine",
  shared: "Shared with me",
  team: "Team",
};

const emptyShelves: Readonly<Record<Shelf, string>> = {
  yours:
    "Nothing yet. When Pi publishes something from your Sessions, it shows here.",
  shared: "No one has shared an artifact with you yet.",
  team: "No team work has published anything yet.",
};

type Order = "opened" | "changed";

const pressedClass =
  "aria-pressed:border-line-strong aria-pressed:bg-hover aria-pressed:text-fg-strong";

// Every artifact the person opens as a grid of their first screens, which
// open in the viewer over the gallery (ADR 0081). sessions narrows it to a
// Project's, and team to the team's shelf alone.
export function Gallery({
  sessions,
  team = false,
}: {
  readonly sessions?: readonly string[];
  readonly team?: boolean;
}): ReactElement {
  const api = useApi(plugin);
  const now = useNow();
  const [shelf, setShelf] = useState<Shelf>(team ? "team" : "yours");
  const [search, setSearch] = useState("");
  const [type, setType] = useState<ArtifactType | "">("");
  const [commented, setCommented] = useState(false);
  const [templates, setTemplates] = useState(false);
  const [order, setOrder] = useState<Order>("opened");

  const narrowed = sessions?.join(",");

  const { value } = useLoaded(
    async () =>
      (
        await api.get<{ artifacts: ArtifactSummary[] }>(
          narrowed === undefined
            ? "artifacts"
            : `artifacts?sessions=${encodeURIComponent(narrowed)}`,
        )
      ).artifacts,
    `list:${narrowed ?? ""}`,
    { changes: ["artifacts"] },
  );

  const all = value ?? [];
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);

  const shown = all
    .filter(narrowed === undefined ? shelves[shelf] : () => true)
    .filter((each) => type === "" || each.type === type)
    .filter((each) => !commented || each.openComments > 0)
    .filter((each) => !templates || each.template !== null)
    .filter((each) =>
      words.every((word) =>
        `${each.title} ${each.sessionTitle ?? ""}`.toLowerCase().includes(word),
      ),
    )
    .sort((a, b) =>
      order === "opened"
        ? (b.openedAt ?? 0) - (a.openedAt ?? 0) || b.updatedAt - a.updatedAt
        : b.updatedAt - a.updatedAt,
    );

  const filtered = words.length > 0 || type !== "" || commented || templates;

  const empty =
    narrowed === undefined
      ? emptyShelves[shelf]
      : "Nothing published yet. Ask Pi to publish a page, or open a file in the folder and choose Publish as artifact.";

  return (
    <div className="flex flex-col gap-4">
      {(value === undefined || all.length > 0) && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <SearchInput
              aria-label="Search"
              placeholder="Search titles and Sessions"
              className="flex-1 basis-60 sm:max-w-80"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
              }}
            />
            <span className="flex-1 max-sm:hidden" />
            <Select
              aria-label="Order"
              value={order}
              className="w-44"
              onChange={(event) => {
                setOrder(event.target.value as Order);
              }}
            >
              <option value="opened">Recently opened</option>
              <option value="changed">Recently changed</option>
            </Select>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {narrowed === undefined && !team && (
              <Segmented
                label="Show"
                value={shelf}
                options={(["yours", "shared", "team"] as const).map((each) => ({
                  value: each,
                  label: `${shelfLabels[each]} ${String(all.filter(shelves[each]).length)}`,
                }))}
                onChange={setShelf}
              />
            )}
            <span className="flex-1 max-sm:hidden" />
            <Select
              aria-label="Kind"
              value={type}
              className="w-36"
              onChange={(event) => {
                setType(event.target.value as ArtifactType | "");
              }}
            >
              <option value="">All kinds</option>
              {types.map((each) => (
                <option key={each} value={each}>
                  {typeLabel(each)}
                </option>
              ))}
            </Select>
            <Button
              aria-pressed={templates}
              className={pressedClass}
              onClick={() => {
                setTemplates(!templates);
              }}
            >
              {templates ? (
                <Icon name="check" />
              ) : (
                <Icon name="file-text" className="text-fg-dim" />
              )}
              Templates
            </Button>
            <Button
              aria-pressed={commented}
              className={pressedClass}
              onClick={() => {
                setCommented(!commented);
              }}
            >
              {commented ? (
                <Icon name="check" />
              ) : (
                <span className="size-2 rounded-full bg-waiting" />
              )}
              Open comments
            </Button>
          </div>
        </>
      )}
      {value !== undefined && shown.length === 0 ? (
        <EmptyState>{filtered ? "Nothing matches." : empty}</EmptyState>
      ) : (
        <ul
          aria-label="Artifacts"
          className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-4.5"
        >
          {shown.map((each) => (
            <li key={each.id} className="min-w-0">
              <GalleryCard artifact={each} now={now} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function GalleryCard({
  artifact,
  now,
}: {
  readonly artifact: ArtifactSummary;
  readonly now: number;
}): ReactElement {
  return (
    <ArtifactLink
      id={artifact.id}
      className={cn(linkCardClass, "flex flex-col overflow-hidden p-0")}
    >
      <FirstScreen artifact={artifact} />
      <div className="flex flex-col gap-1 px-3.5 py-3">
        <div className="flex items-center gap-1.5">
          <h2 className="min-w-0 flex-1 truncate text-label font-medium text-fg-strong">
            {artifact.title}
          </h2>
          {artifact.template !== null && <Badge>Template</Badge>}
          {artifact.openComments > 0 && (
            <span
              title={`${String(artifact.openComments)} open comments`}
              className="rounded-full bg-waiting/20 px-1.5 text-caption text-fg"
            >
              {artifact.openComments}
              <span className="sr-only"> open comments</span>
            </span>
          )}
        </div>
        <div className="truncate text-caption text-fg-dim">
          {[
            typeLabel(artifact.type),
            ...versionTag(artifact),
            audienceOf(artifact),
            ago(new Date(artifact.updatedAt).toISOString(), now),
          ].join(" · ")}
        </div>
      </div>
    </ArtifactLink>
  );
}

function audienceOf(artifact: ArtifactSummary): string {
  if (artifact.audience === "team") {
    return "team";
  }

  if (artifact.audience === "named") {
    return `shared with ${String(artifact.sharedWith.length)}`;
  }

  return artifact.yours ? "only you" : `from ${artifact.owner}`;
}

// The first screen of the latest version, drawn small in a sandbox, once
// the card scrolls into view; a PDF shows its kind only.
export function FirstScreen({
  artifact,
  className = "h-37.5",
}: {
  readonly artifact: ArtifactSummary;
  // Its height.
  readonly className?: string;
}): ReactElement {
  const box = useRef<HTMLSpanElement>(null);
  const [seen, setSeen] = useState(false);

  useEffect(() => {
    const element = box.current;

    if (seen || element === null) {
      return undefined;
    }

    const watch = new IntersectionObserver(
      (entries) => {
        if (entries.some((each) => each.isIntersecting)) {
          setSeen(true);
        }
      },
      { rootMargin: "200px" },
    );

    watch.observe(element);

    return () => {
      watch.disconnect();
    };
  }, [seen]);

  return (
    <span
      ref={box}
      aria-hidden="true"
      className={cn(
        "relative block overflow-hidden border-b border-line",
        className,
        artifact.kind !== "pdf" && seen ? "bg-canvas" : "bg-elevated",
      )}
    >
      {artifact.kind === "pdf" ? (
        <span className="grid h-full place-items-center text-label text-fg-dim">
          PDF
        </span>
      ) : (
        seen && (
          <iframe
            title={artifact.title}
            tabIndex={-1}
            loading="lazy"
            src={`${base}/artifacts/${artifact.id}/view?v=${String(artifact.versions)}`}
            sandbox="allow-scripts"
            className="pointer-events-none absolute top-0 left-0 h-[200%] w-[200%] origin-top-left scale-50 border-0"
          />
        )
      )}
    </span>
  );
}
