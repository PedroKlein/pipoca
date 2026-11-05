import { afterEach, expect, test } from "bun:test";
import type { ServerPlugin } from "@pipoca/plugins";
import type { PluginInfo } from "@pipoca/protocol";
import { closeServers, json, testServer } from "./testdata/harness";

afterEach(closeServers);

function keeping(name: string, schema: string): ServerPlugin {
  return { name, schema, register: () => undefined };
}

test("fails a plugin whose schema makes more than STRICT tables and indexes of its own", async () => {
  const server = testServer({
    plugins: [
      keeping(
        "fine-notes",
        `
          create table fine_notes_lists (id text primary key) strict;
          create table fine_notes_items (
            list_id text not null references fine_notes_lists (id),
            user_id text references users (id),
            session_id text references sessions (id),
            environment_id text references environments (id)
          ) strict;
          create index fine_notes_items_list on fine_notes_items (list_id);
        `,
      ),
      keeping(
        "viewer",
        `
          create table viewer_items (id text) strict;
          create view viewer_all as select * from viewer_items;
        `,
      ),
      keeping("stray", "create table notes (id text) strict"),
      keeping("loose", "create table loose_items (id text)"),
      keeping(
        "linked",
        "create table linked_items (profile_id text references profiles (id)) strict",
      ),
    ],
  });

  const listed = await json<PluginInfo[]>(server.api("/api/plugins"));

  expect(listed.map(({ id, state, error }) => ({ id, state, error }))).toEqual([
    { id: "fine-notes", state: "on", error: undefined },
    {
      id: "viewer",
      state: "failed",
      error:
        "plugin viewer may only create tables and indexes, not the view viewer_all",
    },
    {
      id: "stray",
      state: "failed",
      error: "plugin stray may only create stray_ tables",
    },
    {
      id: "loose",
      state: "failed",
      error:
        "plugin loose may only create STRICT tables, and loose_items isn't",
    },
    {
      id: "linked",
      state: "failed",
      error:
        "plugin linked's table linked_items points at profiles, but only its own tables, users, sessions and environments may be pointed at",
    },
  ]);
});
