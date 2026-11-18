import {
  ago,
  ConfigForm,
  defineWeb,
  FilesRow,
  FilesSection,
  FileViewer,
  type MountedSession,
  type SessionFilesProps,
  uploadBlob,
  useApi,
  useLoaded,
  useNow,
  useOverlay,
  useSessionState,
  useViewer,
  ViewerClose,
  viewerHeaderClass,
  ViewerLead,
  viewerShellClass,
  ViewerTitle,
} from "@pipoca/plugins/web";
import {
  Chip,
  FileButton,
  Dialog,
  ErrorText,
  Icon,
  plural,
  Row,
  Rows,
  Section,
  Spinner,
} from "@pipoca/ui";
import { type ReactElement, useEffect, useId, useRef, useState } from "react";
import { files as plugin } from "../plugin";
import {
  bytes as size,
  type FilesState,
  type Place,
  type SessionFile,
  type SnapshotChange,
} from "../src/files";

export const web = defineWeb(plugin, {
  settings: { group: "server", Section: FilesSettings },
  slots: {
    "session.header": SessionFiles,
    "session.files": Attached,
    "notice:files": UploadNotice,
    overlay: FileOverlay,
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
  readonly changes: readonly SnapshotChange[];
  readonly changed: number;
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

interface Kept {
  readonly files: readonly SessionFile[];
  // Whether the person may give the Session files.
  readonly steers: boolean;
}

function useSessionFiles(sessionId: string): Kept | undefined {
  const api = useApi(plugin);

  return useLoaded(
    async () => api.get<Kept>(`sessions/${sessionId}/files`),
    sessionId,
    { changes: ["files"] },
  ).value;
}

const unsavedNote = "retrying when the runner is back";

// What the header's Files menu lists for the Session: what Pi made, what
// people uploaded, and work Pi didn't push (ADR 0081). A row opens the
// file in the viewer.
function SessionFiles({
  session,
}: {
  readonly session: MountedSession;
}): ReactElement {
  const listed = useSessionFiles(session.id);
  const kept = listed?.files ?? none;
  const state = useSessionState<FilesState>(session, "files");
  const unsaved = state?.unsaved ?? [];
  const api = useApi(plugin);
  const { open } = useOverlay();
  const [uploadProblem, setUploadProblem] = useState<string>();
  const [sending, setSending] = useState(false);

  const { value: limits } = useLoaded(
    async () => api.get<Limits>("limits"),
    "limits",
    { changes: ["files"] },
  );

  const { value: snapshots = [] } = useLoaded(
    async () =>
      (
        await api.get<{ snapshots: Snapshot[] }>(
          `sessions/${session.id}/snapshots`,
        )
      ).snapshots,
    `snapshots:${session.id}`,
    { changes: ["files"] },
  );

  const waiting = (listed === undefined ? [] : unsaved).filter(
    (path) =>
      !kept.some((file) => file.place === "outputs" && file.path === path),
  );

  const rows = (place: Place) => (filter: string) => {
    const shown = kept.filter(
      (file) =>
        file.place === place && file.path.toLowerCase().includes(filter),
    );

    return shown.length === 0
      ? null
      : shown.map((file) => (
          <FilesRow
            key={file.path}
            name={file.path}
            detail={
              place === "outputs" && unsaved.includes(file.path)
                ? "not saved"
                : size(file.size)
            }
            onOpen={() => {
              open({ session: session.id, file: `${place}/${file.path}` });
            }}
          />
        ));
  };

  const count = (place: Place): number =>
    kept.filter((file) => file.place === place).length;

  const over = limits !== undefined && limits.kept > limits.perPersonBytes;

  return (
    <>
      <FilesSection
        name="outputs"
        order={20}
        title="Made by Pi · outputs/"
        count={count("outputs") + waiting.length}
      >
        {rows("outputs")}
      </FilesSection>
      <FilesSection
        name="uploads"
        order={30}
        title="Uploaded · uploads/"
        count={count("uploads")}
        {...(listed?.steers === true && {
          action: (
            <UploadButton
              sessionId={session.id}
              sending={sending}
              onSending={setSending}
              onProblem={setUploadProblem}
            />
          ),
        })}
      >
        {rows("uploads")}
      </FilesSection>
      <FilesSection
        name="unfinished"
        order={50}
        title="Unfinished work"
        count={snapshots.length}
      >
        {(filter) => {
          const shown = snapshots.filter(
            (each) =>
              each.checkout.toLowerCase().includes(filter) ||
              each.changes.some((change) =>
                change.path.toLowerCase().includes(filter),
              ),
          );

          return shown.length === 0
            ? null
            : shown.map((each) => <Unfinished key={each.checkout} {...each} />);
        }}
      </FilesSection>
      <FilesSection name="files-status" order={90} count={0}>
        {() =>
          waiting.length === 0 &&
          state?.problem === undefined &&
          uploadProblem === undefined &&
          !over
            ? null
            : [
                uploadProblem !== undefined && (
                  <ErrorText key="upload" size="caption">
                    {uploadProblem}
                  </ErrorText>
                ),
                waiting.length > 0 && (
                  <p
                    key="unsaved"
                    className="flex items-center gap-2 rounded-lg bg-waiting/12 px-3 py-2.5 text-caption text-fg"
                  >
                    <Spinner className="size-3.5 text-waiting" />
                    {`${plural(waiting.length, "file")} not saved yet · ${state?.problem ?? unsavedNote}`}
                  </p>
                ),
                waiting.length === 0 && state?.problem !== undefined && (
                  <ErrorText key="problem" size="caption">
                    {state.problem}
                  </ErrorText>
                ),
                over && (
                  <p key="over" className="px-1 pt-2 text-caption text-waiting">
                    {`Your Sessions keep ${size(limits.kept)} of files, more than the ${size(limits.perPersonBytes)} this server suggests for each person. Nothing is deleted or refused.`}
                  </p>
                ),
              ]
        }
      </FilesSection>
    </>
  );
}

// A checkout's changes Pi didn't push, which the next pod puts back.
function Unfinished({
  checkout,
  changes,
  changed,
  size: kept,
  savedAt,
}: Snapshot): ReactElement {
  return (
    <div
      title="The next pod clones the branch and puts these back; ignored folders like node_modules are rebuilt."
      className="flex flex-col gap-1 px-1 py-1.5"
    >
      <span className="text-label text-fg">
        {checkout === "." ? "The repository" : checkout}
      </span>
      <span className="text-caption text-fg-dim">
        {`${plural(changed, "file")} Pi changed but didn't push · ${size(kept)} · saved ${new Date(savedAt).toLocaleString()}`}
      </span>
      {changes.length > 0 && (
        <ul
          aria-label={`Changed in ${checkout}`}
          className="flex flex-col gap-0.5 font-mono text-mono text-fg-dim"
        >
          {changes.map((change) => (
            <li key={change.path}>{`${change.path} · ${change.change}`}</li>
          ))}
          {changed > changes.length && (
            <li>{`and ${String(changed - changes.length)} more`}</li>
          )}
        </ul>
      )}
    </div>
  );
}

// Beside the filter: gives the Session files, which Pi finds in uploads/.
// The menu's sections leave while it's closed, so what an upload is doing
// stays with the Session's files.
function UploadButton({
  sessionId,
  sending,
  onSending,
  onProblem,
}: {
  readonly sessionId: string;
  readonly sending: boolean;
  readonly onSending: (sending: boolean) => void;
  readonly onProblem: (problem: string | undefined) => void;
}): ReactElement {
  const api = useApi(plugin);

  const send = async (chosen: readonly File[]): Promise<void> => {
    for (const file of chosen) {
      await sendUpload(api, sessionId, file, () => undefined);
    }
  };

  return (
    <FileButton
      multiple
      disabled={sending}
      onFiles={(chosen) => {
        onSending(true);
        onProblem(undefined);

        send(chosen)
          .catch((error: unknown) => {
            onProblem(error instanceof Error ? error.message : String(error));
          })
          .finally(() => {
            onSending(false);
          });
      }}
    >
      {sending ? "Uploading…" : "Upload"}
    </FileButton>
  );
}

const filesNote =
  "Files have no comments or versions. Publish one as an artifact to share it and get comments.";

// A Session file over any page, from the Files menu or a link, until Esc,
// Back or Close.
function FileOverlay(): ReactElement | null {
  const { params, close } = useOverlay();
  const titleId = useId();
  const sessionId = params.get("session");
  const file = params.get("file");

  if (sessionId === null || sessionId === "" || file === null) {
    return null;
  }

  return (
    <Dialog
      key={sessionId}
      open
      size="full"
      onClose={close}
      labelledBy={titleId}
    >
      <SessionFileViewer
        sessionId={sessionId}
        file={file}
        titleId={titleId}
        onClose={close}
      />
    </Dialog>
  );
}

function SessionFileViewer({
  sessionId,
  file,
  titleId,
  onClose,
}: {
  readonly sessionId: string;
  // Its place and path, such as outputs/report.csv.
  readonly file: string;
  readonly titleId: string;
  readonly onClose: () => void;
}): ReactElement {
  const listed = useSessionFiles(sessionId);
  const kept = listed?.files ?? none;
  const { open } = useOverlay();
  const viewer = useViewer();
  const now = useNow();
  const at = kept.findIndex((each) => `${each.place}/${each.path}` === file);
  const shown = kept[at];
  const name = file.slice(file.indexOf("/") + 1);

  if (shown === undefined) {
    return (
      <div className={viewerShellClass}>
        <header className={viewerHeaderClass}>
          <ViewerLead mode="modal" />
          <ViewerTitle mode="modal" titleId={titleId} title={name} line="" />
          <ViewerClose onClose={onClose} />
        </header>
        <p className="m-auto p-6 text-label text-fg-dim">
          {listed !== undefined
            ? `This Session doesn't keep ${name}.`
            : "Loading…"}
        </p>
      </div>
    );
  }

  const where = `/api/ext/files/sessions/${sessionId}/files/${shown.place}`;
  const query = `?path=${encodeURIComponent(shown.path)}`;

  return (
    <FileViewer
      key={file}
      name={shown.path}
      line={`${shown.place}/ · ${size(shown.size)} · ${maker(shown, viewer.person.id)} ${ago(new Date(shown.savedAt).toISOString(), now)}`}
      size={shown.size}
      view={`${where}/view${query}&v=${shown.hash}`}
      download={`${where}${query}`}
      titleId={titleId}
      stepper={{
        at: at + 1,
        of: kept.length,
        label: "files in this Session",
        step: (by) => {
          const next = kept[at + by];

          if (next !== undefined) {
            open(
              { session: sessionId, file: `${next.place}/${next.path}` },
              { replace: true },
            );
          }
        },
      }}
      note={filesNote}
      onClose={onClose}
    />
  );
}

function maker(file: SessionFile, you: string): string {
  if (file.place === "outputs") {
    return "Pi wrote it";
  }

  return file.by === you ? "you added it" : "added";
}

// Gives the Session a file, which Pi finds in uploads/ under the name it
// returns.
async function sendUpload(
  api: ReturnType<typeof useApi>,
  sessionId: string,
  file: File,
  onSent: (sent: number) => void,
): Promise<string> {
  const { maxFileBytes } = await api.get<Limits>("limits");

  if (file.size > maxFileBytes) {
    throw new Error(
      `${file.name} is ${size(file.size)}. Files can be up to ${size(maxFileBytes)} on this server.`,
    );
  }

  const hash = await uploadBlob(api, file, onSent);

  const { path } = await api.post<{ path: string }>(
    `sessions/${sessionId}/uploads`,
    { name: file.name, hash },
  );

  return path;
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
  onUploading,
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
      const path = await sendUpload(api, session.id, file, (sent) => {
        change(file, { sent });
      });

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

  const uploading = files.some((file) => {
    const each = progress.get(file);

    return each?.path === undefined && each?.problem === undefined;
  });

  useEffect(() => {
    onUploading(uploading);
  }, [onUploading, uploading]);

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
