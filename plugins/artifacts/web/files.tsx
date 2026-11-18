import {
  AttachPicker,
  AttachRow,
  type FileActionsProps,
  FilesRow,
  FilesSection,
  type MountedSession,
  type SessionAttachProps,
  uploadBlob,
  useApi,
  useLoaded,
  useOverlay,
} from "@pipoca/plugins/web";
import { Button, ErrorText, Icon } from "@pipoca/ui";
import { type ReactElement, useState } from "react";
import { artifacts as plugin } from "../plugin";
import {
  type ArtifactSummary,
  kindLabel,
  kindOf,
  type Published,
} from "../src/artifacts";

// The Session's artifacts, first in the header's Files menu (ADR 0081).
export function SessionArtifacts({
  session,
}: {
  readonly session: MountedSession;
}): ReactElement {
  const api = useApi(plugin);
  const { open } = useOverlay();

  const { value = [] } = useLoaded(
    async () =>
      (
        await api.get<{ artifacts: ArtifactSummary[] }>(
          `artifacts?sessions=${encodeURIComponent(session.id)}`,
        )
      ).artifacts,
    `session:${session.id}`,
    { changes: ["artifacts"] },
  );

  return (
    <FilesSection
      name="artifacts"
      order={10}
      title="Artifacts"
      count={value.length}
    >
      {(filter) => {
        const shown = value.filter((each) =>
          each.title.toLowerCase().includes(filter),
        );

        return shown.length === 0
          ? null
          : shown.map((each) => (
              <FilesRow
                key={each.id}
                icon="file-text"
                name={each.title}
                detail={`v${String(each.versions)}`}
                onOpen={() => {
                  open({ artifact: each.id });
                }}
              />
            ));
      }}
    </FilesSection>
  );
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
  const name = file.split("/").at(-1) ?? file;

  if (kindOf(name) === undefined) {
    return null;
  }

  const publish = async (): Promise<void> => {
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
              setProblem(
                error instanceof Error ? error.message : String(error),
              );
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
            kindLabel(each.kind),
            `v${String(each.versions)}`,
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
              detail: `artifact · version ${String(picked.versions)}`,
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
