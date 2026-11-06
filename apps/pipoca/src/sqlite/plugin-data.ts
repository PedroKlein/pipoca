import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { PluginDb } from "@pipoca/pluginhost";
import { transaction } from "./database";
import type { SecretBox } from "./secret-box";

// A plugin's statements aren't sandboxed and reach any table. Only its
// declared schema is checked: STRICT tables of its own (ADR 0068).
export function pluginStore(
  db: DatabaseSync,
  name: string,
  box: SecretBox,
): PluginDb {
  const statements = new Map<string, StatementSync>();

  const prepared = (sql: string): StatementSync => {
    const found = statements.get(sql) ?? db.prepare(sql);
    statements.set(sql, found);

    return found;
  };

  return {
    all: (sql, ...params) => prepared(sql).all(...params),
    run: (sql, ...params) => {
      prepared(sql).run(...params);
    },
    transaction: (fn) => transaction(db, fn),
    seal: (text, context) => box.seal(text, `plugin:${name}:${context}`),
    open: (sealed, context) => box.open(sealed, `plugin:${name}:${context}`),
  };
}
