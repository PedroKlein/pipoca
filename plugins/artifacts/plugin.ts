import { Config, definePlugin } from "@pipoca/plugins";

// A page, document or picture Pi publishes, with every version kept at one
// link (ADR 0078). An artifact follows its Session: whoever sees the Session
// opens it, and whoever steers it shares it with named people.
export const artifacts = definePlugin({
  id: "artifacts",
  title: "Artifacts",
  description:
    "Pages, documents and pictures Pi publishes from a Session, with every version kept at one link, shown in a sandbox.",
  config: Config.object({
    maxFileBytes: Config.number({
      title: "Largest artifact, in bytes",
      description:
        "A larger file is refused with a message that names the limit.",
      default: 52_428_800,
      min: 1,
    }),
    // An artifact loads nothing else from the network. A host may end in a
    // path, such as cdn.jsdelivr.net/npm.
    scriptHosts: Config.strings({
      title: "Hosts pages may load scripts and styles from",
      default: ["cdnjs.cloudflare.com", "cdn.jsdelivr.net/npm", "unpkg.com"],
    }),
  }),
  schema: `
create table artifacts_artifacts (
  id text primary key,
  session_id text references sessions (id) on delete set null,
  owner_user_id text references users (id) on delete cascade,
  title text not null,
  created_at integer not null,
  updated_at integer not null
) strict;
create index artifacts_artifacts_session on artifacts_artifacts (session_id);
create index artifacts_artifacts_updated on artifacts_artifacts (updated_at);

create table artifacts_versions (
  artifact_id text not null references artifacts_artifacts (id) on delete cascade,
  number integer not null check (number >= 1),
  name text not null,
  hash text not null check (length(hash) = 64),
  size integer not null check (size >= 0),
  author text not null,
  created_at integer not null,
  primary key (artifact_id, number)
) strict, without rowid;
create index artifacts_versions_hash on artifacts_versions (hash);

create table artifacts_shares (
  artifact_id text not null references artifacts_artifacts (id) on delete cascade,
  user_id text not null references users (id) on delete cascade,
  role text not null check (role in ('view', 'comment')),
  primary key (artifact_id, user_id)
) strict, without rowid;
`,
});
