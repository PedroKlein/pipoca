import { BadRequest, type PluginStore, Type } from "@pipoca/plugins";
import type { Identity } from "./acting";

export const commitAsBody = Type.Object({
  name: Type.String(),
  email: Type.String(),
});

export interface CommitAs {
  readonly of: (userId: string) => Identity | null;
  readonly choose: (userId: string, identity: Identity) => void;
}

// The name and email a person's Sessions commit as on every runner. Without
// one, git uses the runner's own config.
export function commitAsStore(store: PluginStore): CommitAs {
  store.exec(`
    create table if not exists "git-hosts_commit_as" (
      user_id text primary key,
      name text not null,
      email text not null
    )
  `);

  return {
    of: (userId) => {
      const [row] = store.all(
        `select name, email from "git-hosts_commit_as" where user_id = ?`,
        userId,
      ) as Identity[];

      return row === undefined ? null : { name: row.name, email: row.email };
    },
    choose: (userId, identity) => {
      const name = identity.name.trim();
      const email = identity.email.trim();

      if (name === "" && email === "") {
        store.run(
          `delete from "git-hosts_commit_as" where user_id = ?`,
          userId,
        );

        return;
      }

      if (name === "" || email === "" || !email.includes("@")) {
        throw new BadRequest("give both a name and an email");
      }

      store.run(
        `insert into "git-hosts_commit_as" (user_id, name, email) values (?, ?, ?) on conflict (user_id) do update set name = excluded.name, email = excluded.email`,
        userId,
        name,
        email,
      );
    },
  };
}
