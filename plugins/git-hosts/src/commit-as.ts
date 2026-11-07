import { BadRequest, type Store, Type } from "@pipoca/plugins";
import type { CommitIdentities, Identity } from "./model";

// Without a host, the person's default.
export const commitAsBody = Type.Object({
  host: Type.Optional(Type.String()),
  name: Type.String(),
  email: Type.String(),
});

export interface CommitAs {
  // On the host, or the default when the host has none of its own.
  readonly of: (userId: string, host: string | undefined) => Identity | null;
  readonly all: (userId: string) => CommitIdentities;
  readonly choose: (
    userId: string,
    host: string | undefined,
    identity: Identity,
  ) => void;
}

const table = "git_hosts_commit_identities";

// The name and email a person's Sessions commit as on every runner, for each
// host and by default for the others (ADR 0072). Without one, git uses the
// runner's own config.
export function commitAsStore(store: Store): CommitAs {
  const rows = (userId: string) =>
    store.all<Identity & { host: string }>(
      `select host, name, email from ${table} where user_id = ? order by host`,
      userId,
    );

  return {
    of: (userId, host) => {
      const row = store.get<Identity>(
        `select name, email from ${table} where user_id = ? and host in (?, '') order by host = '' limit 1`,
        userId,
        host ?? "",
      );

      return row === undefined ? null : { name: row.name, email: row.email };
    },
    all: (userId) => {
      const found = rows(userId);
      const fallback = found.find(({ host }) => host === "");

      return {
        default: fallback
          ? { name: fallback.name, email: fallback.email }
          : null,
        hosts: found.flatMap(({ host, name, email }) =>
          host === "" ? [] : [{ host, name, email }],
        ),
      };
    },
    choose: (userId, host, identity) => {
      const key = host?.trim().toLowerCase() ?? "";
      const name = identity.name.trim();
      const email = identity.email.trim();

      if (name === "" && email === "") {
        store.run(
          `delete from ${table} where user_id = ? and host = ?`,
          userId,
          key,
        );

        return;
      }

      if (name === "" || email === "" || !email.includes("@")) {
        throw new BadRequest("give both a name and an email");
      }

      store.run(
        `insert into ${table} (user_id, host, name, email) values (?, ?, ?, ?) on conflict (user_id, host) do update set name = excluded.name, email = excluded.email`,
        userId,
        key,
        name,
        email,
      );
    },
  };
}
