import { owners, type Store } from "@pipoca/plugins";
import type { Actor, Clock, Owner } from "@pipoca/protocol";
import type {
  LibraryFile,
  LibraryWrite,
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
  "name" | "goal" | "instructions" | "threadModel" | "profileId"
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
    files: (projectId: string): readonly LibraryFile[] =>
      store
        .all<{ name: string; size: number; actor: string; updated_at: number }>(
          "select name, size, actor, updated_at from projects_files where project_id = ? order by name",
          projectId,
        )
        .map((row) => ({
          name: row.name,
          size: row.size,
          actor: row.actor,
          updatedAt: new Date(row.updated_at).toISOString(),
        })),
    readFile: (projectId: string, name: string): Uint8Array | undefined =>
      store.get<{ content: Uint8Array }>(
        "select content from projects_file_contents where project_id = ? and name = ?",
        projectId,
        name,
      )?.content,
    // A write replaces the file, and every write is logged (ADR 0018).
    writeFile: (
      projectId: string,
      name: string,
      content: Uint8Array,
      actor: Actor,
    ): void => {
      const at = clock.now();

      store.transaction(() => {
        store.run(
          `insert into projects_files (project_id, name, size, actor, updated_at)
            values (?, ?, ?, ?, ?)
            on conflict (project_id, name) do update set size = excluded.size, actor = excluded.actor, updated_at = excluded.updated_at`,
          projectId,
          name,
          content.length,
          actor,
          at,
        );

        store.run(
          `insert into projects_file_contents (project_id, name, content) values (?, ?, ?)
            on conflict (project_id, name) do update set content = excluded.content`,
          projectId,
          name,
          content,
        );

        store.run(
          "insert into projects_file_log (id, project_id, name, size, actor, at) values (?, ?, ?, ?, ?, ?)",
          Bun.randomUUIDv7(),
          projectId,
          name,
          content.length,
          actor,
          at,
        );
      });
    },
    writes: (projectId: string): readonly LibraryWrite[] =>
      store
        .all<{ name: string; size: number; actor: string; at: number }>(
          "select name, size, actor, at from projects_file_log where project_id = ? order by id desc limit 50",
          projectId,
        )
        .map((row) => ({ ...row, at: new Date(row.at).toISOString() })),
  };
}
