import { errorText } from "@pipoca/protocol";
import {
  ago,
  AttachedCard,
  ConfigForm,
  defineWeb,
  FileCard,
  FilesRow,
  FilesSection,
  FileViewer,
  type MountedSession,
  type NoticeProps,
  type SessionFilesProps,
  uploadBlob,
  useApi,
  useCoveredFiles,
  useFileItems,
  useFilesSessions,
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
  Button,
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
  type SavedNoticeData,
  type SessionFile,
  type SnapshotChange,
} from "../src/files";

export const web = defineWeb(plugin, {
  settings: { group: "server", Section: FilesSettings },
  slots: {
    "session.panel": SessionFiles,
    "session.files": Attached,
    "notice:files": UploadNotice,
    "notice:saved": SavedCards,
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
    async () =>
      api.get<Kept>(`sessions/${encodeURIComponent(sessionId)}/files`),
    sessionId,
    { changes: ["files"] },
  ).value;
}

// The files of the other Sessions the Files section lists, such as a
// Project coordinator's threads.
function useOtherFiles(
  sessions: readonly { readonly id: string; readonly title: string }[],
): readonly Listed[] {
  const api = useApi(plugin);
  const key = sessions.map(({ id }) => id).join(",");

  return (
    useLoaded(
      async () =>
        Promise.all(
          sessions.map(async ({ id, title }) => ({
            id,
            title,
            ...(await api.get<Kept>(
              `sessions/${encodeURIComponent(id)}/files`,
            )),
          })),
        ),
      `others:${key}`,
      { changes: ["files"] },
    ).value ?? noOthers
  );
}

interface Listed extends Kept {
  readonly id: string;
  readonly title: string;
}

const noOthers: readonly Listed[] = [];

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
  const sessions = useFilesSessions(session.id);
  const ownShown = sessions.some(({ id }) => id === session.id);
  const own = sessions.find(({ id }) => id === session.id)?.title ?? "";
  const others = useOtherFiles(sessions.filter(({ id }) => id !== session.id));

  const kept = listed?.files ?? none;

  const all: readonly Listed[] = [
    ...(ownShown && listed !== undefined
      ? [{ ...listed, id: session.id, title: own }]
      : []),
    ...others,
  ];

  const state = useSessionState<FilesState>(session, "files");
  const unsaved = state?.unsaved ?? [];
  const api = useApi(plugin);
  const { open } = useOverlay();
  const [uploadProblem, setUploadProblem] = useState<string>();
  const [sending, setSending] = useState(false);
  const covered = useCoveredFiles();
  const [showCovered, setShowCovered] = useState(false);
  const fileItems = useFileItems();

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

  const hidden = (file: SessionFile): boolean =>
    file.place === "outputs" && !showCovered && covered.has(file.hash);

  const entries = all.flatMap((each) =>
    each.files.map((file) => ({ ...file, from: each })),
  );

  const hiddenCount = entries.filter(hidden).length;

  const rows = (place: Place) => (filter: string) => {
    const shown = entries.filter(
      (file) =>
        file.place === place &&
        !hidden(file) &&
        [file.path, file.from.title].some((text) =>
          text.toLowerCase().includes(filter),
        ),
    );

    return shown.length === 0
      ? null
      : shown.map((file) => {
          const { id, title, steers } = file.from;
          const download = `/api/ext/files/sessions/${id}/files/${place}?path=${encodeURIComponent(file.path)}`;

          const show = (): void => {
            open({ session: id, file: `${place}/${file.path}` });
          };

          return (
            <FilesRow
              key={`${id}:${file.path}`}
              name={file.path}
              detail={[
                ...(title === "" ? [] : [title]),
                id === session.id &&
                place === "outputs" &&
                unsaved.includes(file.path)
                  ? "not saved"
                  : size(file.size),
              ].join(" · ")}
              actions={[
                { label: "Open", icon: "file", run: show },
                {
                  label: "Download",
                  icon: "download",
                  run: () => {
                    downloadFrom(download, file.path);
                  },
                },
                ...(steers
                  ? fileItems({ session: id, file: file.path, download })
                  : []),
              ]}
              onOpen={show}
            />
          );
        });
  };

  const count = (place: Place): number =>
    entries.filter((file) => file.place === place && !hidden(file)).length;

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
      <FilesSection name="outputs-covered" order={21} count={0}>
        {() =>
          hiddenCount === 0 ? null : (
            <p className="px-1 text-caption text-fg-dim">
              {`${plural(hiddenCount, "file is", "files are")} part of the artifacts above. `}
              <button
                type="button"
                className="text-accent hover:underline"
                onClick={() => {
                  setShowCovered(true);
                }}
              >
                Show them
              </button>
            </p>
          )
        }
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

function downloadFrom(url: string, path: string): void {
  const link = document.createElement("a");

  link.href = url;
  link.download = path.split("/").at(-1) ?? path;
  link.click();
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
            onProblem(errorText(error));
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
      {...(listed?.steers === true && { session: sessionId })}
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
    `sessions/${encodeURIComponent(sessionId)}/uploads`,
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
            problem: errorText(error),
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
    <ul aria-label="Attached files" className="flex flex-wrap gap-2">
      {files.map((file, index) => {
        const each = progress.get(file) ?? { sent: 0 };
        const saving = each.path === undefined && each.problem === undefined;

        return (
          <li key={`${String(index)}-${file.name}`} className="min-w-0">
            <AttachedCard
              icon="file"
              title={file.name}
              detail={status(file.size, each)}
              failed={each.problem !== undefined}
              {...(saving && {
                progress: file.size === 0 ? 0 : each.sent / file.size,
              })}
              onRemove={() => {
                onRemove(file);
              }}
            />
          </li>
        );
      })}
    </ul>
  );
}

function status(total: number, { sent, path, problem }: Progress): string {
  if (problem !== undefined) {
    return `Not saved: ${problem}`;
  }

  if (path !== undefined) {
    return `${size(total)} · saved`;
  }

  return total === 0
    ? "Saving"
    : `Saving · ${String(Math.floor((sent / total) * 100))}%`;
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

// The outputs Pi's turn wrote, as cards under its reply, like Claude Code's
// attached files. Each opens in the viewer.
// A turn that saves many files shows a few, so they don't bury the chat.
const savedShown = 4;

function SavedCards({ data, session }: NoticeProps): ReactElement {
  const { open } = useOverlay();
  const [all, setAll] = useState(false);
  const { files = [] } = (data ?? {}) as Partial<SavedNoticeData>;
  const shown = all ? files : files.slice(0, savedShown);
  const more = files.length - shown.length;

  return (
    <ul aria-label="Files Pi saved" className="flex flex-wrap gap-2 py-1">
      {shown.map((file) => (
        <li key={file.path} className="min-w-0">
          <FileCard
            title={file.path}
            detail={`outputs · ${size(file.size)}`}
            onOpen={() => {
              open({ session: session.id, file: `outputs/${file.path}` });
            }}
          />
        </li>
      ))}
      {more > 0 && (
        <li>
          <Button
            variant="ghost"
            className="h-10"
            onClick={() => {
              setAll(true);
            }}
          >
            {plural(more, "more file", "more files")}
          </Button>
        </li>
      )}
    </ul>
  );
}
