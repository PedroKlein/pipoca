import type { DatabaseSync } from "node:sqlite";
import type { ScheduleRow, ScheduleStore } from "@pipoca/pluginhost";

interface Row {
  readonly plugin: string;
  readonly key: string;
  readonly due_at: number;
  readonly payload: string | null;
  readonly attempts: number;
}

function rowOf(row: Row): ScheduleRow {
  return {
    plugin: row.plugin,
    key: row.key,
    dueAt: row.due_at,
    payload: row.payload === null ? undefined : JSON.parse(row.payload),
    attempts: row.attempts,
  };
}

function payloadOf(payload: unknown): string | null {
  return payload === undefined ? null : JSON.stringify(payload);
}

const columns = "plugin, key, due_at, payload, attempts";
const ofPlugins = "plugin in (select value from json_each(?))";
const prefixed = "instr(key, ?) = 1 and instr(key, 'every:') <> 1";
const unchanged = "plugin = ? and key = ? and due_at = ? and attempts = ?";

export function scheduleStore(db: DatabaseSync): ScheduleStore {
  const upsert = db.prepare(
    `insert into plugin_schedules (${columns}) values (?, ?, ?, ?, ?)
     on conflict (plugin, key) do update set
       due_at = excluded.due_at, payload = excluded.payload, attempts = excluded.attempts`,
  );

  const insert = db.prepare(
    `insert into plugin_schedules (${columns}) values (?, ?, ?, ?, ?)
     on conflict (plugin, key) do nothing`,
  );

  const selectDue = db.prepare(
    `select ${columns} from plugin_schedules where due_at <= ? and ${ofPlugins} order by due_at`,
  );

  const selectNext = db.prepare(
    `select min(due_at) as due_at from plugin_schedules where due_at > ? and ${ofPlugins}`,
  );

  const deleteRow = db.prepare(
    `delete from plugin_schedules where ${unchanged}`,
  );

  const updateRetry = db.prepare(
    `update plugin_schedules set due_at = ?, attempts = attempts + 1 where ${unchanged}`,
  );

  const deleteKey = db.prepare(
    "delete from plugin_schedules where plugin = ? and key = ?",
  );

  const selectPending = db.prepare(
    `select ${columns} from plugin_schedules where plugin = ? and ${prefixed} order by due_at, key`,
  );

  const values = (row: ScheduleRow) =>
    [
      row.plugin,
      row.key,
      row.dueAt,
      payloadOf(row.payload),
      row.attempts,
    ] as const;

  const identity = (row: ScheduleRow) =>
    [row.plugin, row.key, row.dueAt, row.attempts] as const;

  return {
    put: (row) => {
      upsert.run(...values(row));
    },
    add: (row) => {
      insert.run(...values(row));
    },
    due: (now, plugins) =>
      (selectDue.all(now, JSON.stringify(plugins)) as unknown as Row[]).map(
        rowOf,
      ),
    next: (after, plugins) =>
      (
        selectNext.get(after, JSON.stringify(plugins)) as {
          due_at: number | null;
        }
      ).due_at ?? undefined,
    done: (row) => {
      deleteRow.run(...identity(row));
    },
    retry: (row, dueAt) => {
      updateRetry.run(dueAt, ...identity(row));
    },
    remove: (plugin, key) => {
      deleteKey.run(plugin, key);
    },
    pending: (plugin, prefix) =>
      (selectPending.all(plugin, prefix) as unknown as Row[]).map(rowOf),
  };
}
