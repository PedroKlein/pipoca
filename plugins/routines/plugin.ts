import { Config, definePlugin, event, Type } from "@pipoca/plugins";

// A routine's owner is a person or the team, kept as owner_user_id with NULL
// for the team (ADR 0067). Times are milliseconds.
export const routines = definePlugin({
  id: "routines",
  title: "Routines",
  description:
    "Runs your routines on a schedule, and lets a Session schedule a wake-up to come back to something later.",
  // A run starts as an agent or a workflow, which subagents finds (ADR 0075).
  requires: ["subagents"],
  config: Config.object({
    wakeUpDays: Config.number({
      title: "Days ahead a wake-up may be",
      description:
        "The furthest a Session may schedule a wake-up of its own, counted from when it asks.",
      default: 30,
      min: 1,
      max: 365,
    }),
  }),
  events: {
    paused: event({
      title: "Routine paused itself",
      description:
        "A routine paused on its own: after failed runs, past its end date or at its daily spend cap, or a group of routines at its daily budget.",
      fields: Type.Object({
        name: Type.String(),
        title: Type.String(),
        reason: Type.String(),
        until: Type.Union([Type.String(), Type.Null()], {
          description: "When the pause ends by itself, or null",
        }),
      }),
    }),
  },
  schema: `
create table routines_state (
  owner_user_id text references users (id) on delete cascade,
  name text not null,
  version text not null,
  paused_at integer,
  paused_reason text,
  failures integer not null default 0,
  check ((paused_at is null) = (paused_reason is null))
) strict;
create unique index routines_state_key on routines_state (coalesce(owner_user_id, ''), name);

create table routines_runs (
  id text primary key,
  owner_user_id text references users (id) on delete cascade,
  name text not null,
  key text not null default '',
  cause text not null,
  session_id text references sessions (id) on delete set null,
  outcome text not null check (outcome in ('running', 'queued', 'ok', 'nothing', 'failed', 'skipped', 'blocked', 'stopped')),
  reason text,
  events text check (events is null or json_valid(events)),
  fired_at integer not null,
  ended_at integer,
  -- How often its Session died since Pi last said something or called a
  -- tool, and how far it had got then.
  deaths integer not null default 0,
  progress integer not null default 0
) strict;
create index routines_runs_routine on routines_runs (coalesce(owner_user_id, ''), name, fired_at);
create index routines_runs_session on routines_runs (session_id) where session_id is not null;

create table routines_hooks (
  id text primary key,
  owner_user_id text references users (id) on delete cascade,
  name text not null,
  secret text not null
) strict;
create unique index routines_hooks_key on routines_hooks (coalesce(owner_user_id, ''), name);

create table routines_wakeups (
  id text primary key,
  session_id text not null references sessions (id) on delete cascade,
  delivered_at integer not null
) strict;
create index routines_wakeups_session on routines_wakeups (session_id, delivered_at);
`,
  // 1: a run keeps the inputs it was given (ADR 0075).
  // 2: the agent or workflow a run's trigger starts (ADR 0075).
  // 3: guards (ADR 0076): a pause that ends by itself, retries, a run's
  // running time and branch, what each routine spent today, and the pull
  // requests runs opened.
  // 4: allowed actions (ADR 0076): runs that propose, dry runs, what they
  // proposed, and recent events that fired nothing, for test on save.
  // 5: runs that wait for a person (ADR 0076): since when, how long they
  // ran before, who their questions are for, the question an approval
  // waits on, how a run that waits asked to end, and who changed each
  // routine.
  // 6: groups (ADR 0075) that paused themselves at their daily budget.
  migrations: [
    "alter table routines_runs add column inputs text check (inputs is null or json_valid(inputs));",
    "alter table routines_runs add column agent text; alter table routines_runs add column workflow text;",
    `
alter table routines_state add column paused_until integer;
alter table routines_runs add column attempt integer not null default 0;
alter table routines_runs add column running_since integer;
alter table routines_runs add column branch text;
create index routines_runs_branch on routines_runs (branch) where branch is not null;

create table routines_spend (
  owner_user_id text references users (id) on delete cascade,
  name text not null,
  day text not null,
  micros integer not null
) strict;
create unique index routines_spend_key on routines_spend (coalesce(owner_user_id, ''), name, day);

create table routines_pulls (
  run_id text not null references routines_runs (id) on delete cascade,
  url text not null,
  open integer not null check (open in (0, 1)),
  primary key (run_id, url)
) strict, without rowid;
`,
    `
alter table routines_runs add column proposes integer not null default 0 check (proposes in (0, 1));
alter table routines_runs add column dry integer not null default 0 check (dry in (0, 1));

create table routines_proposals (
  id text primary key,
  run_id text not null references routines_runs (id) on delete cascade,
  action text not null,
  title text not null,
  input text not null check (json_valid(input)),
  commits text,
  state text not null check (state in ('proposed', 'waiting', 'applied', 'failed', 'rejected', 'refused', 'shown')),
  result text,
  url text,
  decided_by text references users (id) on delete set null,
  proposed_at integer not null,
  ended_at integer
) strict;
create index routines_proposals_run on routines_proposals (run_id, proposed_at);
create index routines_proposals_commits on routines_proposals (commits) where commits is not null;

create table routines_heard (
  id text primary key,
  type text not null,
  fields text not null check (json_valid(fields)),
  audience text not null check (json_valid(audience)),
  heard_at integer not null
) strict;
create index routines_heard_type on routines_heard (type, heard_at);
`,
    `
alter table routines_runs add column waiting_since integer;
alter table routines_runs add column ran_ms integer not null default 0;
alter table routines_runs add column asked_for text check (asked_for is null or json_valid(asked_for));
alter table routines_runs add column ending text check (ending is null or json_valid(ending));
alter table routines_proposals add column question_id text;
create index routines_proposals_question on routines_proposals (question_id) where question_id is not null;

create table routines_changes (
  owner_user_id text references users (id) on delete cascade,
  name text not null,
  by_user_id text references users (id) on delete set null,
  change text not null check (change in ('created', 'changed')),
  changed_at integer not null
) strict;
create index routines_changes_routine on routines_changes (coalesce(owner_user_id, ''), name, changed_at);
`,
    `
create table routines_groups (
  owner_user_id text references users (id) on delete cascade,
  name text not null,
  paused_at integer not null,
  paused_reason text not null,
  paused_until integer not null
) strict;
create unique index routines_groups_key on routines_groups (coalesce(owner_user_id, ''), name);
`,
  ],
});
