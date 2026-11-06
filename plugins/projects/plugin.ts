import { Config, definePlugin } from "@pipoca/plugins";

// A Project is a person's, or the team's when owner_user_id is null. An
// assistant Project names the person whose assistant it is (ADR 0052,
// ADR 0067). Its coordinator is the member with that role.
export const projects = definePlugin({
  id: "projects",
  title: "Projects",
  description:
    "Groups Sessions around a coordinator that works across repositories, with shared memory and files, and runs the Pipoca assistant.",
  config: Config.object({
    fileLimitMb: Config.number({
      title: "Library file size limit in MB",
      description:
        "The largest file a person or a Session can add to a Project's library.",
      default: 10,
      min: 1,
      max: 100,
    }),
  }),
  schema: `
create table projects_projects (
  id text primary key,
  owner_user_id text references users (id) on delete cascade,
  assistant_of text references users (id) on delete cascade,
  name text not null,
  goal text not null default '',
  instructions text not null default '',
  environment_id text references environments (id) on delete set null,
  profile_id text,
  thread_model text,
  created_at integer not null
) strict;
create index projects_projects_owner on projects_projects (owner_user_id);
create unique index projects_projects_assistant on projects_projects (coalesce(owner_user_id, ''), assistant_of) where assistant_of is not null;

create table projects_repositories (
  project_id text not null references projects_projects (id) on delete cascade,
  position integer not null,
  repository text not null,
  primary key (project_id, position)
) strict, without rowid;

create table projects_threads (
  session_id text primary key references sessions (id) on delete cascade,
  project_id text not null references projects_projects (id) on delete cascade,
  role text not null check (role in ('coordinator', 'thread', 'former')),
  title text not null,
  work_state text not null check (work_state in ('in_progress', 'blocked', 'review_ready', 'done', 'failed')),
  last_activity_at integer not null
) strict;
create index projects_threads_project on projects_threads (project_id, role);
create unique index projects_threads_coordinator on projects_threads (project_id) where role = 'coordinator';

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

create table projects_files (
  project_id text not null references projects_projects (id) on delete cascade,
  name text not null,
  size integer not null,
  actor text not null,
  updated_at integer not null,
  primary key (project_id, name)
) strict, without rowid;

create table projects_file_contents (
  project_id text not null,
  name text not null,
  content blob not null,
  primary key (project_id, name),
  foreign key (project_id, name) references projects_files (project_id, name) on delete cascade
) strict;

create table projects_file_log (
  id integer primary key,
  project_id text not null references projects_projects (id) on delete cascade,
  name text not null,
  size integer not null,
  actor text not null,
  at integer not null
) strict;
create index projects_file_log_project on projects_file_log (project_id, id);
`,
});
