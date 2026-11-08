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
} from "@pipoca/plugins/web";
import {
  Button,
  Card,
  CopyButton,
  EmptyState,
  ErrorText,
  Icon,
  Page,
  Row,
  Rows,
  Section,
  Segmented,
  Select,
  TextInput,
} from "@pipoca/ui";
import { type ReactElement, useState } from "react";
import { artifacts as plugin } from "../plugin";
import { base, Comments, Compare, Editor, Frame } from "./collaborate";
import type {
  ArtifactSummary,
  ArtifactView,
  Published,
  Role,
  Share,
} from "../src/artifacts";

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
  const [id, version] = path.split("/v/");

  return id === undefined || id === "" ? (
    <ArtifactList />
  ) : (
    <ArtifactPage
      id={id}
      version={version === undefined ? undefined : Number(version)}
    />
  );
}

function ArtifactList(): ReactElement {
  const api = useApi(plugin);

  const { value } = useLoaded(
    async () =>
      (await api.get<{ artifacts: ArtifactSummary[] }>("artifacts")).artifacts,
    "list",
    { changes: ["artifacts"] },
  );

  return (
    <Page
      title="Artifacts"
      description="Pages, documents and pictures Pi published, yours and the ones shared with you."
    >
      {value?.length === 0 ? (
        <EmptyState>
          Nothing yet. When Pi publishes something from a Session, it shows
          here.
        </EmptyState>
      ) : (
        <Rows label="Artifacts">
          {(value ?? []).map((each) => (
            <Row
              key={each.id}
              title={
                <a
                  href={href(plugin, each.id)}
                  className="text-accent hover:underline"
                >
                  {each.title}
                </a>
              }
              description={`${each.kind} · ${versionsLabel(each.versions)} · ${new Date(each.updatedAt).toLocaleString()}`}
            />
          ))}
        </Rows>
      )}
    </Page>
  );
}

// One artifact in its sandboxed frame, with its versions and who opens it.
function ArtifactPage({
  id,
  version,
}: {
  readonly id: string;
  readonly version: number | undefined;
}): ReactElement {
  const api = useApi(plugin);

  const { value: artifact } = useLoaded(
    async () => api.get<ArtifactView>(`artifacts/${id}`),
    id,
    { changes: ["artifacts"] },
  );

  const [problem, setProblem] = useState<string>();
  const [mode, setMode] = useState<"read" | "compare" | "edit">("read");
  const [quote, setQuote] = useState("");

  if (artifact === undefined) {
    return <Page title="Artifact">{null}</Page>;
  }

  const shown = version ?? artifact.versions;
  const latest = shown === artifact.versions;
  const query = `?v=${String(shown)}`;

  const restore = async (): Promise<void> => {
    setProblem(undefined);

    try {
      await api.post(`artifacts/${id}/restore`, { version: shown });
      location.hash = href(plugin, id);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <Page
      wide
      title={artifact.title}
      description={`${artifact.kind} · ${versionsLabel(artifact.versions)}`}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Select
            aria-label="Version"
            value={String(shown)}
            onChange={(event) => {
              const picked = Number(event.target.value);

              location.hash =
                picked === artifact.versions
                  ? href(plugin, id)
                  : href(plugin, `${id}/v/${String(picked)}`);
            }}
          >
            {[...artifact.history].reverse().map((each) => (
              <option key={each.number} value={each.number}>
                {`Version ${String(each.number)}${each.number === artifact.versions ? " (latest)" : ""}`}
              </option>
            ))}
          </Select>
          {!latest && artifact.access === "steer" && (
            <Button variant="default" onClick={() => void restore()}>
              Restore
            </Button>
          )}
          <Button
            variant="ghost"
            aria-pressed={artifact.pinned}
            aria-label={
              artifact.pinned ? "Unpin from the sidebar" : "Pin to the sidebar"
            }
            onClick={() =>
              void api.put(`artifacts/${id}/pin`, { pinned: !artifact.pinned })
            }
          >
            <Icon name="pin" className="size-4" />
          </Button>
          <CopyButton
            label="Copy link"
            text={`${location.origin}${location.pathname}${latest ? href(plugin, id) : href(plugin, `${id}/v/${String(shown)}`)}`}
          />
          <a
            href={`${base}/artifacts/${id}/download${query}`}
            className="text-label text-accent hover:underline"
          >
            Download
          </a>
          <a
            href={`${base}/artifacts/${id}/view${query}`}
            target="_blank"
            rel="noreferrer"
            aria-label="Open in a new tab"
            className="text-fg-dim hover:text-fg"
          >
            <Icon name="external-link" className="size-4" />
          </a>
        </div>
      }
    >
      <ErrorText size="caption">{problem}</ErrorText>
      <Segmented
        label="Mode"
        value={mode}
        options={[
          { value: "read", label: "Read" },
          ...(artifact.versions > 1
            ? [{ value: "compare" as const, label: "Compare" }]
            : []),
          ...(artifact.kind === "markdown" && artifact.access === "steer"
            ? [{ value: "edit" as const, label: "Edit" }]
            : []),
        ]}
        onChange={setMode}
      />
      {mode === "read" && (
        <Frame artifact={artifact} version={shown} onSelect={setQuote} />
      )}
      {mode === "compare" && <Compare artifact={artifact} version={shown} />}
      {mode === "edit" && (
        <Editor
          artifact={artifact}
          onDone={() => {
            setMode("read");
            location.hash = href(plugin, id);
          }}
        />
      )}
      <Comments
        artifact={artifact}
        version={shown}
        quote={quote}
        onQuoted={() => {
          setQuote("");
        }}
      />
      {artifact.access === "steer" && (
        <Sharing id={id} shares={artifact.shares} />
      )}
    </Page>
  );
}

function Sharing({
  id,
  shares,
}: {
  readonly id: string;
  readonly shares: readonly Share[];
}): ReactElement {
  const api = useApi(plugin);
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>("view");
  const [problem, setProblem] = useState<string>();

  const save = async (next: readonly { name: string; role: Role }[]) => {
    setProblem(undefined);

    try {
      await api.put(`artifacts/${id}/shares`, { shares: next });
      setName("");
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    }
  };

  const current = shares.map((each) => ({ name: each.name, role: each.role }));

  return (
    <Section
      title="Shared with"
      description="Whoever sees the Session opens this artifact. Add people by name to let them open it too. Pi can't change this."
    >
      {shares.length > 0 && (
        <Rows label="Shared with">
          {shares.map((each) => (
            <Row
              key={each.userId}
              title={each.name}
              description={each.role === "view" ? "Can view" : "Can comment"}
            >
              <Button
                variant="ghost"
                aria-label={`Stop sharing with ${each.name}`}
                onClick={() =>
                  void save(current.filter((one) => one.name !== each.name))
                }
              >
                Remove
              </Button>
            </Row>
          ))}
        </Rows>
      )}
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void save([...current, { name: name.trim(), role }]);
        }}
      >
        <TextInput
          aria-label="Name"
          placeholder="Name"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
        <Select
          aria-label="Access"
          value={role}
          onChange={(event) => {
            setRole(event.target.value as Role);
          }}
        >
          <option value="view">Can view</option>
          <option value="comment">Can comment</option>
        </Select>
        <Button type="submit" disabled={name.trim() === ""}>
          Share
        </Button>
      </form>
      <ErrorText size="caption">{problem}</ErrorText>
    </Section>
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

  return (
    <SessionTab
      name="artifacts"
      order={10}
      label={`Artifacts ${String(value.length)}`}
      button={`Artifacts, ${String(value.length)} published`}
      icon="paperclip"
    >
      {value.length > 1 && (
        <Select
          aria-label="Artifact"
          value={shownId}
          onChange={(event) => {
            setPicked(event.target.value);
          }}
        >
          {value.map((each) => (
            <option key={each.id} value={each.id}>
              {each.title}
            </option>
          ))}
        </Select>
      )}
      {shown !== undefined && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-label text-fg-dim">
              {`${shown.title} · ${versionsLabel(shown.versions)}`}
            </span>
            <a
              href={href(plugin, shown.id)}
              className="text-label text-accent hover:underline"
            >
              Open
            </a>
          </div>
          <Frame
            artifact={shown}
            version={shown.versions}
            className="h-[70vh]"
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

function versionsLabel(count: number): string {
  return `${String(count)} ${count === 1 ? "version" : "versions"}`;
}

function cardStatus(
  call: ToolCallProps["call"],
  published: Published | undefined,
): string {
  if (call.status === "running") {
    return "Publishing";
  }

  return call.status === "failed"
    ? (call.result?.text ?? "Not published")
    : `Version ${String(published?.version ?? 1)}`;
}
