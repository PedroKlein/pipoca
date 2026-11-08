import type { DatabaseSync } from "node:sqlite";
import type { Clock, RegisteredProvider } from "@pipoca/protocol";
import type { BaseListingStore } from "../base-providers";

interface ListingRow {
  hash: string;
  complete: number;
  providers: string;
}

export function baseListingStore(
  db: DatabaseSync,
  clock: Clock,
): BaseListingStore {
  const select = db.prepare(
    "select hash, complete, providers from base_providers",
  );

  const upsert = db.prepare(
    "insert into base_providers (id, hash, complete, providers, listed_at) values (1, ?, ?, ?, ?) on conflict (id) do update set hash = excluded.hash, complete = excluded.complete, providers = excluded.providers, listed_at = excluded.listed_at",
  );

  return {
    get: () => {
      const row = select.get() as ListingRow | undefined;

      return (
        row && {
          hash: row.hash,
          complete: row.complete === 1,
          providers: JSON.parse(row.providers) as RegisteredProvider[],
        }
      );
    },
    set: ({ hash, complete, providers }) => {
      upsert.run(
        hash,
        complete ? 1 : 0,
        JSON.stringify(providers),
        clock.now(),
      );
    },
  };
}
