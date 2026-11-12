import type { Owner, ServerContext } from "@pipoca/plugins";
import { owners } from "@pipoca/plugins";
import type { routines } from "../plugin";
import { checkScriptOf, earlierSeen, runCheck } from "./checks";
import { cronSchedule } from "./cron";
import type { TriggerNote } from "./model";
import {
  durationOf,
  fillAll,
  type Heard,
  keyOf,
  matches,
  type Routine,
  serverZone,
  watchEvent,
} from "./routine";
import { look, type Watching } from "./watch";

// A trigger that collects runs with at most this many events (ADR 0075).
const maxCollected = 50;

// A routine as the engine has it loaded.
interface Routined {
  readonly owner: Owner;
  readonly name: string;
  readonly routine?: Routine;
}

// Events a trigger gathered, as the engine's quiet window keeps a key's.
interface Gathered {
  readonly owner: Owner;
  readonly name: string;
  readonly trigger: number;
  readonly key: string;
  readonly events: readonly Heard[];
  readonly firstAt: number;
  readonly lastAt: number;
}

interface Notes {
  readonly checks?: readonly TriggerNote[];
  readonly watches?: readonly TriggerNote[];
}

const collectKey = (owner: Owner, name: string, trigger: number): string =>
  `collect:${owner}:${name}:${String(trigger)}`;

const watchKey = (firing: {
  readonly owner: Owner;
  readonly name: string;
  readonly trigger: number;
}): string => `watch:${firing.owner}:${firing.name}:${String(firing.trigger)}`;

interface Extras<L extends Routined> {
  readonly arrive: (each: L, event: Heard, trigger: number) => void;
  readonly keepWatches: () => void;
  readonly notesOf: (each: L) => Notes;
}

// What routines add before an event waits for its run (ADR 0075): a
// trigger's check, a trigger that collects its events for a schedule, and
// watches that fetch an address on a schedule of their own.
export function triggerExtras<L extends Routined>(
  context: Pick<
    ServerContext<typeof routines>,
    "schedule" | "store" | "clock" | "log" | "checks" | "network"
  >,
  deps: {
    readonly loadedOf: (owner: Owner, name: string) => L | undefined;
    readonly all: () => Iterable<L>;
    readonly paused: (each: Routined) => boolean;
    readonly guard: (each: L) => void;
    // The engine's quiet window for an event, and the run of a batch.
    readonly wait: (each: L, event: Heard, trigger: number) => void;
    readonly flush: (batch: Gathered) => void;
    readonly repositoriesOf: (each: L) => readonly string[];
    readonly changed: () => void;
  },
): Extras<L> {
  const { schedule, store, clock, log } = context;

  // How each routine's triggers' checks went last (ADR 0075).
  const lastChecks = new Map<string, TriggerNote>();

  const noteCheck = (
    each: L,
    trigger: number,
    passed: boolean,
    error?: string,
  ): void => {
    lastChecks.set(`${each.owner}/${each.name}\n${String(trigger)}`, {
      trigger,
      at: new Date(clock.now()).toISOString(),
      passed,
      ...(error !== undefined && { error }),
    });

    deps.changed();
  };

  // The trigger's earlier firings of the event's piece of work, newest
  // first, before the event joins them.
  const firingsBefore = (
    each: L,
    trigger: number,
    key: string,
    fields: Heard["fields"],
  ): unknown[] => {
    const earlier = store
      .all<{ fields: string }>(
        "select fields from routines_firings where owner_user_id is ? and name = ? and trigger = ? and key = ? order by heard_at desc, rowid desc limit ?",
        owners.toSql(each.owner),
        each.name,
        trigger,
        key,
        earlierSeen,
      )
      .map((row) => JSON.parse(row.fields) as unknown);

    store.run(
      "insert into routines_firings (owner_user_id, name, trigger, key, fields, heard_at) values (?, ?, ?, ?, ?, ?)",
      owners.toSql(each.owner),
      each.name,
      trigger,
      key,
      JSON.stringify(fields),
      clock.now(),
    );

    store.run(
      "delete from routines_firings where owner_user_id is ? and name = ? and trigger = ? and key = ? and rowid not in (select rowid from routines_firings where owner_user_id is ? and name = ? and trigger = ? and key = ? order by heard_at desc, rowid desc limit ?)",
      owners.toSql(each.owner),
      each.name,
      trigger,
      key,
      owners.toSql(each.owner),
      each.name,
      trigger,
      key,
      earlierSeen,
    );

    return earlier;
  };

  // An event a trigger caught goes on when the trigger's check, if it has
  // one, says so, and then gathers when the trigger collects (ADR 0075).
  const arrive = (each: L, event: Heard, index: number): void => {
    const due = each.routine?.when[index];

    if (due === undefined || deps.paused(each)) {
      return;
    }

    const pass = (): void => {
      const now = deps.loadedOf(each.owner, each.name);

      if (now === undefined) {
        return;
      }

      if (due.kind === "event" && due.collect !== undefined) {
        gather(now, event, index, due.collect);
      } else {
        deps.wait(now, event, index);
      }
    };

    let script;

    try {
      script = checkScriptOf(due, context.checks.declared());
    } catch (error) {
      noteCheck(each, index, false, messageOf(error));

      return;
    }

    if (script === undefined) {
      pass();

      return;
    }

    const earlier = firingsBefore(
      each,
      index,
      keyOf(event, each.routine?.sameWork?.key),
      event.fields,
    );

    void runCheck(script, event.fields, earlier).then(({ passed, error }) => {
      noteCheck(each, index, passed, error);

      log("routine trigger checked", {
        owner: each.owner,
        name: each.name,
        trigger: index,
        passed,
        error,
      });

      if (passed) {
        pass();
      }
    });
  };

  // Keeps the event with the others its trigger gathered until its
  // schedule fires.
  const gather = (
    each: L,
    event: Heard,
    trigger: number,
    collect: { readonly cron: string; readonly timeZone?: string },
  ): void => {
    deps.guard(each);

    if (deps.paused(each)) {
      return;
    }

    const firing = { owner: each.owner, name: each.name, trigger };
    const scheduled = collectKey(each.owner, each.name, trigger);
    const now = clock.now();

    const waiting = schedule
      .pending(scheduled)
      .find(({ key }) => key === scheduled)?.payload as Gathered | undefined;

    const at = cronSchedule(collect.cron, collect.timeZone ?? serverZone).next(
      now,
    );

    if (at === undefined) {
      return;
    }

    schedule.at(scheduled, at, {
      ...firing,
      key: "",
      events: [...(waiting?.events ?? []), event].slice(-maxCollected),
      firstAt: waiting?.firstAt ?? now,
      lastAt: now,
    } satisfies Gathered);

    log("routine gathered an event", {
      owner: each.owner,
      name: each.name,
      type: event.type,
      gathered: (waiting?.events.length ?? 0) + 1,
    });
  };

  // Every watch trigger of a loaded routine has its fetch scheduled, from
  // the start again when its address or path changed.
  const keepWatches = (): void => {
    const wanted = new Set<string>();

    for (const each of deps.all()) {
      for (const [trigger, due] of (each.routine?.when ?? []).entries()) {
        if (due.kind !== "watch") {
          continue;
        }

        const firing = { owner: each.owner, name: each.name, trigger };
        const key = watchKey(firing);
        const watching = watchingOf(key);

        wanted.add(key);

        if (watching?.url !== due.url || watching.path !== due.path) {
          schedule.at(key, clock.now(), {
            ...firing,
            url: due.url,
            ...(due.path !== undefined && { path: due.path }),
          } satisfies Watching);
        }
      }
    }

    for (const { key } of schedule.pending("watch:")) {
      if (!wanted.has(key)) {
        schedule.cancel(key);
      }
    }
  };

  const watchingOf = (key: string): Watching | undefined =>
    schedule.pending(key).find((each) => each.key === key)?.payload as
      Watching | undefined;

  // Fetches a watch, and fires its trigger when what it watches changed.
  const fetchWatch = async (watching: Watching, key: string): Promise<void> => {
    const each = deps.loadedOf(watching.owner, watching.name);
    const due = each?.routine?.when[watching.trigger];

    if (
      each === undefined ||
      due?.kind !== "watch" ||
      due.url !== watching.url ||
      due.path !== watching.path
    ) {
      return;
    }

    const next = clock.now() + durationOf(due.every);

    if (deps.paused(each)) {
      schedule.at(key, next, watching);

      return;
    }

    let looked;

    try {
      looked = await look(due, context.network, watching.owner);
    } catch (error) {
      schedule.at(key, next, {
        ...omit(watching, "error"),
        checkedAt: clock.now(),
        error: messageOf(error),
      } satisfies Watching);

      log("routine watch failed", {
        owner: each.owner,
        name: each.name,
        url: due.url,
        error: messageOf(error),
      });

      deps.changed();

      return;
    }

    schedule.at(key, next, {
      ...omit(watching, "error"),
      seen: looked.seen,
      previous: looked.value,
      checkedAt: clock.now(),
    } satisfies Watching);

    deps.changed();

    if (watching.seen === undefined || watching.seen === looked.seen) {
      return;
    }

    const fields = {
      url: due.url,
      status: looked.status,
      value: looked.value,
      previous: watching.previous ?? null,
    };

    const event = { type: watchEvent, fields };

    log("routine watch changed", { owner: each.owner, name: each.name });

    if (matches(event, due.where, deps.repositoriesOf(each))) {
      arrive(
        each,
        {
          ...event,
          inputs: fillAll(due.inputs ?? {}, { event: fields }),
          agent: due.agent,
          workflow: due.workflow,
        },
        watching.trigger,
      );
    }
  };

  // How the routine's checks went last, and its watches' last fetches.
  const notesOf = (each: L): Notes => {
    const checks = (each.routine?.when ?? []).flatMap(
      (_, trigger) =>
        lastChecks.get(`${each.owner}/${each.name}\n${String(trigger)}`) ?? [],
    );

    const watches = (each.routine?.when ?? []).flatMap((due, trigger) => {
      const watching =
        due.kind === "watch"
          ? watchingOf(
              watchKey({ owner: each.owner, name: each.name, trigger }),
            )
          : undefined;

      return watching?.checkedAt === undefined
        ? []
        : [
            {
              trigger,
              at: new Date(watching.checkedAt).toISOString(),
              ...(watching.error !== undefined && { error: watching.error }),
            },
          ];
    });

    return {
      ...(checks.length > 0 && { checks }),
      ...(watches.length > 0 && { watches }),
    };
  };

  schedule.on("collect:", (payload) => {
    deps.flush(payload as Gathered);
  });

  schedule.on("watch:", async (payload, key) => {
    await fetchWatch(payload as Watching, key);
  });

  return { arrive, keepWatches, notesOf };
}

function omit<T extends object, K extends keyof T>(
  value: T,
  ...keys: readonly K[]
): Omit<T, K> {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !keys.includes(key as K)),
  ) as Omit<T, K>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
