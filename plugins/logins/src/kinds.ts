import {
  BadRequest,
  HttpError,
  type Secrets,
  type SqlValue,
  type Store,
} from "@pipoca/plugins";
import type { Clock, Log } from "@pipoca/protocol";
import type { Locks } from "./locks";
import type { Lease, Release, Stored } from "./model";

// The rows of the server's base, which is the team's, are kept under this,
// which no user id is.
export const baseOwner = "*base";

// Rows are kept per owner: the base, the person for their My defaults, or
// the person and one of their Profiles.
export function profileOwner(userId: string, profileId: string): string {
  return `${userId}:${profileId}`;
}

export interface Owned extends Stored {
  readonly owner: string;
}

export interface KindSpec<T> {
  // The first part of the Session routes.
  readonly name: string;
  readonly kind: "model" | "mcp";
  readonly valid: (value: unknown) => T;
  readonly typeOf: (value: T) => string;
}

export interface LoginKind<T> {
  readonly name: string;
  readonly list: (owner: string) => readonly Stored[];
  // The person's logins on every layer: the base, their My defaults and
  // their Profiles'.
  readonly mine: (userId: string) => readonly Owned[];
  readonly get: (owner: string, key: string) => T | undefined;
  readonly validated: (value: unknown) => T;
  // Reads and writes the login under its lease. fn returns the new login,
  // null to remove it, or undefined to keep it. Answers busy when the lease
  // stays taken.
  readonly modify: (
    owner: string,
    key: string,
    fn: (current: T | undefined) => Promise<T | null | undefined>,
  ) => Promise<T | undefined>;
  // Null removes the login. Answers busy when the lease stays taken.
  readonly write: (
    owner: string,
    key: string,
    value: T | null,
  ) => Promise<void>;
  // A Session's logins, keyed by name: owners are its layers, nearest
  // first, ending with the person's My defaults and the base.
  readonly nearest: (
    owners: readonly string[],
  ) => ReadonlyMap<string, { readonly owner: string; readonly type: string }>;
  // A lease on one to read, refresh and write back.
  readonly lease: (owners: readonly string[], key: string) => Promise<Lease<T>>;
  readonly release: (
    owners: readonly string[],
    key: string,
    release: Release<unknown>,
  ) => void;
}

// Another Session of the person's holds the login, so the caller asks again.
export function busy(): HttpError {
  return new HttpError(409, "another Session is changing this login", "busy");
}

export function loginKind<T>(
  deps: {
    readonly store: Store;
    readonly secrets: Secrets;
    readonly clock: Clock;
    readonly log: Log;
    readonly changed: () => void;
  },
  leases: Locks,
  spec: KindSpec<T>,
): LoginKind<T> {
  const rows = sealedRows(deps, spec);

  const leaseKey = (owner: string, key: string): string =>
    `${spec.name}\u0000${owner}\u0000${key}`;

  const validated = (value: unknown): T => {
    try {
      return spec.valid(value);
    } catch (error) {
      throw new BadRequest(
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  const store = (owner: string, key: string, value: T | null): void => {
    const known = rows.get(owner, key) !== undefined;

    if (value === null) {
      rows.remove(owner, key);
    } else {
      rows.save(owner, key, value);
    }

    if (value === null || !known) {
      deps.log(value === null ? "login removed" : "login saved", {
        kind: spec.name,
        owner,
        key,
      });
    }

    deps.changed();
  };

  // A Session reads the nearest layer's login, and writes back to it, or to
  // the person's My defaults for one it reads from the base or doesn't have.
  const placed = (
    owners: readonly string[],
    key: string,
  ): { readonly from: string | undefined; readonly to: string } => {
    const from = owners.find((owner) => rows.get(owner, key) !== undefined);
    const mine = owners.at(-2) ?? "";

    return { from, to: from === undefined || from === baseOwner ? mine : from };
  };

  const modify: LoginKind<T>["modify"] = async (owner, key, fn) => {
    const held = leaseKey(owner, key);
    const given = await leases.acquire(held);
    if (given === undefined) {
      throw busy();
    }

    try {
      const current = rows.get(owner, key);
      const next = await fn(current);

      if (next !== undefined) {
        store(owner, key, next);
      }

      return next === undefined ? current : (next ?? undefined);
    } finally {
      leases.release(held, given);
    }
  };

  return {
    name: spec.name,
    list: rows.list,
    mine: rows.mine,
    get: rows.get,
    validated,
    modify,
    write: async (owner, key, value) => {
      await modify(owner, key, async () => Promise.resolve(value));
    },
    nearest: (owners) => {
      const found = new Map<string, { owner: string; type: string }>();

      for (const owner of owners) {
        for (const { key, type } of rows.list(owner)) {
          if (!found.has(key)) {
            found.set(key, { owner, type });
          }
        }
      }

      return found;
    },
    lease: async (owners, key) => {
      const { from, to } = placed(owners, key);

      const given = await leases.acquire(leaseKey(to, key));
      if (given === undefined) {
        throw busy();
      }

      return {
        lease: given,
        value: (from === undefined ? undefined : rows.get(from, key)) ?? null,
      };
    },
    release: (owners, key, { lease: given, value }) => {
      const next =
        value === undefined || value === null ? value : validated(value);

      const { to } = placed(owners, key);

      // A lapsed lease may have let another runner write since, so its
      // write would undo theirs.
      const held = leaseKey(to, key);
      if (next !== undefined && !leases.holds(held, given)) {
        throw new HttpError(
          409,
          "the lease lapsed, so this write could undo another",
          "lease_lapsed",
        );
      }

      if (next !== undefined) {
        store(to, key, next);
      }

      leases.release(held, given);
    },
  };
}

interface SealedRows<T> {
  readonly list: (owner: string) => readonly Stored[];
  readonly mine: (userId: string) => readonly Owned[];
  readonly get: (owner: string, key: string) => T | undefined;
  readonly save: (owner: string, key: string, value: T) => void;
  readonly remove: (owner: string, key: string) => void;
}

interface LoginRow {
  readonly layer: "base" | "defaults" | "profile";
  readonly owner_user_id: string | null;
  readonly profile_id: string | null;
  readonly key: string;
  readonly type: string;
  readonly updated_at: number;
}

// The owner the routes name a row by.
function rowOwner(row: LoginRow): string {
  if (row.layer === "base") {
    return baseOwner;
  }

  return row.profile_id === null
    ? (row.owner_user_id ?? "")
    : profileOwner(row.owner_user_id ?? "", row.profile_id);
}

function ownerColumns(
  owner: string,
): readonly [LoginRow["layer"], string | null, string | null] {
  if (owner === baseOwner) {
    return ["base", null, null];
  }

  const [userId = "", profileId] = owner.split(/:(.*)/);

  return profileId === undefined
    ? ["defaults", userId, null]
    : ["profile", userId, profileId];
}

const ownerMatch =
  "layer = ? and owner_user_id is ? and profile_id is ? and name = ?";

const table = "logins_logins";

// A login is state people create as they go, so it lives in SQLite, sealed
// for its row (ADR 0039).
function sealedRows<T>(
  {
    store,
    secrets,
    clock,
  }: {
    readonly store: Store;
    readonly secrets: Secrets;
    readonly clock: Clock;
  },
  { kind, valid, typeOf }: KindSpec<T>,
): SealedRows<T> {
  const rows = (where: string, ...params: SqlValue[]): readonly LoginRow[] =>
    store.all<LoginRow>(
      `select layer, owner_user_id, profile_id, name as key, type, updated_at from logins_logins where kind = ? and (${where}) order by name, case layer when 'base' then 0 when 'defaults' then 1 else 2 end, profile_id`,
      kind,
      ...params,
    );

  const idOf = (owner: string, key: string): string | undefined =>
    store.get<{ id: string }>(
      `select id from logins_logins where kind = ? and ${ownerMatch}`,
      kind,
      ...ownerColumns(owner),
      key,
    )?.id;

  return {
    list: (owner) =>
      rows(
        "layer = ? and owner_user_id is ? and profile_id is ?",
        ...ownerColumns(owner),
      ).map(({ key, type, updated_at }) => ({
        key,
        type,
        updatedAt: new Date(updated_at).toISOString(),
      })),
    mine: (userId) =>
      rows("layer = 'base' or owner_user_id = ?", userId).map((row) => ({
        owner: rowOwner(row),
        key: row.key,
        type: row.type,
        updatedAt: new Date(row.updated_at).toISOString(),
      })),
    // A login sealed under another server key can't be opened, and reads as
    // logged out.
    get: (owner, key) => {
      const row = store.get<{ id: string; credential: string }>(
        `select id, credential from logins_logins where kind = ? and ${ownerMatch}`,
        kind,
        ...ownerColumns(owner),
        key,
      );

      if (row === undefined) {
        return undefined;
      }

      try {
        return valid(JSON.parse(secrets.open(table, row.id, row.credential)));
      } catch {
        return undefined;
      }
    },
    save: (owner, key, value) => {
      const id = idOf(owner, key) ?? Bun.randomUUIDv7();

      store.run(
        `insert into logins_logins (id, kind, layer, owner_user_id, profile_id, name, type, credential, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict (id) do update set type = excluded.type, credential = excluded.credential, updated_at = excluded.updated_at`,
        id,
        kind,
        ...ownerColumns(owner),
        key,
        typeOf(value),
        secrets.seal(table, id, JSON.stringify(value)),
        clock.now(),
      );
    },
    remove: (owner, key) => {
      store.run(
        `delete from logins_logins where kind = ? and ${ownerMatch}`,
        kind,
        ...ownerColumns(owner),
        key,
      );
    },
  };
}
