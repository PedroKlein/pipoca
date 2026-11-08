import { Config, definePlugin } from "@pipoca/plugins";

export const files = definePlugin({
  id: "files",
  title: "Files",
  description:
    "Keeps what Pi makes in outputs/ and the files people give a Session, on the server, wherever the Session runs.",
  config: Config.object({
    maxFileBytes: Config.number({
      title: "Largest file, in bytes",
      description:
        "Uploads and outputs larger than this are refused with a message that names the limit.",
      default: 209_715_200,
      min: 1,
    }),
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
});
