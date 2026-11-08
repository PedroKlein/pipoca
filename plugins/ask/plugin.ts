import { Config, definePlugin } from "@pipoca/plugins";

export const ask = definePlugin({
  id: "ask",
  title: "Ask",
  description:
    "Lets the agent ask you structured questions in a form, and the team vote.",
  config: Config.object({
    voteMinutes: Config.number({
      title: "Minutes a vote stays open",
      description:
        "In team work, how long a vote waits before it closes by itself, unless whoever opens it says otherwise.",
      default: 60,
      min: 1,
      max: 10_080,
    }),
  }),
  schema: `
create table ask_votes (
  id text primary key,
  session_id text not null references sessions (id) on delete cascade,
  opener text not null check (opener like 'user:_%' or opener like 'session:_%'),
  question text not null,
  opened_at integer not null,
  closes_at integer not null,
  closed_at integer
) strict;
create index ask_votes_session on ask_votes (session_id, opened_at);

create table ask_vote_options (
  vote_id text not null references ask_votes (id) on delete cascade,
  position integer not null,
  label text not null,
  primary key (vote_id, position)
) strict, without rowid;

create table ask_vote_picks (
  vote_id text not null,
  user_id text not null references users (id) on delete cascade,
  position integer not null,
  picked_at integer not null,
  primary key (vote_id, user_id),
  foreign key (vote_id, position) references ask_vote_options (vote_id, position) on delete cascade
) strict;
`,
  // 1: Sessions another plugin started whose questions end the turn, and
  // the questions that wait for an answer as a message (ADR 0076). people
  // are who a question is for, by id, and defaults its answers on timeout.
  migrations: [
    `
create table ask_waits (
  session_id text primary key references sessions (id) on delete cascade,
  origin text check (json_valid(origin)),
  owner_user_id text references users (id) on delete set null,
  people text not null check (json_valid(people)),
  timeout_ms integer
) strict;

create table ask_questions (
  id text primary key,
  session_id text not null references sessions (id) on delete cascade,
  questions text not null check (json_valid(questions)),
  defaults text not null check (json_valid(defaults)),
  people text not null check (json_valid(people)),
  asked_at integer not null,
  closes_at integer not null,
  closed_at integer,
  answered_by text
) strict;
create index ask_questions_session on ask_questions (session_id, closed_at);
`,
  ],
});
