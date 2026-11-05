import type { PluginStore } from "@pipoca/plugins";
import type { Actor } from "@pipoca/protocol";
import type { LibraryFile, LibraryWrite } from "./model";

interface FileRow {
  readonly name: string;
  readonly size: number;
  readonly actor: string;
  readonly updated_at: number;
}

export interface LibraryStore {
  readonly addMember: (sessionId: string, projectId: string) => void;
  readonly projectOf: (sessionId: string) => string | undefined;
  readonly members: (projectId: string) => readonly string[];
  readonly files: (projectId: string) => readonly LibraryFile[];
  readonly read: (projectId: string, name: string) => Uint8Array | undefined;
  readonly write: (
    projectId: string,
    name: string,
    content: Uint8Array,
    actor: Actor,
  ) => void;
  readonly writes: (projectId: string) => readonly LibraryWrite[];
}

// Project ids come from the projects plugin, whose tables the library
// doesn't reference, so it works without them.
export const librarySchema = `
create table library_members (
  session_id text primary key references sessions (id) on delete cascade,
  project_id text not null
) strict;
create index library_members_project on library_members (project_id);

create table library_files (
  project_id text not null,
  name text not null,
  size integer not null,
  actor text not null,
  updated_at integer not null,
  primary key (project_id, name)
) strict, without rowid;

create table library_contents (
  project_id text not null,
  name text not null,
  content blob not null,
  primary key (project_id, name),
  foreign key (project_id, name) references library_files (project_id, name) on delete cascade
) strict;

create table library_log (
  id integer primary key,
  project_id text not null,
  name text not null,
  size integer not null,
  actor text not null,
  at integer not null
) strict;
create index library_log_project on library_log (project_id, id);
`;

export function libraryStore(store: PluginStore): LibraryStore {
  return {
    addMember: (sessionId, projectId) => {
      store.run(
        "insert or replace into library_members (session_id, project_id) values (?, ?)",
        sessionId,
        projectId,
      );
    },
    projectOf: (sessionId) =>
      (
        store.all(
          "select project_id from library_members where session_id = ?",
          sessionId,
        )[0] as { project_id: string } | undefined
      )?.project_id,
    members: (projectId) =>
      (
        store.all(
          "select session_id from library_members where project_id = ?",
          projectId,
        ) as { session_id: string }[]
      ).map((row) => row.session_id),
    files: (projectId) =>
      (
        store.all(
          "select name, size, actor, updated_at from library_files where project_id = ? order by name",
          projectId,
        ) as FileRow[]
      ).map((row) => ({
        name: row.name,
        size: row.size,
        actor: row.actor,
        updatedAt: new Date(row.updated_at).toISOString(),
      })),
    read: (projectId, name) =>
      (
        store.all(
          "select content from library_contents where project_id = ? and name = ?",
          projectId,
          name,
        )[0] as { content: Uint8Array } | undefined
      )?.content,
    write: (projectId, name, content, actor) => {
      const at = Date.now();

      store.transaction(() => {
        store.run(
          `insert into library_files (project_id, name, size, actor, updated_at)
            values (?, ?, ?, ?, ?)
            on conflict (project_id, name) do update set size = excluded.size, actor = excluded.actor, updated_at = excluded.updated_at`,
          projectId,
          name,
          content.length,
          actor,
          at,
        );

        store.run(
          `insert into library_contents (project_id, name, content) values (?, ?, ?)
            on conflict (project_id, name) do update set content = excluded.content`,
          projectId,
          name,
          content,
        );

        store.run(
          "insert into library_log (project_id, name, size, actor, at) values (?, ?, ?, ?, ?)",
          projectId,
          name,
          content.length,
          actor,
          at,
        );
      });
    },
    writes: (projectId) =>
      (
        store.all(
          "select name, size, actor, at from library_log where project_id = ? order by id desc limit 50",
          projectId,
        ) as (Omit<LibraryWrite, "at"> & { readonly at: number })[]
      ).map((row) => ({ ...row, at: new Date(row.at).toISOString() })),
  };
}
