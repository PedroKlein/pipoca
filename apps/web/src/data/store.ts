export interface Snapshot<T> {
  readonly data: T | undefined;
  readonly error: Error | undefined;
  readonly loading: boolean;
}

export interface Source<T> {
  readonly load: () => Promise<T>;
  readonly topics?: readonly string[];
}

export type Watch = (
  topics: readonly string[],
  onChange: () => void,
) => () => void;

export interface Store {
  readonly read: <T>(key: string) => Snapshot<T>;
  readonly subscribe: <T>(
    key: string,
    source: Source<T>,
    listener: () => void,
  ) => () => void;
  readonly reload: (key: string) => Promise<void>;
  readonly invalidate: (topics: readonly string[]) => void;
  readonly seed: (key: string, data: unknown) => void;
}

interface Entry {
  snapshot: Snapshot<unknown>;
  source?: Source<unknown>;
  readonly listeners: Set<() => void>;
  sent: number;
  pending?: Promise<void>;
  unwatch?: () => void;
  // Seeded, so the first subscriber needs no request.
  fresh?: boolean;
}

const empty: Snapshot<never> = {
  data: undefined,
  error: undefined,
  loading: true,
};

export function errorOf(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}

// Keeps one answer per key for every subscriber. A key is read once however
// many subscribe, read again when one of its topics changes, and kept after
// the last one leaves, to show at once while it is read again.
export function createStore(watch: Watch): Store {
  const entries = new Map<string, Entry>();

  const entryOf = (key: string): Entry => {
    const found = entries.get(key);

    if (found !== undefined) {
      return found;
    }

    const entry: Entry = { snapshot: empty, listeners: new Set(), sent: 0 };
    entries.set(key, entry);

    return entry;
  };

  const settle = (entry: Entry, snapshot: Snapshot<unknown>): void => {
    entry.snapshot = snapshot;

    for (const listener of entry.listeners) {
      listener();
    }
  };

  const fetch = async (entry: Entry): Promise<void> => {
    const { source } = entry;

    if (source === undefined) {
      return;
    }

    entry.sent += 1;
    const request = entry.sent;

    const pending = source.load().then(
      (data) => {
        if (request === entry.sent) {
          settle(entry, { data, error: undefined, loading: false });
        }
      },
      (reason: unknown) => {
        if (request === entry.sent) {
          settle(entry, {
            data: entry.snapshot.data,
            error: errorOf(reason),
            loading: false,
          });
        }
      },
    );

    entry.pending = pending;
    await pending;

    if (entry.pending === pending) {
      delete entry.pending;
    }
  };

  return {
    read: <T>(key: string) => entryOf(key).snapshot as Snapshot<T>,

    subscribe: <T>(key: string, source: Source<T>, listener: () => void) => {
      const entry = entryOf(key);
      entry.source = source;
      entry.listeners.add(listener);

      if (entry.listeners.size === 1) {
        const topics = source.topics ?? [];

        if (topics.length > 0) {
          entry.unwatch = watch(topics, () => void fetch(entry));
        }

        if (entry.fresh === true) {
          delete entry.fresh;
        } else if (entry.pending === undefined) {
          void fetch(entry);
        }
      }

      return () => {
        entry.listeners.delete(listener);

        if (entry.listeners.size === 0) {
          entry.unwatch?.();
          delete entry.unwatch;
        }
      };
    },

    reload: async (key) => fetch(entryOf(key)),

    invalidate: (topics) => {
      for (const entry of entries.values()) {
        const watched = entry.source?.topics ?? [];

        if (
          entry.listeners.size > 0 &&
          watched.some((topic) => topics.includes(topic))
        ) {
          void fetch(entry);
        }
      }
    },

    seed: (key, data) => {
      const entry = entryOf(key);
      entry.fresh = entry.listeners.size === 0;
      settle(entry, { data, error: undefined, loading: false });
    },
  };
}
