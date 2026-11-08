import {
  ConfigForm,
  defineWeb,
  type MountedSession,
  SessionTab,
  type SessionFilesProps,
  uploadBlob,
  useApi,
  useLoaded,
  useSessionState,
} from "@pipoca/plugins/web";
import { Badge, Chip, ErrorText, Icon, Row, Rows, Section } from "@pipoca/ui";
import { type ReactElement, useEffect, useRef, useState } from "react";
import { files as plugin } from "../plugin";
import {
  bytes as size,
  type FilesState,
  type Place,
  type SessionFile,
} from "../src/files";

export const web = defineWeb(plugin, {
  settings: { group: "server", Section: FilesSettings },
  slots: {
    "session.header": FilesButton,
    "session.files": Attached,
    "notice:files": UploadNotice,
  },
});

const none: readonly SessionFile[] = [];

interface Limits {
  readonly maxFileBytes: number;
  readonly perPersonBytes: number;
  readonly kept: number;
}

interface Snapshot {
  readonly checkout: string;
  readonly size: number;
  readonly savedAt: number;
}

interface Usage {
  readonly used: number;
  readonly free: number;
  readonly over: readonly { readonly name: string; readonly kept: number }[];
}

// Settings > Files: what the store takes, who keeps more than the
// per-person number, and the limits.
function FilesSettings(): ReactElement {
  const api = useApi(plugin);

  const { value: usage } = useLoaded(
    async () => api.get<Usage>("usage"),
    "usage",
    { changes: ["files"] },
  );

  return (
    <div className="flex flex-col gap-4">
      {usage !== undefined && (
        <Section title="Storage">
          <p>
            {`Session files take ${size(usage.used)}, with ${size(usage.free)} free on the data volume.`}
          </p>
          {usage.over.length > 0 && (
            <Rows label="Over the per-person number">
              {usage.over.map((each) => (
                <Row
                  key={each.name}
                  title={each.name}
                  description={`${size(each.kept)} kept`}
                />
              ))}
            </Rows>
          )}
        </Section>
      )}
      <ConfigForm plugin={plugin} />
    </div>
  );
}

function useSessionFiles(sessionId: string): readonly SessionFile[] {
  const api = useApi(plugin);

  return (
    useLoaded(
      async () =>
        (await api.get<{ files: SessionFile[] }>(`sessions/${sessionId}/files`))
          .files,
      sessionId,
      { changes: ["files"] },
    ).value ?? none
  );
}

// The header's Files button opens what the Session keeps on the server, with
// downloads, as in the mockups' Files tab.
function FilesButton({
  session,
}: {
  readonly session: MountedSession;
}): ReactElement | null {
  const kept = useSessionFiles(session.id);
  const state = useSessionState<FilesState>(session, "files");
  const unsaved = state?.unsaved ?? [];
  const api = useApi(plugin);

  const { value: limits } = useLoaded(
    async () => api.get<Limits>("limits"),
    "limits",
    { changes: ["files"] },
  );

  const { value: snapshots } = useLoaded(
    async () =>
      (
        await api.get<{ snapshots: Snapshot[] }>(
          `sessions/${session.id}/snapshots`,
        )
      ).snapshots,
    `snapshots:${session.id}`,
    { changes: ["files"] },
  );

  if (
    kept.length === 0 &&
    unsaved.length === 0 &&
    (snapshots ?? []).length === 0
  ) {
    return null;
  }

  return (
    <SessionTab
      name="files"
      order={20}
      label={`Files ${String(kept.length)}`}
      button={`Files, ${String(kept.length)} kept`}
      icon="paperclip"
    >
      {unsaved.length > 0 && (
        <p className="text-label text-waiting">
          {`${String(unsaved.length)} ${unsaved.length === 1 ? "file isn't" : "files aren't"} saved yet. `}
          {state?.problem}
        </p>
      )}
      {state?.problem !== undefined && unsaved.length === 0 && (
        <ErrorText size="caption">{state.problem}</ErrorText>
      )}
      {limits !== undefined && limits.kept > limits.perPersonBytes && (
        <p className="text-label text-waiting">
          {`Your Sessions keep ${size(limits.kept)} of files, more than the ${size(limits.perPersonBytes)} this server suggests for each person. Nothing is deleted or refused.`}
        </p>
      )}
      <FileList
        sessionId={session.id}
        place="outputs"
        title="Outputs"
        description="What Pi made for you"
        files={kept}
        unsaved={unsaved}
      />
      <FileList
        sessionId={session.id}
        place="uploads"
        title="Uploads"
        description="What you gave this Session"
        files={kept}
        unsaved={[]}
      />
      {snapshots !== undefined && snapshots.length > 0 && (
        <Section
          title="Unfinished work"
          description="What Pi changed in a repository but didn't push. The next pod clones the branch and puts it back; ignored folders like node_modules are rebuilt."
        >
          <Rows label="Unfinished work">
            {snapshots.map((each) => (
              <Row
                key={each.checkout}
                title={each.checkout === "." ? "The repository" : each.checkout}
                description={`${size(each.size)} · saved ${new Date(each.savedAt).toLocaleString()}`}
              />
            ))}
          </Rows>
        </Section>
      )}
    </SessionTab>
  );
}

function FileList({
  sessionId,
  place,
  title,
  description,
  files,
  unsaved,
}: {
  readonly sessionId: string;
  readonly place: Place;
  readonly title: string;
  readonly description: string;
  readonly files: readonly SessionFile[];
  readonly unsaved: readonly string[];
}): ReactElement | null {
  const here = files.filter((file) => file.place === place);

  const waiting = unsaved.filter(
    (path) => !here.some((file) => file.path === path),
  );

  if (here.length === 0 && waiting.length === 0) {
    return null;
  }

  return (
    <Section title={title} description={description}>
      <Rows label={title}>
        {here.map((file) => (
          <Row
            key={file.path}
            title={<span className="font-mono text-mono">{file.path}</span>}
            description={size(file.size)}
          >
            {unsaved.includes(file.path) ? (
              <Badge state="waiting">not saved</Badge>
            ) : (
              <a
                href={`/api/ext/files/sessions/${sessionId}/files/${place}?path=${encodeURIComponent(file.path)}`}
                download={file.path.split("/").at(-1)}
                className="text-label text-accent hover:underline"
              >
                Download
              </a>
            )}
          </Row>
        ))}
        {waiting.map((path) => (
          <Row
            key={path}
            title={<span className="font-mono text-mono">{path}</span>}
          >
            <Badge state="waiting">not saved</Badge>
          </Row>
        ))}
      </Rows>
    </Section>
  );
}

interface Progress {
  readonly sent: number;
  // Its name under uploads/ once the server keeps it.
  readonly path?: string;
  readonly problem?: string;
}

// Files added in the composer go to the server at once, and Pi gets them in
// uploads/ with the next message (ADR 0078).
function Attached({
  session,
  files,
  onRemove,
}: SessionFilesProps): ReactElement | null {
  const api = useApi(plugin);
  const started = useRef(new WeakSet<File>());

  const [progress, setProgress] = useState<ReadonlyMap<File, Progress>>(
    new Map(),
  );

  useEffect(() => {
    const change = (file: File, to: Progress): void => {
      setProgress((current) => new Map(current).set(file, to));
    };

    const send = async (file: File): Promise<void> => {
      const { maxFileBytes } = await api.get<Limits>("limits");

      if (file.size > maxFileBytes) {
        throw new Error(
          `${file.name} is ${size(file.size)}. Files can be up to ${size(maxFileBytes)} on this server.`,
        );
      }

      const hash = await uploadBlob(api, file, (sent) => {
        change(file, { sent });
      });

      const { path } = await api.post<{ path: string }>(
        `sessions/${session.id}/uploads`,
        { name: file.name, hash },
      );

      change(file, { sent: file.size, path });
    };

    for (const file of files) {
      if (!started.current.has(file)) {
        started.current.add(file);

        send(file).catch((error: unknown) => {
          change(file, {
            sent: 0,
            problem: error instanceof Error ? error.message : String(error),
          });
        });
      }
    }
  }, [api, files, session.id]);

  if (files.length === 0) {
    return null;
  }

  return (
    <ul aria-label="Attached files" className="flex flex-col gap-1 pt-1">
      {files.map((file, index) => {
        const each = progress.get(file) ?? { sent: 0 };

        return (
          <li
            key={`${String(index)}-${file.name}`}
            className="flex flex-wrap items-center gap-2"
          >
            <Chip
              mono
              onRemove={() => {
                onRemove(file);
              }}
              removeLabel={`Remove ${file.name}`}
            >
              {file.name}
            </Chip>
            <span className="text-caption text-fg-dim">
              {size(file.size)} · {status(file.size, each)}
            </span>
            {each.problem !== undefined && (
              <ErrorText inline size="caption">
                {each.problem}
              </ErrorText>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function status(total: number, { sent, path, problem }: Progress): string {
  if (problem !== undefined) {
    return "not uploaded";
  }

  if (path !== undefined) {
    return "saved, Pi gets it with your next message";
  }

  return total === 0
    ? "uploading"
    : `uploading ${String(Math.floor((sent / total) * 100))}%`;
}

// What the chat shows for the notice Pi gets when a person adds an upload.
function UploadNotice({ text }: { readonly text: string }): ReactElement {
  return (
    <p className="flex min-w-0 items-center gap-2 px-2 py-1 text-label text-fg-dim">
      <Icon name="paperclip" className="size-4 shrink-0" />
      <span className="truncate">{text}</span>
    </p>
  );
}
