import type { PluginStore } from "@pipoca/plugins";
import type { Actor } from "@pipoca/protocol";
import type { MemoryFileView, ProjectNotice, Role, WorkState } from "./model";

export interface Project {
  readonly id: string;
  readonly ownerId: string;
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
  readonly createdAt: string;
  // The person's Pipoca assistant, which has no repositories and stays out
  // of the Project list (ADR 0052).
  readonly assistant: boolean;
  // The team's, with its coordinator and threads on team Profiles and
  // Environments (ADR 0067).
  readonly team: boolean;
}

export interface Member {
  readonly sessionId: string;
  readonly projectId: string;
  readonly role: Role;
  readonly title: string;
  readonly workState: WorkState;
  readonly lastActivity: string;
}

// Deliveries queued before notices existed have none.
export type Delivery =
  | {
      readonly kind: "context" | "message";
      readonly text: string;
      readonly notice?: ProjectNotice;
    }
  // end is how many transcript lines the thread's turn ended with.
  | { readonly kind: "turn"; readonly threadId: string; readonly end?: number };

export interface Queued {
  readonly id: number;
  readonly sessionId: string;
  readonly actor: Actor;
  readonly delivery: Delivery;
}

interface ProjectRow {
  id: string;
  owner_user_id: string;
  name: string;
  goal: string;
  instructions: string;
  environment_id: string | null;
  profile_id: string | null;
  thread_model: string | null;
  coordinator_id: string;
  created_at: number;
  assistant: number;
  team: number;
}

interface MemberRow {
  session_id: string;
  project_id: string;
  role: Role;
  title: string;
  work_state: WorkState;
  last_activity_at: number;
}

// A team Project keeps the person who made it as its owner, with team set
// (ADR 0067).
export const projectsSchema = `
create table projects_projects (
  id text primary key,
  owner_user_id text not null references users (id) on delete cascade,
  name text not null,
  goal text not null default '',
  instructions text not null,
  environment_id text references environments (id) on delete set null,
  profile_id text,
  thread_model text,
  coordinator_id text not null,
  assistant integer not null check (assistant in (0, 1)),
  team integer not null check (team in (0, 1)),
  created_at integer not null
) strict;
create index projects_projects_owner on projects_projects (owner_user_id);

create table projects_repositories (
  project_id text not null references projects_projects (id) on delete cascade,
  position integer not null,
  repository text not null,
  primary key (project_id, position)
) strict, without rowid;

create table projects_members (
  session_id text primary key references sessions (id) on delete cascade,
  project_id text not null references projects_projects (id) on delete cascade,
  role text not null check (role in ('coordinator', 'thread', 'former')),
  title text not null,
  work_state text not null check (work_state in ('in_progress', 'blocked', 'review_ready', 'done', 'failed')),
  last_activity_at integer not null
) strict;
create index projects_members_project on projects_members (project_id, role);

create table projects_memory (
  project_id text not null references projects_projects (id) on delete cascade,
  name text not null,
  content text not null,
  revision integer not null default 1,
  actor text not null,
  updated_at integer not null,
  primary key (project_id, name)
) strict, without rowid;

create table projects_memory_log (
  id integer primary key,
  project_id text not null references projects_projects (id) on delete cascade,
  name text not null,
  size integer not null,
  actor text not null,
  at integer not null
) strict;
create index projects_memory_log_project on projects_memory_log (project_id, at);

create table projects_outbox (
  id integer primary key,
  session_id text not null references sessions (id) on delete cascade,
  actor text not null,
  delivery text not null check (json_valid(delivery))
) strict;
create index projects_outbox_session on projects_outbox (session_id);
`;

const memoryLimit = 16 * 1024;

export interface MemoryFile {
  readonly content: string;
  readonly revision: number;
}

export interface ProjectStore {
  readonly create: (project: Project) => void;
  readonly list: () => readonly Project[];
  readonly get: (id: string) => Project | undefined;
  readonly update: (
    id: string,
    settings: Pick<
      Project,
      "name" | "goal" | "instructions" | "threadModel" | "profileId"
    >,
  ) => void;
  readonly addMember: (member: Member) => void;
  readonly member: (sessionId: string) => Member | undefined;
  readonly threads: (projectId: string) => readonly Member[];
  readonly formers: (projectId: string) => readonly Member[];
  readonly replaceCoordinator: (project: Project, next: Member) => void;
  readonly setWorkState: (sessionId: string, state: WorkState) => void;
  readonly touch: (sessionId: string) => void;
  readonly memory: (projectId: string) => readonly MemoryFileView[];
  readonly readMemory: (
    projectId: string,
    name: string,
  ) => MemoryFile | undefined;
  // A file that exists changes only on top of the revision it is at.
  readonly writeMemory: (
    projectId: string,
    name: string,
    content: string,
    actor: Actor,
    revision?: number,
  ) => void;
  readonly enqueue: (
    sessionId: string,
    actor: Actor,
    delivery: Delivery,
  ) => void;
  readonly queued: () => readonly Queued[];
  readonly delivered: (id: number) => void;
}

export function projectStore(
  store: PluginStore,
  memberAdded: (member: Member) => void,
): ProjectStore {
  const repositoriesOf = (projectId: string): readonly string[] =>
    (
      store.all(
        "select repository from projects_repositories where project_id = ? order by position",
        projectId,
      ) as { repository: string }[]
    ).map(({ repository }) => repository);

  const toProject = (row: ProjectRow): Project => ({
    id: row.id,
    ownerId: row.owner_user_id,
    name: row.name,
    goal: row.goal,
    instructions: row.instructions,
    repositories: repositoriesOf(row.id),
    environmentId: row.environment_id,
    profileId: row.profile_id,
    threadModel: row.thread_model,
    coordinatorId: row.coordinator_id,
    createdAt: new Date(row.created_at).toISOString(),
    assistant: row.assistant === 1,
    team: row.team === 1,
  });

  const toMember = (row: MemberRow): Member => ({
    sessionId: row.session_id,
    projectId: row.project_id,
    role: row.role,
    title: row.title,
    workState: row.work_state,
    lastActivity: new Date(row.last_activity_at).toISOString(),
  });

  // A delivery marked delivered is never read back, even when its delete
  // failed: the delete is tried again each time, and the queue skips it
  // meanwhile, so nothing is sent twice and the rest still goes out.
  const deliveredIds = new Set<number>();

  const deleteDelivered = (): void => {
    for (const id of deliveredIds) {
      store.run("delete from projects_outbox where id = ?", id);
      deliveredIds.delete(id);
    }
  };

  const insertMember = (member: Member): void => {
    store.run(
      `insert into projects_members
        (session_id, project_id, role, title, work_state, last_activity_at)
        values (?, ?, ?, ?, ?, ?)`,
      member.sessionId,
      member.projectId,
      member.role,
      member.title,
      member.workState,
      Date.parse(member.lastActivity),
    );
  };

  const moveToCoordinator = (project: Project, next: Member): void => {
    store.run(
      "update projects_outbox set session_id = ? where session_id = ?",
      next.sessionId,
      project.coordinatorId,
    );

    store.run(
      "update projects_members set role = 'former' where session_id = ?",
      project.coordinatorId,
    );

    store.run(
      "update projects_projects set coordinator_id = ? where id = ?",
      next.sessionId,
      project.id,
    );

    insertMember(next);
  };

  return {
    create: (project) => {
      store.transaction(() => {
        store.run(
          `insert into projects_projects
            (id, owner_user_id, name, goal, instructions, environment_id, profile_id, thread_model, coordinator_id, created_at, assistant, team)
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          project.id,
          project.ownerId,
          project.name,
          project.goal,
          project.instructions,
          project.environmentId,
          project.profileId,
          project.threadModel,
          project.coordinatorId,
          Date.parse(project.createdAt),
          project.assistant ? 1 : 0,
          project.team ? 1 : 0,
        );

        project.repositories.forEach((repository, position) => {
          store.run(
            "insert into projects_repositories (project_id, position, repository) values (?, ?, ?)",
            project.id,
            position,
            repository,
          );
        });
      });
    },
    list: () =>
      (
        store.all(
          "select * from projects_projects order by created_at",
        ) as ProjectRow[]
      ).map(toProject),
    get: (id) => {
      const [row] = store.all(
        "select * from projects_projects where id = ?",
        id,
      ) as ProjectRow[];

      return row && toProject(row);
    },
    update: (id, { name, goal, instructions, threadModel, profileId }) => {
      store.run(
        `update projects_projects
          set name = ?, goal = ?, instructions = ?, thread_model = ?, profile_id = ? where id = ?`,
        name,
        goal,
        instructions,
        threadModel,
        profileId,
        id,
      );
    },
    addMember: (member) => {
      insertMember(member);
      memberAdded(member);
    },
    member: (sessionId) => {
      const [row] = store.all(
        "select * from projects_members where session_id = ?",
        sessionId,
      ) as MemberRow[];

      return row && toMember(row);
    },
    threads: (projectId) =>
      (
        store.all(
          `select * from projects_members
            where project_id = ? and role = 'thread'
            order by rowid`,
          projectId,
        ) as MemberRow[]
      ).map(toMember),
    formers: (projectId) =>
      (
        store.all(
          `select * from projects_members
            where project_id = ? and role = 'former'
            order by rowid`,
          projectId,
        ) as MemberRow[]
      ).map(toMember),
    // What waits for the old coordinator goes to the new one.
    replaceCoordinator: (project, next) => {
      store.transaction(() => {
        moveToCoordinator(project, next);
      });

      memberAdded(next);
    },
    setWorkState: (sessionId, state) => {
      store.run(
        "update projects_members set work_state = ? where session_id = ?",
        state,
        sessionId,
      );
    },
    touch: (sessionId) => {
      store.run(
        "update projects_members set last_activity_at = ? where session_id = ?",
        Date.now(),
        sessionId,
      );
    },
    memory: (projectId) =>
      (
        store.all(
          `select name, length(cast(content as blob)) as size, updated_at, actor
            from projects_memory where project_id = ? order by name`,
          projectId,
        ) as { name: string; size: number; updated_at: number; actor: string }[]
      ).map((row) => ({
        name: row.name,
        size: row.size,
        updatedAt: new Date(row.updated_at).toISOString(),
        actor: row.actor,
      })),
    readMemory: (projectId, name) => {
      const [row] = store.all(
        "select content, revision from projects_memory where project_id = ? and name = ?",
        projectId,
        name,
      ) as MemoryFile[];

      return row;
    },
    writeMemory: (projectId, name, content, actor, revision) => {
      const size = new TextEncoder().encode(content).length;

      if (size > memoryLimit) {
        throw new Error(
          `memory files are limited to ${String(memoryLimit / 1024)} KB`,
        );
      }

      const [current] = store.all(
        "select revision from projects_memory where project_id = ? and name = ?",
        projectId,
        name,
      ) as { revision: number }[];

      if (current !== undefined && current.revision !== revision) {
        throw new Error(
          `${name} is at revision ${String(current.revision)}: read it, then write your change on top of what it says now`,
        );
      }

      const at = Date.now();

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
        `insert into projects_memory_log (project_id, name, size, actor, at)
          values (?, ?, ?, ?, ?)`,
        projectId,
        name,
        size,
        actor,
        at,
      );
    },
    enqueue: (sessionId, actor, delivery) => {
      store.run(
        "insert into projects_outbox (session_id, actor, delivery) values (?, ?, ?)",
        sessionId,
        actor,
        JSON.stringify(delivery),
      );
    },
    queued: () => {
      try {
        deleteDelivered();
      } catch {
        // delivered() already reported it, and the ids stay marked.
      }

      return (
        store.all("select * from projects_outbox order by id") as {
          id: number;
          session_id: string;
          actor: Actor;
          delivery: string;
        }[]
      )
        .filter((row) => !deliveredIds.has(row.id))
        .map((row) => ({
          id: row.id,
          sessionId: row.session_id,
          actor: row.actor,
          delivery: JSON.parse(row.delivery) as Delivery,
        }));
    },
    delivered: (id) => {
      deliveredIds.add(id);
      deleteDelivered();
    },
  };
}
