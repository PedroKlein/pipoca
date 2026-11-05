import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

// The tables one owner keeps: the kernel, or a plugin by its id.
export interface Schema {
  readonly owner: string;
  readonly version: number;
  readonly sql: string;
}

export interface Database {
  readonly db: DatabaseSync;
  // Why each plugin's tables can't be used, by plugin id.
  readonly failures: Map<string, string>;
}

// Statements that create something, and the name they give it.
const created =
  /create\s+(?:unique\s+)?(?:table|index|trigger|view)\s+(?:if\s+not\s+exists\s+)?["`]?([\w-]+)/gi;

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
      if (isEmpty(db)) {
        db.exec(kernel.sql);
        db.exec(`pragma user_version = ${String(kernel.version)}`);
        record(db, kernel, now());
      } else if (!madeBy(db, kernel)) {
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

function isEmpty(db: DatabaseSync): boolean {
  return (
    version(db) === 0 &&
    db.prepare("select 1 from sqlite_master limit 1").get() === undefined
  );
}

function madeBy(db: DatabaseSync, kernel: Schema): boolean {
  return (
    version(db) === kernel.version &&
    recordedHash(db, kernel.owner) === hash(kernel.sql)
  );
}

function version(db: DatabaseSync): number {
  return (db.prepare("pragma user_version").get() as { user_version: number })
    .user_version;
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

  for (const [, name = ""] of schema.sql.matchAll(created)) {
    if (!name.startsWith(prefix)) {
      return `plugin ${schema.owner} may only create ${prefix} tables`;
    }
  }

  try {
    transaction(db, () => {
      db.exec(schema.sql);
      record(db, schema, at);
    });
  } catch (error) {
    return `its tables could not be made: ${error instanceof Error ? error.message : String(error)}`;
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
    "insert into schema_owners (owner, version, sql_hash, created_at) values (?, ?, ?, ?)",
  ).run(schema.owner, schema.version, hash(schema.sql), at);
}

function hash(sql: string): string {
  return createHash("sha256").update(sql.trim()).digest("hex");
}
