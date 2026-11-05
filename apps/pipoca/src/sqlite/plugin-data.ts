import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { PluginStore } from "@pipoca/plugins";
import { transaction } from "./database";
import type { SecretBox } from "./secret-box";

// Plugins are trusted in v1 (ADR 0022), so their statements reach any table.
export function pluginStore(
  db: DatabaseSync,
  name: string,
  box: SecretBox,
): PluginStore {
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
