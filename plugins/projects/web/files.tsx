import {
  ago,
  AttachPicker,
  AttachRow,
  FileCard,
  FilesRow,
  FileViewer,
  type MountedSession,
  type NoticeProps,
  type SessionAttachProps,
  SessionSection,
  useAddFilesSessions,
  useApi,
  useLoaded,
  useNow,
  useOverlay,
  ViewerClose,
  viewerHeaderClass,
  ViewerLead,
  viewerShellClass,
  ViewerTitle,
  useFilled,
  type Attachment,
} from "@pipoca/plugins/web";
import { isHttpError, previewKind } from "@pipoca/plugins";
import { Dialog, plural } from "@pipoca/ui";
import { type ReactElement, useId, useState } from "react";
import { projects } from "../plugin";
import {
  bytes,
  type FolderFile,
  type FolderSavedData,
  type ProjectView,
} from "../src/model";
import { projectLink } from "./links";

type Named = FolderFile & { readonly by: string };

interface SessionFolder {
  readonly project: Pick<
    ProjectView,
    "id" | "name" | "team" | "assistant"
  > | null;
  readonly written?: readonly FolderFile[];
  readonly count?: number;
  // A coordinator's threads, whose files its Files list too.
  readonly threads?: readonly { readonly id: string; readonly title: string }[];
}

function useSessionFolder(sessionId: string): SessionFolder | undefined {
  const api = useApi(projects);

  return useLoaded(
    async () =>
      api.get<SessionFolder>(
        `sessions/${encodeURIComponent(sessionId)}/folder`,
      ),
    `folder:${sessionId}`,
    { changes: ["projects"] },
  ).value;
}

// What Pi's turn wrote in the Project folder, as cards under its reply.
export function FolderSavedCards({ data }: NoticeProps): ReactElement {
  const { open } = useOverlay();
  const { projectId, files = [] } = (data ?? {}) as Partial<FolderSavedData>;

  return (
    <ul
      aria-label="Files Pi saved in the Project folder"
      className="flex flex-wrap gap-2 py-1"
    >
      {files.map((file) => (
        <li key={file.path} className="min-w-0">
          <FileCard
            title={file.path}
            detail={`project folder · ${bytes(file.size)}`}
            onOpen={() => {
              if (projectId !== undefined) {
                open({ project: projectId, path: file.path });
              }
            }}
          />
        </li>
      ))}
    </ul>
  );
}

// The Project folder as a section of a Session's panel: what the Session
// wrote there, and the way to the whole folder (ADR 0081, ADR 0084).
export function ProjectFiles({
  session,
}: {
  readonly session: MountedSession;
}): ReactElement | null {
  const { open } = useOverlay();
  const value = useSessionFolder(session.id);
  const project = value?.project ?? null;
  const threads = value?.threads ?? [];

  useAddFilesSessions(
    threads.length === 0
      ? []
      : [{ id: session.id, title: "Coordinator" }, ...threads],
  );

  if (project === null) {
    return null;
  }

  const written = value?.written ?? [];

  const rows = written.map((file) => (
    <FilesRow
      key={file.path}
      name={file.path}
      detail="changed here"
      onOpen={() => {
        open({ project: project.id, path: file.path });
      }}
    />
  ));

  const folder = (
    <FilesRow
      icon="folder"
      name={`Open the ${project.name} folder`}
      detail={plural(value?.count ?? 0, "file")}
      onOpen={() => {
        location.hash = projectLink(project, "folder");
      }}
    />
  );

  return (
    <SessionSection
      name="project"
      order={15}
      label="Project folder"
      icon="folder"
      button={`Project folder, ${plural(written.length, "file")} changed here`}
      {...(written.length > 0 && { badge: String(written.length) })}
      {...(written.length > 2 && {
        detail: (
          <div className="flex flex-col">
            {rows}
            {folder}
          </div>
        ),
      })}
    >
      {rows.slice(0, 2)}
      {written.length > 2 && (
        <p className="px-1 text-caption text-fg-dim">{`${String(written.length - 2)} more`}</p>
      )}
      {folder}
    </SessionSection>
  );
}

// A file of a Project's folder over any page, from a Files menu, a card or
// the folder itself, until Esc, Back or Close.
export function ProjectFileOverlay(): ReactElement | null {
  const { params, close } = useOverlay();
  const titleId = useId();
  const id = params.get("project");
  const path = params.get("path");

  if (id === null || id === "" || path === null) {
    return null;
  }

  return (
    <Dialog key={id} open size="full" onClose={close} labelledBy={titleId}>
      <ProjectFileViewer
        id={id}
        path={path}
        titleId={titleId}
        onClose={close}
      />
    </Dialog>
  );
}

function ProjectFileViewer({
  id,
  path,
  titleId,
  onClose,
}: {
  readonly id: string;
  readonly path: string;
  readonly titleId: string;
  readonly onClose: () => void;
}): ReactElement {
  const api = useApi(projects);
  const { open } = useOverlay();
  const now = useNow();
  const publishes = useFilled("file.actions");
  const base = `projects/${encodeURIComponent(id)}`;

  const { value } = useLoaded(
    async () =>
      Promise.all([
        api.get<{ files: Named[] }>(`${base}/files`),
        api.get<ProjectView>(base),
      ]).catch((error: unknown) => {
        if (isHttpError(error) && error.status === 404) {
          return null;
        }

        throw error;
      }),
    id,
    { changes: ["projects"] },
  );

  const files = value?.[0].files ?? [];
  const at = files.findIndex((each) => each.path === path);
  const shown = files[at];

  if (shown === undefined) {
    return (
      <div className={viewerShellClass}>
        <header className={viewerHeaderClass}>
          <ViewerLead mode="modal" />
          <ViewerTitle mode="modal" titleId={titleId} title={path} line="" />
          <ViewerClose onClose={onClose} />
        </header>
        <p className="m-auto p-6 text-label text-fg-dim">
          {missing(value, path)}
        </p>
      </div>
    );
  }

  const query = `?path=${encodeURIComponent(shown.path)}`;

  return (
    <FileViewer
      key={path}
      name={shown.path}
      line={`project/ · ${bytes(shown.size)} · ${shown.by} changed it ${ago(new Date(shown.updatedAt).toISOString(), now)}`}
      size={shown.size}
      view={`/api/ext/projects/${base}/file/view${query}&v=${shown.hash}`}
      download={`/api/ext/projects/${base}/file${query}`}
      titleId={titleId}
      {...(value?.[1].steers === true && { session: value[1].coordinatorId })}
      stepper={{
        at: at + 1,
        of: files.length,
        label: "files in the folder",
        step: (by) => {
          const next = files[at + by];

          if (next !== undefined) {
            open({ project: id, path: next.path }, { replace: true });
          }
        },
      }}
      note={
        publishes && value?.[1].steers === true && publishable(shown.path)
          ? "Every Session in the Project sees this file in project/. Publish it as an artifact to share it and get comments."
          : "Every Session in the Project sees this file in project/."
      }
      onClose={onClose}
    />
  );
}

function missing(value: unknown, path: string): string {
  if (value === undefined) {
    return "Loading…";
  }

  return value === null
    ? "You can't open this Project's folder."
    : `The Project folder doesn't have ${path}.`;
}

// The composer's + menu: a file of the Project folder.
export function AttachFolderFile({
  session,
  add,
}: SessionAttachProps): ReactElement | null {
  const api = useApi(projects);
  const project = useSessionFolder(session.id)?.project ?? null;
  const [picking, setPicking] = useState(false);

  const { value } = useLoaded(
    async () =>
      picking && project !== null
        ? (
            await api.get<{ files: FolderFile[] }>(
              `projects/${project.id}/files`,
            )
          ).files
        : undefined,
    picking ? `attach:${project?.id ?? ""}` : "",
    { changes: ["projects"] },
  );

  if (project === null) {
    return null;
  }

  return (
    <>
      <AttachRow
        icon="folder"
        label={`From the ${project.name} folder…`}
        onPick={() => {
          setPicking(true);
        }}
      />
      <AttachPicker
        open={picking}
        title={`Attach from the ${project.name} folder`}
        items={value?.map((each) => ({
          key: each.path,
          title: each.path,
          detail: bytes(each.size),
        }))}
        empty="The folder has no files yet."
        onPick={(path) => {
          add(folderAttachment(path));
        }}
        onClose={() => {
          setPicking(false);
        }}
      />
    </>
  );
}

// A Project folder file goes with a message by its path, which Pi reads in
// project/; nothing is copied.
export function folderAttachment(path: string): Attachment {
  return {
    key: `project:${path}`,
    title: path,
    icon: "folder",
    detail: "from project/ · already saved",
    text: `Attached: ${JSON.stringify(path)} from the Project's shared folder; list_project_files gives its full path.`,
  };
}

// What makes an artifact: a page, document, picture, PDF or table, not plain
// text or code.
export function publishable(path: string): boolean {
  const kind = previewKind(path.split("/").at(-1) ?? path);

  return kind !== undefined && kind !== "text";
}
