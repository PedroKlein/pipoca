import type { Schema } from "./database";

// Times are unix milliseconds. An owner_user_id of NULL is the team
// (ADR 0064). Plugin tables may reference users, sessions and environments.
// Released databases hold this as version 0: change it with a migration
// (ADR 0070).
const sql = `
create table schema_owners (
  owner text primary key,
  version integer not null,
  -- A JSON array of the tables and views its schema made.
  tables text not null,
  created_at integer not null
) strict;

create table users (
  id text primary key,
  name text not null unique,
  display_name text,
  password_hash text,
  admin integer not null default 0 check (admin in (0, 1)),
  default_profile_id text,
  default_environment_id text references environments (id) on delete set null,
  setup_finished_at integer,
  pinned_at integer,
  created_at integer not null,
  last_active_at integer
) strict;

create table user_dismissed_steps (
  user_id text not null references users (id) on delete cascade,
  step text not null,
  primary key (user_id, step)
) strict;

create table user_pinned_pages (
  user_id text not null references users (id) on delete cascade,
  position integer not null,
  page text not null,
  primary key (user_id, position)
) strict, without rowid;

create table browser_sessions (
  token_hash text primary key,
  user_id text not null references users (id) on delete cascade,
  created_at integer not null,
  expires_at integer not null
) strict, without rowid;
create index browser_sessions_user on browser_sessions (user_id);
create index browser_sessions_expiry on browser_sessions (expires_at);

create table access_tokens (
  id text primary key,
  token_hash text not null unique,
  user_id text not null references users (id) on delete cascade,
  name text not null,
  created_at integer not null
) strict;
create index access_tokens_user on access_tokens (user_id, created_at);

create table invites (
  id text primary key,
  token_hash text not null unique,
  email text,
  admin integer not null check (admin in (0, 1)),
  created_by text references users (id) on delete set null,
  created_at integer not null,
  expires_at integer not null,
  uses integer not null default 0
) strict;
create index invites_email on invites (email) where email is not null;

create table environments (
  id text primary key,
  slug text not null unique,
  name text not null,
  owner_user_id text references users (id) on delete cascade,
  template_id text,
  -- One made from a template runs as the template says, so it keeps no
  -- setup of its own (ADR 0049).
  isolation text check (isolation in ('process', 'container')),
  image text,
  setup_script text,
  variables text not null default '{}' check (json_valid(variables)),
  secrets_sealed text,
  key_hash text unique,
  created_at integer not null,
  check (template_id is not null or (isolation is not null and setup_script is not null)),
  check (template_id is null or (isolation is null and image is null and setup_script is null))
) strict;
create index environments_owner on environments (owner_user_id);

create table environment_join_keys (
  key_hash text primary key,
  owner_user_id text references users (id) on delete cascade,
  created_at integer not null
) strict, without rowid;

create table runner_models (
  environment_id text not null references environments (id) on delete cascade,
  runner text not null,
  position integer not null,
  provider text not null,
  model_id text not null,
  reported_at integer not null,
  primary key (environment_id, runner, position)
) strict, without rowid;
create index runner_models_reported on runner_models (reported_at);

create table sessions (
  id text primary key,
  environment_id text not null references environments (id) on delete cascade,
  started_by text references users (id) on delete set null,
  acts_as_plugin text,
  acts_as text,
  plugin text,
  plugin_key text,
  runner text,
  profile_id text not null,
  workspace text not null check (json_valid(workspace)),
  model_provider text,
  model_id text,
  thinking text check (thinking in ('off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max')),
  system_prompt text,
  first_message text,
  title text,
  status text not null check (status in ('queued', 'starting', 'idle', 'running', 'interrupted', 'failed', 'stopped')),
  generation integer not null,
  error text,
  access text not null default 'team' check (access in ('team', 'view', 'named')),
  workspace_removal text check (workspace_removal in ('pending', 'forced', 'removed', 'kept')),
  workspace_kept_reason text,
  created_at integer not null,
  interrupted_at integer,
  archived_at integer,
  check ((plugin is null) = (plugin_key is null)),
  check ((acts_as_plugin is null) = (acts_as is null)),
  check ((model_provider is null) = (model_id is null))
) strict;
create index sessions_listing on sessions (archived_at, created_at);
create index sessions_plugin on sessions (plugin, plugin_key, created_at) where plugin is not null;
create index sessions_placement on sessions (environment_id, runner, status);
create index sessions_started_by on sessions (started_by);
create index sessions_profile on sessions (profile_id) where archived_at is null;

create table session_access_people (
  session_id text not null references sessions (id) on delete cascade,
  user_id text not null references users (id) on delete cascade,
  primary key (session_id, user_id)
) strict;
create index session_access_people_user on session_access_people (user_id);

create table session_messages (
  session_id text not null references sessions (id) on delete cascade,
  seq integer not null,
  kind text not null check (kind in ('message', 'stop', 'team', 'aside', 'notice')),
  actor text not null check (actor like 'user:_%' or actor like 'session:_%' or actor like 'plugin:_%'),
  user_id text references users (id) on delete set null,
  request_id text,
  text text,
  quote_from text,
  quote_text text,
  plugin text,
  notice text check (notice is null or json_valid(notice)),
  at integer not null,
  primary key (session_id, seq),
  unique (session_id, request_id),
  check (user_id is null or actor = 'user:' || user_id),
  check ((quote_from is null) = (quote_text is null)),
  check ((kind = 'notice') = (plugin is not null and notice is not null))
) strict, without rowid;

-- What plugins and the kernel send a Session, kept until its host
-- acknowledges the seq, which never repeats. A message with a dedupe key
-- stays a while after that, acked, so a repeat is still a no-op.
create table session_outbox (
  seq integer primary key autoincrement,
  session_id text not null references sessions (id) on delete cascade,
  plugin text,
  actor text not null check (actor like 'user:_%' or actor like 'session:_%' or actor like 'plugin:_%'),
  kind text not null check (kind in ('message', 'context', 'notice', 'tool_result')),
  text text,
  notice text check (notice is null or json_valid(notice)),
  turn integer not null check (turn in (0, 1)),
  generation integer,
  payload text check (payload is null or json_valid(payload)),
  dedupe text,
  created_at integer not null,
  sent_at integer,
  acked_at integer,
  check ((kind = 'tool_result') = (generation is not null and payload is not null)),
  check ((kind = 'tool_result') = (text is null)),
  check ((kind = 'notice') = (notice is not null)),
  check (kind <> 'notice' or plugin is not null),
  check (acked_at is null or (sent_at is not null and dedupe is not null))
) strict;
create index session_outbox_session on session_outbox (session_id, seq) where acked_at is null;
-- The kernel's own sends have no plugin, and SQLite tells NULLs apart.
create unique index session_outbox_dedupe on session_outbox (session_id, coalesce(plugin, ''), dedupe) where dedupe is not null;

-- An external thread a plugin follows, such as a Slack thread, and the
-- Session it talks to.
create table session_bindings (
  plugin text not null,
  key text not null,
  session_id text not null references sessions (id) on delete cascade,
  created_at integer not null,
  primary key (plugin, key)
) strict, without rowid;
create index session_bindings_session on session_bindings (session_id);

create table transcript_lines (
  session_id text not null references sessions (id) on delete cascade,
  line integer not null,
  entry text not null,
  primary key (session_id, line)
) strict, without rowid;

create table runner_tokens (
  token_hash text primary key,
  environment_id text not null references environments (id) on delete cascade,
  runner text not null,
  session_id text references sessions (id) on delete cascade,
  joined integer not null check (joined in (0, 1)),
  created_at integer not null,
  last_used_at integer not null
) strict, without rowid;
create index runner_tokens_runner on runner_tokens (environment_id, runner);
create index runner_tokens_session on runner_tokens (session_id) where session_id is not null;

create table repository_trust (
  owner_user_id text references users (id) on delete cascade,
  repository text not null,
  trusted integer not null check (trusted in (0, 1)),
  decided_at integer not null
) strict;
create unique index repository_trust_key on repository_trust (coalesce(owner_user_id, ''), repository);

create table plugin_schedules (
  plugin text not null check (plugin <> ''),
  key text not null check (key <> ''),
  due_at integer not null,
  payload text check (payload is null or json_valid(payload)),
  attempts integer not null check (attempts >= 0),
  primary key (plugin, key)
) strict, without rowid;
create index plugin_schedules_due on plugin_schedules (due_at);
`;

const migrations = [
  // When an admin finished the server's setup (ADR 0072). One row at most.
  `create table server_setup (
  id integer primary key check (id = 1),
  finished_at integer not null,
  finished_by text references users (id) on delete set null
) strict;`,
];

export const kernelSchema: Schema = { owner: "kernel", sql, migrations };
