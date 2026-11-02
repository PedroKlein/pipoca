import type { PluginStore } from "@pipoca/plugins";

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

export interface SettingsStore {
  readonly get: (environmentId: string) => LocalSettings | undefined;
  readonly set: (environmentId: string, settings: LocalSettings) => void;
  readonly remove: (environmentId: string) => void;
}

export function settingsStore(store: PluginStore): SettingsStore {
  store.exec(`create table if not exists local_environments (
    environment_id text primary key,
    settings text not null
  )`);

  return {
    get: (environmentId) => {
      const [row] = store.all(
        "select settings from local_environments where environment_id = ?",
        environmentId,
      ) as { settings: string }[];

      return (
        row && {
          ...defaultSettings,
          ...(JSON.parse(row.settings) as Partial<LocalSettings>),
        }
      );
    },
    set: (environmentId, settings) => {
      store.run(
        `insert into local_environments (environment_id, settings) values (?, ?)
         on conflict (environment_id) do update set settings = excluded.settings`,
        environmentId,
        JSON.stringify(settings),
      );
    },
    remove: (environmentId) => {
      store.run(
        "delete from local_environments where environment_id = ?",
        environmentId,
      );
    },
  };
}
