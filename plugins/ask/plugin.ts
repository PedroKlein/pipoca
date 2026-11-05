import { Config, definePlugin } from "@pipoca/plugins";

export const ask = definePlugin({
  id: "ask",
  title: "Ask",
  description:
    "Lets the agent ask you structured questions in a form, and the team vote.",
  works: ["personal", "team"],
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
  server: async () => import("./src/server"),
  session: async () => import("./src/session"),
  web: async () =>
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- TypeScript follows only a literal, and the server's project has no DOM to check the web part with
    import("./web/index" as string) as Promise<{ readonly default: unknown }>,
});
