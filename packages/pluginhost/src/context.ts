import { canSee, canSteer } from "@pipoca/people";
import type {
  Secrets,
  Sessions as PluginSessions,
  SqlValue,
  Store,
} from "@pipoca/plugins";
import type { Sessions } from "@pipoca/sessions";

// A plugin's tables on the server's database, and the server's key that
// seals its secrets for one context, such as a row.
export interface PluginDb {
  readonly all: (sql: string, ...params: readonly SqlValue[]) => unknown[];
  readonly run: (sql: string, ...params: readonly SqlValue[]) => void;
  readonly transaction: <T>(fn: () => T) => T;
  readonly seal: (text: string, context: string) => string;
  readonly open: (sealed: string, context: string) => string;
}

export function sessionsFor(
  sessions: Sessions,
  plugin: string,
): PluginSessions {
  const settle = (
    outcome:
      { readonly ok: true } | { readonly ok: false; readonly reason: string },
    done: string,
  ): void => {
    if (!outcome.ok) {
      throw new Error(`session not ${done}: ${outcome.reason}`);
    }
  };

  const ownedHere = (id: string): string => {
    if (sessions.get(id)?.plugin?.id !== plugin) {
      throw new Error(`session ${id} isn't owned by ${plugin}`);
    }

    return id;
  };

  return {
    start: ({ key, ...request }) => {
      const started = sessions.start(
        request,
        key === undefined ? undefined : { id: plugin, key },
      );

      if (!started.ok) {
        throw new Error(`session not started: ${started.reason}`);
      }

      return started.value;
    },
    get: (id) => sessions.get(id),
    owned: (key, { archived = false } = {}) =>
      sessions.list({ archived, plugin: { id: plugin, key } }),
    archive: (id) => {
      settle(sessions.archive(ownedHere(id)), "archived");
    },
    unarchive: (id) => {
      settle(sessions.unarchive(ownedHere(id)), "unarchived");
    },
    sees: (id, person) =>
      canSee({ id: person, admin: false }, sessions.owned(id)),
    steers: (id, person) =>
      canSteer({ id: person, admin: false }, sessions.owned(id)),
    send: (id, { text, turn, as, notice, dedupe }) =>
      sessions.enqueue(id, {
        ...(notice
          ? { kind: "notice", text, notice, turn }
          : { kind: turn ? "message" : "context", text }),
        plugin,
        actor: as ?? `plugin:${plugin}`,
        ...(dedupe !== undefined && { dedupe }),
      }).ok
        ? "queued"
        : "gone",
    bind: (key, sessionId) => {
      settle(sessions.bind(plugin, key, sessionId), "bound");
    },
    boundTo: (key) => sessions.boundTo(plugin, key),
  };
}

export function storeOf(store: PluginDb): Store {
  return {
    get: (sql, ...params) => store.all(sql, ...params)[0] as never,
    all: (sql, ...params) => store.all(sql, ...params) as never,
    run: (sql, ...params) => {
      store.run(sql, ...params);

      const [row] = store.all("select changes() as changes") as {
        changes: number;
      }[];

      return { changes: row?.changes ?? 0 };
    },
    transaction: store.transaction,
  };
}

export function secretsOf(store: PluginDb): Secrets {
  return {
    seal: (table, rowId, text) => store.seal(text, `${table}:${rowId}`),
    open: (table, rowId, sealed) => store.open(sealed, `${table}:${rowId}`),
  };
}
