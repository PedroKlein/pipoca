import { Config, definePlugin } from "@pipoca/plugins";

export const files = definePlugin({
  id: "files",
  title: "Files",
  description:
    "Keeps what Pi makes in outputs/ and the files people give a Session, on the server, wherever the Session runs.",
  config: Config.object({
    maxFileBytes: Config.bytes({
      title: "Largest file",
      description:
        "Uploads and outputs larger than this are refused with a message that names the limit.",
      default: 209_715_200,
      min: 1,
    }),
    perPersonBytes: Config.bytes({
      title: "Session files per person",
      description:
        "Past this, the person and admins are warned. Nothing is deleted or refused.",
      default: 10_737_418_240,
      min: 1,
    }),
    // Kubernetes pods without a disk of their own lose a checkout's work
    // when they exit, so they keep it on the server.
    snapshots: Config.object(
      {
        enabled: Config.boolean({
          title: "Save unfinished work in repositories when a pod stops",
          default: true,
        }),
        maxBytes: Config.bytes({
          title: "Largest snapshot",
          description:
            "A checkout's unfinished work over this isn't kept, and the Session says so.",
          default: 524_288_000,
          min: 1,
        }),
      },
      { title: "Workspaces on Kubernetes" },
    ),
  }),
  schema: `
create table files_session_files (
  session_id text not null references sessions (id) on delete cascade,
  place text not null check (place in ('outputs', 'uploads')),
  path text not null,
  hash text not null check (length(hash) = 64),
  size integer not null check (size >= 0),
  added_by text references users (id) on delete set null,
  saved_at integer not null,
  primary key (session_id, place, path)
) strict, without rowid;
create index files_session_files_hash on files_session_files (hash);
`,
  migrations: [
    `create table files_snapshots (
  session_id text not null references sessions (id) on delete cascade,
  checkout text not null,
  hash text not null check (length(hash) = 64),
  size integer not null check (size >= 0),
  saved_at integer not null,
  primary key (session_id, checkout)
) strict, without rowid;
create index files_snapshots_hash on files_snapshots (hash);`,
    // 2: the files a snapshot changed, for people to see.
    `alter table files_snapshots add column changes text not null default '[]';
alter table files_snapshots add column changed integer not null default 0;`,
  ],
});
