import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

// The tables one owner keeps: the kernel, or a plugin by its id.
export interface Schema {
  readonly owner: string;
  readonly sql: string;
}

export interface Database {
  readonly db: DatabaseSync;
  // Why each plugin's tables can't be used, by plugin id.
  readonly failures: Map<string, string>;
}

// The database has no migrations (ADR 0068): a new one gets every schema at
// once, and one made from other SQL is refused, or for a plugin, fails it.
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
      if (names(db).length === 0) {
        record(db, kernel, made(db, kernel.sql), now());
      } else if (
        !names(db).includes("schema_owners") ||
        recordedHash(db, kernel.owner) !== hash(kernel.sql)
      ) {
        throw new Error(
          `${path}: this database was made by another Pipoca version; move it aside to start fresh`,
        );
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

// Runs a schema and says what it made.
function made(db: DatabaseSync, sql: string): Made[] {
  const before = new Set(names(db));
  db.exec(sql);

  return objects(db).filter(({ name }) => !before.has(name));
}

function prefixOf(owner: string): string {
  return `${owner.replaceAll("-", "_")}_`;
}

function recordedHash(db: DatabaseSync, owner: string): string | undefined {
  return (
    db
      .prepare("select sql_hash from schema_owners where owner = ?")
      .get(owner) as { sql_hash: string } | undefined
  )?.sql_hash;
}

function addPlugin(
  db: DatabaseSync,
  schema: Schema,
  at: number,
): string | undefined {
  const recorded = recordedHash(db, schema.owner);

  if (recorded !== undefined) {
    return recorded === hash(schema.sql)
      ? undefined
      : `its tables were made by another version of ${schema.owner}; its data is kept until an admin resets it`;
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
    transaction(db, () => {
      const created = made(db, schema.sql);

      if (created.some(({ name }) => !name.startsWith(prefix))) {
        throw new Refused(
          `plugin ${schema.owner} may only create ${prefix} tables`,
        );
      }

      record(db, schema, created, at);
    });
  } catch (error) {
    return error instanceof Refused
      ? error.message
      : `its tables could not be made: ${error instanceof Error ? error.message : String(error)}`;
  }

  return undefined;
}

// Drops the tables a plugin's schema made and what it scheduled, and makes
// them again, for an admin to start it fresh after its schema changed
// (ADR 0068). Says why it couldn't.
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

function record(
  db: DatabaseSync,
  schema: Schema,
  created: readonly Made[],
  at: number,
): void {
  const tables = created
    .filter(({ type }) => type === "table" || type === "view")
    .map(({ name }) => name);

  db.prepare(
    "insert into schema_owners (owner, sql_hash, tables, created_at) values (?, ?, ?, ?)",
  ).run(schema.owner, hash(schema.sql), JSON.stringify(tables), at);
}

function hash(sql: string): string {
  return createHash("sha256").update(sql.trim()).digest("hex");
}
