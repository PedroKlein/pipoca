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
        db.exec(kernel.sql);
        record(db, kernel, now());
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

// The names of the tables, indexes, triggers and views, without SQLite's own.
function names(db: DatabaseSync): string[] {
  return (
    db
      .prepare("select name from sqlite_master where name not like 'sqlite%'")
      .all() as { name: string }[]
  ).map(({ name }) => name);
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

  const prefix = `${schema.owner.replaceAll("-", "_")}_`;
  const before = new Set(names(db));

  try {
    transaction(db, () => {
      db.exec(schema.sql);

      if (
        names(db).some((name) => !before.has(name) && !name.startsWith(prefix))
      ) {
        throw new Refused(
          `plugin ${schema.owner} may only create ${prefix} tables`,
        );
      }

      record(db, schema, at);
    });
  } catch (error) {
    return error instanceof Refused
      ? error.message
      : `its tables could not be made: ${error instanceof Error ? error.message : String(error)}`;
  }

  return undefined;
}

// Drops a plugin's tables and makes them again from its schema, for an admin
// to start it fresh after its schema changed (ADR 0068). Says why it couldn't.
export function resetPlugin(
  db: DatabaseSync,
  schema: Schema,
  now: number,
): string | undefined {
  const prefix = `${schema.owner.replaceAll("-", "_")}_`;

  const tables = (
    db
      .prepare(
        "select name from sqlite_master where type = 'table' and substr(name, 1, length(?)) = ?",
      )
      .all(prefix, prefix) as { name: string }[]
  ).map(({ name }) => name);

  try {
    transaction(db, () => {
      // The plugin's tables may point at each other.
      db.exec("pragma defer_foreign_keys = on");

      for (const table of tables) {
        db.exec(`drop table "${table.replaceAll('"', '""')}"`);
      }

      db.prepare("delete from schema_owners where owner = ?").run(schema.owner);
    });
  } catch (error) {
    return `its tables could not be dropped: ${error instanceof Error ? error.message : String(error)}`;
  }

  return addPlugin(db, schema, now);
}

function record(db: DatabaseSync, schema: Schema, at: number): void {
  db.prepare(
    "insert into schema_owners (owner, sql_hash, created_at) values (?, ?, ?)",
  ).run(schema.owner, hash(schema.sql), at);
}

function hash(sql: string): string {
  return createHash("sha256").update(sql.trim()).digest("hex");
}
