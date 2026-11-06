import { definePlugin } from "@pipoca/plugins";

// A team server's machine holds everyone's data and the sealing key, so only
// a solo install runs runners on it unless admins say otherwise (ADR 0053).
export const local = definePlugin({
  id: "local",
  title: "This machine",
  description:
    "Starts runners on the server's own machine for an Environment's Sessions, in a solo install.",
  works: ["personal", "team"],
  defaultOn: "solo",
  schema: `
create table local_environments (
  environment_id text primary key references environments (id) on delete cascade,
  capacity integer not null check (capacity > 0),
  idle_seconds integer not null check (idle_seconds >= 0)
) strict;

create table local_folders (
  environment_id text not null references local_environments (environment_id) on delete cascade,
  position integer not null,
  path text not null,
  primary key (environment_id, position)
) strict, without rowid;
`,
});
