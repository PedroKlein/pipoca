import { errorText } from "@pipoca/protocol";
import {
  ago,
  AttachPicker,
  AttachRow,
  type FileActionsProps,
  FilesSection,
  type MountedSession,
  type SessionAttachProps,
  uploadBlob,
  useApi,
  useFileItem,
  useFilesSessions,
  useLoaded,
  useNow,
  useOverlay,
} from "@pipoca/plugins/web";
import {
  Badge,
  Button,
  cn,
  ErrorText,
  Icon,
  linkCardClass,
  Menu,
} from "@pipoca/ui";
import { type ReactElement, useMemo, useState } from "react";
import { artifacts as plugin } from "../plugin";
import {
  type ArtifactSummary,
  kindOf,
  type Published,
  typeLabel,
  versionTag,
} from "../src/artifacts";
import { artifactHref } from "./collaborate";
import { FirstScreen } from "./gallery";
import { ArtifactLink } from "./viewer";

// The Session's artifacts, first in the panel's Files, as cards with a
// picture of each (ADR 0081). The files they were published from are left
// out of what Pi made, and any other file Pi made can be published from its
// row's menu.
export function SessionArtifacts({
  session,
}: {
  readonly session: MountedSession;
}): ReactElement {
  const api = useApi(plugin);
  const { open } = useOverlay();
  const [problem, setProblem] = useState<string>();
  const sessions = useFilesSessions(session.id);
  const ids = sessions.map(({ id }) => encodeURIComponent(id)).join(",");

  const { value = none } = useLoaded(
    async () =>
      (
        await api.get<{ artifacts: ArtifactSummary[] }>(
          `artifacts?sessions=${ids}`,
        )
      ).artifacts,
    `sessions:${ids}`,
    { changes: ["artifacts"] },
  );

  const titles = new Map(sessions.map(({ id, title }) => [id, title]));

  const covers = useMemo(() => value.flatMap(({ hashes }) => hashes), [value]);

  useFileItem((file) =>
    kindOf(nameOf(file.file)) === undefined
      ? undefined
      : {
          label: "Publish as artifact",
          icon: "upload",
          run: () => {
            setProblem(undefined);

            publishFile(api, file)
              .then((id) => {
                open({ artifact: id });
              })
              .catch((error: unknown) => {
                setProblem(errorText(error));
              });
          },
        },
  );

  return (
    <>
      <FilesSection
        name="artifacts"
        order={10}
        title="Artifacts"
        count={value.length}
        cards
        covers={covers}
      >
        {(filter) => {
          const shown = value.filter((each) =>
            [each.title, titles.get(each.sessionId ?? "") ?? ""].some((text) =>
              text.toLowerCase().includes(filter),
            ),
          );

          return shown.length === 0
            ? null
            : shown.map((each) => (
                <ArtifactCard
                  key={each.id}
                  artifact={each}
                  thread={titles.get(each.sessionId ?? "") ?? ""}
                />
              ));
        }}
      </FilesSection>
      <FilesSection name="artifacts-status" order={11} count={0}>
        {() =>
          problem === undefined ? null : (
            <ErrorText size="caption">{problem}</ErrorText>
          )
        }
      </FilesSection>
    </>
  );
}

const none: readonly ArtifactSummary[] = [];

function ArtifactCard({
  artifact,
  thread,
}: {
  readonly artifact: ArtifactSummary;
  // The thread it's from, in a Project coordinator's Files.
  readonly thread: string;
}): ReactElement {
  const { open } = useOverlay();
  const now = useNow();
  const [said, setSaid] = useState<string>();

  return (
    <div className={cn(linkCardClass, "flex min-w-0 flex-col")}>
      <ArtifactLink
        id={artifact.id}
        className="relative block overflow-hidden rounded-t-lg focus-visible:ring-4 focus-visible:ring-focus focus-visible:outline-none"
      >
        <FirstScreen artifact={artifact} className="h-23" />
        <span className="absolute top-1.5 left-1.5">
          <Badge>{typeLabel(artifact.type)}</Badge>
        </span>
        <span className="sr-only">{artifact.title}</span>
      </ArtifactLink>
      <div className="flex items-center gap-1 py-1.5 pr-1 pl-2.5">
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-caption font-medium text-fg-strong">
            {artifact.title}
          </span>
          <span
            aria-live="polite"
            className="truncate text-caption text-fg-dim"
          >
            {said ??
              [
                ...(thread === "" ? [] : [thread]),
                ...versionTag(artifact),
                ago(new Date(artifact.updatedAt).toISOString(), now),
              ].join(" · ")}
          </span>
        </span>
        <Menu
          label={`More for ${artifact.title}`}
          size="sm"
          items={[
            {
              label: "Open",
              icon: "file-text",
              run: () => {
                open({ artifact: artifact.id });
              },
            },
            {
              label: "Copy link",
              icon: "link",
              run: () => {
                navigator.clipboard
                  .writeText(
                    `${location.origin}${location.pathname}${artifactHref(artifact.id)}`,
                  )
                  .then(
                    () => {
                      setSaid("Link copied");
                    },
                    (error: unknown) => {
                      setSaid(errorText(error));
                    },
                  );
              },
            },
          ]}
        />
      </div>
    </div>
  );
}

function nameOf(file: string): string {
  return file.split("/").at(-1) ?? file;
}

// Publishes a Session's file as its artifact, by its bytes.
async function publishFile(
  api: ReturnType<typeof useApi>,
  { session, file, download }: FileActionsProps,
): Promise<string> {
  const name = nameOf(file);
  const response = await fetch(download);

  if (!response.ok) {
    throw new Error(`${name} didn't download (${String(response.status)}).`);
  }

  const bytes = new File([await response.blob()], name);
  const hash = await uploadBlob(api, bytes, () => undefined);

  const { id } = await api.post<Published>("artifacts", {
    session,
    name,
    hash,
  });

  return id;
}

// Beside Download in the file viewer: the file becomes an artifact of its
// Session, which opens in its place.
export function PublishFile({
  session,
  file,
  download,
}: FileActionsProps): ReactElement | null {
  const api = useApi(plugin);
  const { open } = useOverlay();
  const [publishing, setPublishing] = useState(false);
  const [problem, setProblem] = useState<string>();

  if (kindOf(nameOf(file)) === undefined) {
    return null;
  }

  const publish = async (): Promise<void> => {
    const id = await publishFile(api, { session, file, download });

    open({ artifact: id }, { replace: true });
  };

  return (
    <>
      <Button
        size="sm"
        disabled={publishing}
        onClick={() => {
          setPublishing(true);
          setProblem(undefined);

          publish()
            .catch((error: unknown) => {
              setProblem(errorText(error));
            })
            .finally(() => {
              setPublishing(false);
            });
        }}
      >
        <Icon name="upload" className="size-3.5" />
        {publishing ? "Publishing…" : "Publish as artifact"}
      </Button>
      {problem !== undefined && (
        <ErrorText inline size="caption">
          {problem}
        </ErrorText>
      )}
    </>
  );
}

// The composer's + menu: an artifact goes with the message by its id and
// version, which Pi reads with read_artifact; nothing is copied.
export function AttachArtifact({
  session,
  add,
}: SessionAttachProps): ReactElement {
  const api = useApi(plugin);
  const [picking, setPicking] = useState(false);

  const { value } = useLoaded(
    async () =>
      picking
        ? (
            await api.get<{ artifacts: ArtifactSummary[] }>(
              `artifacts?for=${encodeURIComponent(session.id)}`,
            )
          ).artifacts
        : undefined,
    picking ? `attach:${session.id}` : "",
    { changes: ["artifacts"] },
  );

  return (
    <>
      <AttachRow
        icon="file-text"
        label="An artifact…"
        onPick={() => {
          setPicking(true);
        }}
      />
      <AttachPicker
        open={picking}
        title="Attach an artifact"
        items={value?.map((each) => ({
          key: each.id,
          title: each.title,
          detail: [
            typeLabel(each.type),
            ...versionTag(each),
            ...(each.sessionId === session.id || each.sessionTitle === null
              ? []
              : [`from ${each.sessionTitle}`]),
          ].join(" · "),
        }))}
        empty="There are no artifacts yet."
        onPick={(id) => {
          const picked = value?.find((each) => each.id === id);

          if (picked !== undefined) {
            add({
              key: `artifact:${picked.id}`,
              title: picked.title,
              icon: "file-text",
              detail: picked.living
                ? "artifact · latest text"
                : `artifact · version ${String(picked.versions)}`,
              // Someone else may have named it, so the title goes as data.
              text: `Attached: the artifact ${JSON.stringify(picked.title)} (${picked.id}), version ${String(picked.versions)}. Read it with read_artifact.`,
            });
          }
        }}
        onClose={() => {
          setPicking(false);
        }}
      />
    </>
  );
}
