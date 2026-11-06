import type { Store } from "@pipoca/plugins";

// An Environment whose runner the server starts on its own machine (ADR
// 0053). The runner takes up to capacity Sessions at once, shares the listed
// folders, and stops after idleSeconds without a Session.
export interface LocalSettings {
  readonly capacity: number;
  readonly idleSeconds: number;
  readonly folders: readonly string[];
}

// What the plugin's route answers for an Environment. Without settings the
// server starts no runner for it.
export interface LocalEnvironment {
  readonly settings: LocalSettings | null;
  readonly lastFailure: RunnerFailure | null;
}

// The last runner that exited with an error, while none has run cleanly
// since. The next one waits until retryAt.
export interface RunnerFailure {
  readonly problem: string;
  readonly at: string;
  readonly retryAt: string;
}

export const defaultSettings: LocalSettings = {
  capacity: 4,
  idleSeconds: 300,
  folders: [],
};

interface SettingsStore {
  readonly get: (environmentId: string) => LocalSettings | undefined;
  readonly set: (environmentId: string, settings: LocalSettings) => void;
  readonly remove: (environmentId: string) => void;
}

export function settingsStore(store: Store): SettingsStore {
  return {
    get: (environmentId) => {
      const row = store.get<{ capacity: number; idle_seconds: number }>(
        "select capacity, idle_seconds from local_environments where environment_id = ?",
        environmentId,
      );

      return (
        row && {
          capacity: row.capacity,
          idleSeconds: row.idle_seconds,
          folders: store
            .all<{ path: string }>(
              "select path from local_folders where environment_id = ? order by position",
              environmentId,
            )
            .map(({ path }) => path),
        }
      );
    },
    set: (environmentId, settings) => {
      store.transaction(() => {
        store.run(
          `insert into local_environments (environment_id, capacity, idle_seconds) values (?, ?, ?)
           on conflict (environment_id) do update set capacity = excluded.capacity, idle_seconds = excluded.idle_seconds`,
          environmentId,
          settings.capacity,
          settings.idleSeconds,
        );

        store.run(
          "delete from local_folders where environment_id = ?",
          environmentId,
        );

        settings.folders.forEach((path, position) => {
          store.run(
            "insert into local_folders (environment_id, position, path) values (?, ?, ?)",
            environmentId,
            position,
            path,
          );
        });
      });
    },
    remove: (environmentId) => {
      store.run(
        "delete from local_environments where environment_id = ?",
        environmentId,
      );
    },
  };
}
