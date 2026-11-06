import { DatabaseSync } from "node:sqlite";

// The tables one owner keeps: the kernel, or a plugin by its id. The sql is
// version 0, and each migration after it one version more (ADR 0070).
export interface Schema {
  readonly owner: string;
  readonly sql: string;
  readonly migrations?: readonly string[];
}

interface Database {
  readonly db: DatabaseSync;
  // Why each plugin's tables can't be used, by plugin id.
  readonly failures: Map<string, string>;
}

// A new database gets every schema and its migrations, and an older one the
// migrations it hasn't run. One from a newer Pipoca is refused, and a plugin
// whose tables can't be brought up to date fails (ADR 0070).
export function openDatabase(
  path: string,
  kernel: Schema,
  plugins: readonly Schema[],
  now: () => number,
): Database {
  const db = new DatabaseSync(path);

  db.exec(`
    pragma journal_mode = wal;
    pragma foreign_keys = on;
    pragma synchronous = normal;
    pragma busy_timeout = 5000;
  `);

  const failures = new Map<string, string>();

  try {
    transaction(db, () => {
      const fresh = names(db).length === 0;

      const version =
        !fresh && names(db).includes("schema_owners")
          ? recordedVersion(db, kernel.owner)
          : undefined;

      if (!fresh && version === undefined) {
        throw new Error(
          `${path}: this database was made by another Pipoca version; move it aside to start fresh`,
        );
      }

      if (version !== undefined && version > latest(kernel)) {
        throw new Error(
          `${path}: this database was made by a newer Pipoca (schema version ${String(version)}, this one knows ${String(latest(kernel))}); run that version, or move the database aside to start fresh`,
        );
      }

      try {
        upgrade(db, kernel, version, now());
      } catch (error) {
        throw new Error(`${path}: ${message(error)}`, { cause: error });
      }

      for (const schema of plugins) {
        const failure = addPlugin(db, schema, now());

        if (failure !== undefined) {
          failures.set(schema.owner, failure);
        }
      }
    });
  } catch (error) {
    db.close();
    throw error;
  }

  return { db, failures };
}

// Runs fn in a savepoint, so a transaction can hold another.
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("savepoint pipoca");

  try {
    const result = fn();
    db.exec("release pipoca");

    return result;
  } catch (error) {
    db.exec("rollback to pipoca; release pipoca");
    throw error;
  }
}

// Why a plugin's schema is refused, after rolling back what it made.
class Refused extends Error {}

interface Made {
  readonly type: string;
  readonly name: string;
}

// The tables, indexes, triggers and views, without SQLite's own.
function objects(db: DatabaseSync): Made[] {
  return db
    .prepare(
      "select type, name from sqlite_master where name not like 'sqlite%' order by name",
    )
    .all() as unknown as Made[];
}

function names(db: DatabaseSync): string[] {
  return objects(db).map(({ name }) => name);
}

function latest(schema: Schema): number {
  return schema.migrations?.length ?? 0;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface Upgraded {
  readonly created: readonly Made[];
  readonly tables: readonly string[];
}

// Runs the SQL that brings an owner from its version, or from nothing, to the
// latest, and records that version and the tables the owner then keeps.
function upgrade(
  db: DatabaseSync,
  schema: Schema,
  from: number | undefined,
  at: number,
): Upgraded {
  const migrations = schema.migrations ?? [];

  if (from === latest(schema)) {
    return { created: [], tables: [] };
  }

  const before = new Set(names(db));

  const kept =
    from === undefined
      ? []
      : (JSON.parse(
          (
            db
              .prepare("select tables from schema_owners where owner = ?")
              .get(schema.owner) as { tables: string }
          ).tables,
        ) as string[]);

  const steps =
    from === undefined ? [schema.sql, ...migrations] : migrations.slice(from);

  const first = from === undefined ? 0 : from + 1;

  for (const [index, sql] of steps.entries()) {
    try {
      db.exec(sql);
    } catch (error) {
      const version = first + index;

      throw new Error(
        version === 0
          ? message(error)
          : `migration ${String(version)} failed: ${message(error)}`,
        { cause: error },
      );
    }
  }

  const after = objects(db);
  const created = after.filter(({ name }) => !before.has(name));

  const tables = [
    ...kept.filter((table) => after.some(({ name }) => name === table)),
    ...created.flatMap(({ type, name }) => (type === "table" ? [name] : [])),
  ];

  db.prepare(
    `insert into schema_owners (owner, version, tables, created_at) values (?, ?, ?, ?)
     on conflict (owner) do update set version = excluded.version, tables = excluded.tables`,
  ).run(schema.owner, latest(schema), JSON.stringify(tables), at);

  return { created, tables };
}

function prefixOf(owner: string): string {
  return `${owner.replaceAll("-", "_")}_`;
}

function recordedVersion(db: DatabaseSync, owner: string): number | undefined {
  return (
    db
      .prepare("select version from schema_owners where owner = ?")
      .get(owner) as { version: number } | undefined
  )?.version;
}

function addPlugin(
  db: DatabaseSync,
  schema: Schema,
  at: number,
): string | undefined {
  const recorded = recordedVersion(db, schema.owner);

  if (recorded !== undefined && recorded > latest(schema)) {
    return `its tables were made by a newer version of ${schema.owner} (schema version ${String(recorded)}, this one knows ${String(latest(schema))}); its data is kept until an admin resets it`;
  }

  if (recorded !== undefined) {
    try {
      upgradePlugin(db, schema, recorded, at);
    } catch (error) {
      return `its tables could not be upgraded: ${message(error)}; its data is kept until an admin resets it`;
    }

    return undefined;
  }

  const prefix = prefixOf(schema.owner);
  const refused = `plugin ${schema.owner} can't keep ${prefix} tables`;

  // Tables named for the plugin that it didn't make would be its own to drop.
  const taken = names(db).find((name) => name.startsWith(prefix));

  if (taken !== undefined) {
    return `${refused}: ${taken} belongs to another owner`;
  }

  const other = (
    db.prepare("select owner from schema_owners").all() as { owner: string }[]
  ).find(
    ({ owner }) => owner !== "kernel" && prefix.startsWith(prefixOf(owner)),
  )?.owner;

  if (other !== undefined) {
    return `${refused}: they would start with ${prefixOf(other)}, the tables of plugin ${other}`;
  }

  try {
    upgradePlugin(db, schema, undefined, at);
  } catch (error) {
    return error instanceof Refused
      ? error.message
      : `its tables could not be made: ${message(error)}`;
  }

  return undefined;
}

// Brings a plugin's tables up to date, or rolls back and says why it
// couldn't.
function upgradePlugin(
  db: DatabaseSync,
  schema: Schema,
  from: number | undefined,
  at: number,
): void {
  transaction(db, () => {
    const { created, tables } = upgrade(db, schema, from, at);
    const refusal = checked(db, schema.owner, created, tables);

    if (refusal !== undefined) {
      throw new Refused(refusal);
    }
  });
}

const kernelTargets = ["users", "sessions", "environments"];

// What is wrong with what a plugin's schema made, among the tables it keeps:
// only STRICT tables and indexes named for it, pointing only at each other
// and at people, Sessions and Environments.
function checked(
  db: DatabaseSync,
  owner: string,
  created: readonly Made[],
  tables: readonly string[],
): string | undefined {
  const prefix = prefixOf(owner);

  const other = created.find(
    ({ type }) => type !== "table" && type !== "index",
  );

  if (other !== undefined) {
    return `plugin ${owner} may only create tables and indexes, not the ${other.type} ${other.name}`;
  }

  if (created.some(({ name }) => !name.startsWith(prefix))) {
    return `plugin ${owner} may only create ${prefix} tables`;
  }

  const loose = tables.find(
    (table) =>
      (
        db
          .prepare("select strict from pragma_table_list where name = ?")
          .get(table) as { strict: number }
      ).strict !== 1,
  );

  if (loose !== undefined) {
    return `plugin ${owner} may only create STRICT tables, and ${loose} isn't`;
  }

  for (const table of tables) {
    const target = (
      db
        .prepare('select "table" from pragma_foreign_key_list(?)')
        .all(table) as { table: string }[]
    ).find(
      (key) =>
        !tables.includes(key.table) && !kernelTargets.includes(key.table),
    )?.table;

    if (target !== undefined) {
      return `plugin ${owner}'s table ${table} points at ${target}, but only its own tables, users, sessions and environments may be pointed at`;
    }
  }

  return undefined;
}

// Drops the tables a plugin's schema made and what it scheduled, and makes
// them again, for an admin to start it fresh when its tables can't be
// upgraded. Says why it couldn't.
export function resetPlugin(
  db: DatabaseSync,
  schema: Schema,
  now: number,
): string | undefined {
  const row = db
    .prepare("select tables from schema_owners where owner = ?")
    .get(schema.owner) as { tables: string } | undefined;

  const own = new Set(
    row === undefined ? [] : (JSON.parse(row.tables) as string[]),
  );

  try {
    transaction(db, () => {
      // The plugin's tables may point at each other.
      db.exec("pragma defer_foreign_keys = on");

      for (const { type, name } of objects(db)) {
        if (own.has(name)) {
          db.exec(`drop ${type} "${name.replaceAll('"', '""')}"`);
        }
      }

      db.prepare("delete from schema_owners where owner = ?").run(schema.owner);

      db.prepare("delete from plugin_schedules where plugin = ?").run(
        schema.owner,
      );
    });
  } catch (error) {
    return `its tables could not be dropped: ${error instanceof Error ? error.message : String(error)}`;
  }

  return addPlugin(db, schema, now);
}
