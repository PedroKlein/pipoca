import { Config, definePlugin } from "@pipoca/plugins";

// A routine's owner is a person or the team, kept as owner_user_id with NULL
// for the team (ADR 0067). Times are milliseconds.
export const routines = definePlugin({
  id: "routines",
  title: "Routines",
  description:
    "Runs your routines on a schedule, and lets a Session schedule a wake-up to come back to something later.",
  works: ["personal", "team"],
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
  -- How often its Session died since Pi's messages last grew, and how many
  -- there were then.
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
});
