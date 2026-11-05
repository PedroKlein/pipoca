import type { Schedule } from "@pipoca/plugins";
import type { Clock, Log, Timer } from "@pipoca/protocol";

export interface ScheduleRow {
  readonly plugin: string;
  readonly key: string;
  readonly dueAt: number;
  readonly payload: unknown;
  readonly attempts: number;
}

// A plugin's intervals are its rows keyed "every:<name>", which prefix
// reads and removals leave out.
export interface ScheduleStore {
  readonly put: (row: ScheduleRow) => void;
  readonly add: (row: ScheduleRow) => void;
  readonly due: (
    now: number,
    plugins: readonly string[],
  ) => readonly ScheduleRow[];
  readonly next: (
    after: number,
    plugins: readonly string[],
  ) => number | undefined;
  // Done and retry change a row only when it is as it was read.
  readonly done: (row: ScheduleRow) => void;
  readonly retry: (row: ScheduleRow, dueAt: number) => void;
  readonly remove: (plugin: string, key: string) => void;
  readonly removePrefix: (plugin: string, prefix: string) => void;
  readonly pending: (plugin: string, prefix: string) => readonly ScheduleRow[];
}

export interface Scheduler {
  readonly part: (plugin: string) => {
    readonly schedule: Schedule;
    readonly commit: () => void;
  };
  readonly wake: () => void;
}

interface Interval {
  readonly interval: () => number;
  readonly fn: () => void | Promise<void>;
}

interface Handler {
  readonly prefix: string;
  readonly fn: (payload: unknown, key: string) => void | Promise<void>;
}

const everyPrefix = "every:";
const maxSleepMs = 60_000;
const retryMs = [60_000, 5 * 60_000, 30 * 60_000];

export function scheduler(deps: {
  readonly store: ScheduleStore;
  readonly clock: Clock;
  readonly timer: Timer;
  readonly on: () => readonly string[];
  readonly signal: AbortSignal;
  readonly log: Log;
}): Scheduler {
  const intervals = new Map<string, Interval>();
  const handlers = new Map<string, readonly Handler[]>();
  const running = new Set<string>();
  const committed = new Set<string>();
  let cancel: (() => void) | undefined;

  const idOf = ({ plugin, key }: Pick<ScheduleRow, "plugin" | "key">) =>
    `${plugin}\n${key}`;

  const idle = (row: ScheduleRow): boolean => !running.has(idOf(row));

  // A plugin's rows wait until it has set its handlers up.
  const on = (): string[] => deps.on().filter((each) => committed.has(each));

  const arm = (): void => {
    cancel?.();
    cancel = undefined;

    if (deps.signal.aborted) {
      return;
    }

    const now = deps.clock.now();
    const plugins = on();
    const waiting = deps.store.due(now, plugins).some(idle);
    const next = waiting ? now : deps.store.next(now, plugins);

    if (next !== undefined) {
      cancel = deps.timer.after(Math.min(next - now, maxSleepMs), tick);
    }
  };

  const runInterval = async (row: ScheduleRow): Promise<void> => {
    const name = row.key.slice(everyPrefix.length);
    const found = intervals.get(idOf(row));

    if (found === undefined) {
      deps.store.done(row);

      deps.log("interval dropped, since nothing runs it", {
        plugin: row.plugin,
        name,
      });

      return;
    }

    try {
      await found.fn();
    } catch (error) {
      deps.log("interval failed", {
        plugin: row.plugin,
        name,
        error: messageOf(error),
      });
    }

    if (!deps.signal.aborted) {
      deps.store.put({
        ...row,
        dueAt: Math.ceil(deps.clock.now() + found.interval()),
      });
    }
  };

  const runAt = async (row: ScheduleRow): Promise<void> => {
    const found = handlers
      .get(row.plugin)
      ?.filter(({ prefix }) => row.key.startsWith(prefix))
      .reduce<Handler | undefined>(
        (best, each) =>
          best === undefined || each.prefix.length > best.prefix.length
            ? each
            : best,
        undefined,
      );

    const fields = { plugin: row.plugin, key: row.key };

    if (found === undefined) {
      deps.store.done(row);
      deps.log("schedule dropped, since nothing handles it", fields);

      return;
    }

    try {
      await found.fn(row.payload, row.key);
    } catch (error) {
      if (deps.signal.aborted) {
        return;
      }

      const delay = retryMs[row.attempts];

      if (delay === undefined) {
        deps.store.done(row);

        deps.log("schedule dropped after its retries", {
          ...fields,
          error: messageOf(error),
        });
      } else {
        deps.store.retry(row, deps.clock.now() + delay);

        deps.log("schedule failed, retrying", {
          ...fields,
          error: messageOf(error),
          retryMs: delay,
        });
      }

      return;
    }

    if (!deps.signal.aborted) {
      deps.store.done(row);
    }
  };

  const run = async (row: ScheduleRow): Promise<void> => {
    running.add(idOf(row));

    try {
      await (row.key.startsWith(everyPrefix) ? runInterval(row) : runAt(row));
    } catch (error) {
      deps.log("schedule failed to run", {
        plugin: row.plugin,
        key: row.key,
        error: messageOf(error),
      });
    } finally {
      running.delete(idOf(row));
      arm();
    }
  };

  const tick = async (): Promise<void> => {
    if (deps.signal.aborted) {
      return;
    }

    const runs = deps.store.due(deps.clock.now(), on()).filter(idle).map(run);

    arm();
    await Promise.all(runs);
  };

  deps.signal.addEventListener("abort", () => {
    cancel?.();
  });

  return {
    part: (plugin) => {
      const staged = new Map<string, Interval>();
      const stagedHandlers: Handler[] = [];

      const schedule: Schedule = {
        every: (name, interval, fn) => {
          if (staged.has(name)) {
            throw new Error(`interval ${name} is already scheduled`);
          }

          staged.set(name, {
            interval: typeof interval === "number" ? () => interval : interval,
            fn,
          });
        },
        at: (key, when, payload) => {
          if (key.startsWith(everyPrefix)) {
            throw new Error(`keys starting ${everyPrefix} are intervals`);
          }

          deps.store.put({
            plugin,
            key,
            dueAt: Math.ceil(when),
            payload,
            attempts: 0,
          });

          arm();
        },
        on: (prefix, fn) => {
          if (stagedHandlers.some((each) => each.prefix === prefix)) {
            throw new Error(`${prefix} is already handled`);
          }

          stagedHandlers.push({ prefix, fn });
        },
        cancel: (key) => {
          deps.store.remove(plugin, key);
        },
        cancelPrefix: (prefix) => {
          deps.store.removePrefix(plugin, prefix);
        },
        pending: (prefix) =>
          deps.store
            .pending(plugin, prefix)
            .map(({ key, dueAt, payload }) => ({ key, when: dueAt, payload })),
      };

      const commit = (): void => {
        for (const [name, each] of staged) {
          const key = `${everyPrefix}${name}`;
          intervals.set(idOf({ plugin, key }), each);

          deps.store.add({
            plugin,
            key,
            dueAt: Math.ceil(deps.clock.now() + each.interval()),
            payload: undefined,
            attempts: 0,
          });
        }

        handlers.set(plugin, stagedHandlers);
        committed.add(plugin);
        arm();
      };

      return { schedule, commit };
    },
    wake: arm,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
