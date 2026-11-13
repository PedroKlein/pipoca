import { owners, type Store } from "@pipoca/plugins";
import type { Actor, Clock, Owner } from "@pipoca/protocol";
import type {
  FolderFile,
  FolderWrite,
  MemoryFileView,
  Role,
  WorkState,
} from "./model";

export interface Project {
  readonly id: string;
  readonly owner: Owner;
  // The person whose assistant this is, which has no repositories and stays
  // out of the Project list (ADR 0052).
  readonly assistantOf: string | null;
  readonly name: string;
  // What the Project is for, in the context of the coordinator and every
  // thread, never sent as a message (ADR 0040).
  readonly goal: string;
  readonly instructions: string;
  readonly repositories: readonly string[];
  readonly environmentId: string | null;
  // The Profile new threads run with when start_thread names none (ADR 0031).
  readonly profileId: string | null;
  // provider/id for threads that start_thread gives no model.
  readonly threadModel: string | null;
  readonly coordinatorId: string;
  readonly createdAt: number;
}

export interface Member {
  readonly sessionId: string;
  readonly projectId: string;
  readonly role: Role;
  readonly title: string;
  readonly workState: WorkState;
  readonly lastActivity: number;
}

export type Settings = Pick<
  Project,
  | "name"
  | "goal"
  | "instructions"
  | "threadModel"
  | "profileId"
  | "repositories"
>;

interface ProjectRow {
  readonly id: string;
  readonly owner_user_id: string | null;
  readonly assistant_of: string | null;
  readonly name: string;
  readonly goal: string;
  readonly instructions: string;
  readonly environment_id: string | null;
  readonly profile_id: string | null;
  readonly thread_model: string | null;
  readonly created_at: number;
  readonly coordinator_id: string | null;
}

interface MemberRow {
  readonly session_id: string;
  readonly project_id: string;
  readonly role: Role;
  readonly title: string;
  readonly work_state: WorkState;
  readonly last_activity_at: number;
}

const memoryLimit = 16 * 1024;

const selectProjects = `
  select p.*, t.session_id as coordinator_id from projects_projects p
  left join projects_threads t on t.project_id = p.id and t.role = 'coordinator'`;

export type ProjectStore = ReturnType<typeof projectStore>;

// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types -- its type is what it returns, named ProjectStore
export function projectStore(store: Store, clock: Clock) {
  const repositoriesOf = (projectId: string): readonly string[] =>
    store
      .all<{ repository: string }>(
        "select repository from projects_repositories where project_id = ? order by position",
        projectId,
      )
      .map(({ repository }) => repository);

  const toProject = (row: ProjectRow): Project => ({
    id: row.id,
    owner: owners.fromSql(row.owner_user_id),
    assistantOf: row.assistant_of,
    name: row.name,
    goal: row.goal,
    instructions: row.instructions,
    repositories: repositoriesOf(row.id),
    environmentId: row.environment_id,
    profileId: row.profile_id,
    threadModel: row.thread_model,
    coordinatorId: row.coordinator_id ?? "",
    createdAt: row.created_at,
  });

  const toMember = (row: MemberRow): Member => ({
    sessionId: row.session_id,
    projectId: row.project_id,
    role: row.role,
    title: row.title,
    workState: row.work_state,
    lastActivity: row.last_activity_at,
  });

  const addMember = (member: Omit<Member, "lastActivity">): void => {
    store.run(
      `insert into projects_threads
        (session_id, project_id, role, title, work_state, last_activity_at)
        values (?, ?, ?, ?, ?, ?)`,
      member.sessionId,
      member.projectId,
      member.role,
      member.title,
      member.workState,
      clock.now(),
    );
  };

  const membersOf = (projectId: string, role: Role): readonly Member[] =>
    store
      .all<MemberRow>(
        "select * from projects_threads where project_id = ? and role = ? order by rowid",
        projectId,
        role,
      )
      .map(toMember);

  return {
    // A Project and its coordinator, which already started.
    create: (
      project: Omit<Project, "coordinatorId" | "createdAt">,
      coordinatorId: string,
    ): void => {
      store.transaction(() => {
        store.run(
          `insert into projects_projects
            (id, owner_user_id, assistant_of, name, goal, instructions, environment_id, profile_id, thread_model, created_at)
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          project.id,
          owners.toSql(project.owner),
          project.assistantOf,
          project.name,
          project.goal,
          project.instructions,
          project.environmentId,
          project.profileId,
          project.threadModel,
          clock.now(),
        );

        project.repositories.forEach((repository, position) => {
          store.run(
            "insert into projects_repositories (project_id, position, repository) values (?, ?, ?)",
            project.id,
            position,
            repository,
          );
        });

        addMember({
          sessionId: coordinatorId,
          projectId: project.id,
          role: "coordinator",
          title: "Coordinator",
          workState: "in_progress",
        });
      });
    },
    list: (): readonly Project[] =>
      store
        .all<ProjectRow>(`${selectProjects} order by p.created_at, p.id`)
        .map(toProject),
    get: (id: string): Project | undefined => {
      const row = store.get<ProjectRow>(`${selectProjects} where p.id = ?`, id);

      return row && toProject(row);
    },
    assistant: (owner: Owner, person: string): Project | undefined => {
      const row = store.get<ProjectRow>(
        `${selectProjects} where p.assistant_of = ? and p.owner_user_id is ?`,
        person,
        owners.toSql(owner),
      );

      return row && toProject(row);
    },
    update: (id: string, settings: Settings): void => {
      store.run(
        `update projects_projects
          set name = ?, goal = ?, instructions = ?, thread_model = ?, profile_id = ? where id = ?`,
        settings.name,
        settings.goal,
        settings.instructions,
        settings.threadModel,
        settings.profileId,
        id,
      );

      store.run("delete from projects_repositories where project_id = ?", id);

      settings.repositories.forEach((repository, position) => {
        store.run(
          "insert into projects_repositories (project_id, position, repository) values (?, ?, ?)",
          id,
          position,
          repository,
        );
      });
    },
    addThread: (projectId: string, sessionId: string, title: string): void => {
      addMember({
        sessionId,
        projectId,
        role: "thread",
        title,
        workState: "in_progress",
      });
    },
    member: (sessionId: string): Member | undefined => {
      const row = store.get<MemberRow>(
        "select * from projects_threads where session_id = ?",
        sessionId,
      );

      return row && toMember(row);
    },
    threads: (projectId: string): readonly Member[] =>
      membersOf(projectId, "thread"),
    formers: (projectId: string): readonly Member[] =>
      membersOf(projectId, "former"),
    replaceCoordinator: (project: Project, next: string): void => {
      store.transaction(() => {
        store.run(
          "update projects_threads set role = 'former' where session_id = ?",
          project.coordinatorId,
        );

        addMember({
          sessionId: next,
          projectId: project.id,
          role: "coordinator",
          title: "Coordinator",
          workState: "in_progress",
        });
      });
    },
    setWorkState: (sessionId: string, state: WorkState): void => {
      store.run(
        "update projects_threads set work_state = ? where session_id = ?",
        state,
        sessionId,
      );
    },
    touch: (sessionId: string): void => {
      store.run(
        "update projects_threads set last_activity_at = ? where session_id = ?",
        clock.now(),
        sessionId,
      );
    },
    memory: (projectId: string): readonly MemoryFileView[] =>
      store
        .all<{ name: string; size: number; updated_at: number; actor: string }>(
          `select name, length(cast(content as blob)) as size, updated_at, actor
            from projects_memory where project_id = ? order by name`,
          projectId,
        )
        .map((row) => ({
          name: row.name,
          size: row.size,
          updatedAt: new Date(row.updated_at).toISOString(),
          actor: row.actor,
        })),
    readMemory: (
      projectId: string,
      name: string,
    ): { readonly content: string; readonly revision: number } | undefined =>
      store.get(
        "select content, revision from projects_memory where project_id = ? and name = ?",
        projectId,
        name,
      ),
    // A file that exists changes only on top of the revision it is at.
    writeMemory: (
      projectId: string,
      name: string,
      content: string,
      actor: Actor,
      revision: number | undefined,
    ): void => {
      const size = new TextEncoder().encode(content).length;

      if (size > memoryLimit) {
        throw new Error(
          `memory files are limited to ${String(memoryLimit / 1024)} KB`,
        );
      }

      const current = store.get<{ revision: number }>(
        "select revision from projects_memory where project_id = ? and name = ?",
        projectId,
        name,
      );

      if (current !== undefined && current.revision !== revision) {
        throw new Error(
          `${name} is at revision ${String(current.revision)}: read it, then write your change on top of what it says now`,
        );
      }

      const at = clock.now();

      store.transaction(() => {
        store.run(
          `insert into projects_memory (project_id, name, content, updated_at, actor, revision)
            values (?, ?, ?, ?, ?, 1)
            on conflict (project_id, name) do update set
              content = excluded.content,
              updated_at = excluded.updated_at,
              actor = excluded.actor,
              revision = revision + 1`,
          projectId,
          name,
          content,
          at,
          actor,
        );

        store.run(
          "insert into projects_memory_log (id, project_id, name, size, actor, at) values (?, ?, ?, ?, ?, ?)",
          Bun.randomUUIDv7(),
          projectId,
          name,
          size,
          actor,
          at,
        );
      });
    },
    folder: (projectId: string): readonly FolderFile[] =>
      store
        .all<FolderRow>(
          `select ${folderColumns} from projects_folder where project_id = ? order by path`,
          projectId,
        )
        .map(folderFile),
    folderFile: (projectId: string, path: string): FolderFile | undefined => {
      const row = store.get<FolderRow>(
        `select ${folderColumns} from projects_folder where project_id = ? and path = ?`,
        projectId,
        path,
      );

      return row && folderFile(row);
    },
    // A write replaces or removes the file, and every write is logged with
    // its hash, which keeps the earlier version until the log forgets it.
    writeFolder: (
      projectId: string,
      write: Omit<FolderWrite, "id" | "at">,
    ): void => {
      const at = clock.now();

      store.transaction(() => {
        if (write.hash === null) {
          store.run(
            "delete from projects_folder where project_id = ? and path = ?",
            projectId,
            write.path,
          );
        } else {
          store.run(
            `insert into projects_folder (project_id, path, hash, size, actor, updated_at)
              values (?, ?, ?, ?, ?, ?)
              on conflict (project_id, path) do update set hash = excluded.hash, size = excluded.size, actor = excluded.actor, updated_at = excluded.updated_at`,
            projectId,
            write.path,
            write.hash,
            write.size,
            write.actor,
            at,
          );
        }

        store.run(
          "insert into projects_folder_log (id, project_id, path, hash, size, actor, conflict, at) values (?, ?, ?, ?, ?, ?, ?, ?)",
          Bun.randomUUIDv7(),
          projectId,
          write.path,
          write.hash,
          write.size,
          write.actor,
          write.conflict ? 1 : 0,
          at,
        );
      });
    },
    folderWrites: (projectId: string): readonly FolderWrite[] =>
      store
        .all<LogRow>(
          `select ${logColumns} from projects_folder_log where project_id = ? order by id desc limit 50`,
          projectId,
        )
        .map(folderWrite),
    folderWrite: (projectId: string, id: string): FolderWrite | undefined => {
      const row = store.get<LogRow>(
        `select ${logColumns} from projects_folder_log where project_id = ? and id = ?`,
        projectId,
        id,
      );

      return row && folderWrite(row);
    },
    // Forgets writes made before the time and returns the hashes they named.
    forgetWrites: (before: number): readonly string[] => {
      const hashes = store
        .all<{ hash: string }>(
          "select distinct hash from projects_folder_log where at < ? and hash is not null",
          before,
        )
        .map(({ hash }) => hash);

      store.run("delete from projects_folder_log where at < ?", before);

      return hashes;
    },
    hashUsed: (hash: string): boolean =>
      store.get<{ one: number }>(
        `select 1 as one from projects_folder where hash = ?1
         union all select 1 from projects_folder_log where hash = ?1 limit 1`,
        hash,
      ) !== undefined,
    // The library's files from before the folder (ADR 0018), one at a time.
    nextLibraryFile: ():
      | {
          readonly projectId: string;
          readonly name: string;
          readonly actor: string;
          readonly content: Uint8Array;
        }
      | undefined => {
      const row = store.get<{
        project_id: string;
        name: string;
        actor: string;
        content: Uint8Array;
      }>(
        `select f.project_id, f.name, f.actor, c.content
         from projects_files f join projects_file_contents c using (project_id, name)
         limit 1`,
      );

      return (
        row && {
          projectId: row.project_id,
          name: row.name,
          actor: row.actor,
          content: row.content,
        }
      );
    },
    dropLibraryFile: (projectId: string, name: string): void => {
      store.transaction(() => {
        store.run(
          "delete from projects_file_log where project_id = ? and name = ?",
          projectId,
          name,
        );

        store.run(
          "delete from projects_files where project_id = ? and name = ?",
          projectId,
          name,
        );
      });
    },
  };
}

interface FolderRow {
  readonly path: string;
  readonly hash: string;
  readonly size: number;
  readonly actor: string;
  readonly updated_at: number;
}

const folderColumns = "path, hash, size, actor, updated_at";

function folderFile(row: FolderRow): FolderFile {
  return {
    path: row.path,
    hash: row.hash,
    size: row.size,
    actor: row.actor,
    updatedAt: row.updated_at,
  };
}

interface LogRow {
  readonly id: string;
  readonly path: string;
  readonly hash: string | null;
  readonly size: number;
  readonly actor: string;
  readonly conflict: number;
  readonly at: number;
}

const logColumns = "id, path, hash, size, actor, conflict, at";

function folderWrite(row: LogRow): FolderWrite {
  return { ...row, conflict: row.conflict === 1 };
}
