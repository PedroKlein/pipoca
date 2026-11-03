import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  watch,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  BadRequest,
  NotFound,
  type ServerPluginContext,
} from "@pipoca/plugins";
import type { Session } from "@pipoca/protocol";
import type { RoutineDetail, RoutineView, Run, RunOutcome } from "./model";
import {
  eventsText,
  isFor,
  keyOf,
  matches,
  namePattern,
  nextFiring,
  type Routine,
  routineOf,
} from "./routine";

const failuresToPause = 3;
const startGraceMs = 30_000;
const maxTimerMs = 60 * 60_000;
const keptRuns = 200;
// Events with the same key within the quiet window go as one; a busy key
// still gets through when the window has been open this long (ADR 0059).
const quietMs = 30_000;
const longestQuietMs = 5 * 60_000;
const maxBatch = 20;

interface Event {
  readonly type: `${string}.${string}`;
  readonly [field: string]: unknown;
}

interface Loaded {
  readonly userId: string;
  readonly name: string;
  readonly version: string;
  readonly routine?: Routine;
  readonly error?: string;
}

interface StateRow {
  readonly user_id: string;
  readonly name: string;
  readonly version: string;
  readonly next_at: number | null;
  readonly paused: string | null;
  readonly failures: number;
}

interface RunRow {
  readonly id: string;
  readonly user_id: string;
  readonly name: string;
  readonly fired_at: number;
  readonly cause: string;
  readonly session_id: string | null;
  readonly outcome: RunOutcome;
  readonly reason: string | null;
  readonly ended_at: number | null;
  readonly key: string;
  // The events the run was started or sent with, as JSON.
  readonly events: string | null;
}

interface HookRow {
  readonly id: string;
  readonly user_id: string;
  readonly name: string;
  readonly secret: string;
}

interface PendingRow {
  readonly user_id: string;
  readonly name: string;
  readonly key: string;
  readonly events: string;
  readonly first_at: number;
  readonly last_at: number;
}

export interface Routines {
  readonly list: (userId: string) => readonly RoutineView[];
  readonly get: (userId: string, name: string) => RoutineDetail;
  readonly save: (userId: string, name: string, value: unknown) => void;
  readonly remove: (userId: string, name: string) => void;
  readonly runNow: (userId: string, name: string) => Run;
  readonly pause: (userId: string, name: string, paused: boolean) => void;
  // The routine's run a Session belongs to, for the report_nothing tool.
  readonly reportNothing: (session: Session) => string;
  // A webhook's delivery, checked against its hook's secret.
  readonly hook: (
    id: string,
    body: string,
    signature: string | null,
  ) => "accepted" | "unknown" | "unsigned";
}

export const ownerPrefix = (userId: string, name: string): string =>
  `${userId}:${name}`;

// Fires every person's routines from their JSON files and records each
// firing as a run (ADR 0059). One timer is armed for the earliest firing.
export function routinesEngine(
  context: Pick<
    ServerPluginContext,
    | "store"
    | "sessions"
    | "events"
    | "changes"
    | "environments"
    | "config"
    | "signal"
    | "log"
  >,
): Routines {
  const { store, sessions, changes, config, log } = context;
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let loaded = new Map<string, Loaded>();

  store.exec(
    "create table if not exists routines_state (user_id text not null, name text not null, version text not null, next_at integer, paused text, failures integer not null default 0, primary key (user_id, name))",
  );

  store.exec(
    "create table if not exists routines_runs (id text primary key, user_id text not null, name text not null, fired_at integer not null, cause text not null, session_id text, outcome text not null, reason text, ended_at integer)",
  );

  const columns = (
    store.all("pragma table_info(routines_runs)") as { name: string }[]
  ).map(({ name }) => name);

  if (!columns.includes("key")) {
    store.exec(
      "alter table routines_runs add column key text not null default ''",
    );
  }

  if (!columns.includes("events")) {
    store.exec("alter table routines_runs add column events text");
  }

  store.exec(
    "create table if not exists routines_hooks (id text primary key, user_id text not null, name text not null, secret text not null, unique (user_id, name))",
  );

  store.exec(
    "create table if not exists routines_pending (user_id text not null, name text not null, key text not null, events text not null, first_at integer not null, last_at integer not null, primary key (user_id, name, key))",
  );

  const key = (userId: string, name: string) => ownerPrefix(userId, name);
  const listening = new Map<string, () => void>();

  const fileOf = (userId: string, name: string) =>
    join(config.dir, userId, `${name}.json`);

  const stateOf = (userId: string, name: string): StateRow | undefined =>
    (
      store.all(
        "select * from routines_state where user_id = ? and name = ?",
        userId,
        name,
      ) as StateRow[]
    )[0];

  const runsOf = (where: string, ...params: (string | number)[]): RunRow[] =>
    store.all(
      `select * from routines_runs where ${where} order by fired_at desc, rowid desc`,
      ...params,
    ) as RunRow[];

  const nextOf = (routine: Routine, after: number): number | null => {
    const times = routine.triggers
      .map((each) => nextFiring(each, after))
      .filter((at): at is number => at !== undefined);

    return times.length === 0 ? null : Math.min(...times);
  };

  const read = (): Map<string, Loaded> => {
    const found = new Map<string, Loaded>();

    if (!existsSync(config.dir)) {
      return found;
    }

    for (const person of readdirSync(config.dir, { withFileTypes: true })) {
      if (!person.isDirectory()) {
        continue;
      }

      for (const file of readdirSync(join(config.dir, person.name))) {
        const name = file.replace(/\.json$/, "");

        if (!file.endsWith(".json") || !namePattern.test(name)) {
          continue;
        }

        const text = readFileSync(join(config.dir, person.name, file), "utf8");
        const version = createHash("sha256").update(text).digest("hex");

        try {
          found.set(key(person.name, name), {
            userId: person.name,
            name,
            version,
            routine: routineOf(JSON.parse(text)),
          });
        } catch (error) {
          found.set(key(person.name, name), {
            userId: person.name,
            name,
            version,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    return found;
  };

  const reload = (): void => {
    loaded = read();

    for (const each of loaded.values()) {
      const state = stateOf(each.userId, each.name);

      if (state?.version === each.version) {
        continue;
      }

      const next =
        each.routine === undefined ? null : nextOf(each.routine, Date.now());

      store.run(
        "insert into routines_state (user_id, name, version, next_at) values (?, ?, ?, ?) on conflict (user_id, name) do update set version = excluded.version, next_at = excluded.next_at",
        each.userId,
        each.name,
        each.version,
        next,
      );

      log("routine loaded", {
        userId: each.userId,
        name: each.name,
        nextAt: next === null ? null : new Date(next).toISOString(),
        error: each.error,
      });
    }

    for (const state of store.all(
      "select * from routines_state",
    ) as StateRow[]) {
      if (!loaded.has(key(state.user_id, state.name))) {
        store.run(
          "delete from routines_state where user_id = ? and name = ?",
          state.user_id,
          state.name,
        );
      }
    }

    const types = new Set(
      [...loaded.values()].flatMap(
        ({ routine }) =>
          routine?.triggers.flatMap((each) =>
            "event" in each ? [each.event] : [],
          ) ?? [],
      ),
    );

    for (const [type, stop] of listening) {
      if (!types.has(type)) {
        stop();
        listening.delete(type);
      }
    }

    for (const type of types) {
      if (!listening.has(type)) {
        listening.set(
          type,
          context.events.subscribe(type as Event["type"], (event) => {
            heard(event);
          }),
        );
      }
    }

    keepHooks();
    changes.publish("routines");
    arm();
  };

  const heard = (event: Event): void => {
    for (const each of loaded.values()) {
      const triggered = each.routine?.triggers.some(
        (trigger) =>
          "event" in trigger &&
          trigger.event === event.type &&
          matches(event, trigger.filter),
      );

      if (triggered === true && isFor(event, each.userId)) {
        wait(each, event);
      }
    }

    arm();
  };

  // Keeps the event with others of its key until the quiet window ends.
  const wait = (each: Loaded, event: Event): void => {
    if (
      each.routine === undefined ||
      (stateOf(each.userId, each.name)?.paused ?? null) !== null
    ) {
      return;
    }

    const eventKey = keyOf(event, each.routine.key);

    const [pending] = store.all(
      "select * from routines_pending where user_id = ? and name = ? and key = ?",
      each.userId,
      each.name,
      eventKey,
    ) as PendingRow[];

    const events = [
      ...(pending === undefined ? [] : (JSON.parse(pending.events) as Event[])),
      event,
    ].slice(-maxBatch);

    store.run(
      "insert into routines_pending (user_id, name, key, events, first_at, last_at) values (?, ?, ?, ?, ?, ?) on conflict (user_id, name, key) do update set events = excluded.events, last_at = excluded.last_at",
      each.userId,
      each.name,
      eventKey,
      JSON.stringify(events),
      Date.now(),
      Date.now(),
    );

    log("routine heard an event", {
      userId: each.userId,
      name: each.name,
      type: event.type,
      key: eventKey,
      waiting: events.length,
    });
  };

  const hookOf = (userId: string, name: string): HookRow | undefined =>
    (
      store.all(
        "select * from routines_hooks where user_id = ? and name = ?",
        userId,
        name,
      ) as HookRow[]
    )[0];

  // Every routine with a webhook trigger has a hook with a secret of its own.
  const keepHooks = (): void => {
    for (const each of loaded.values()) {
      const wanted =
        each.routine?.triggers.some((trigger) => "webhook" in trigger) === true;

      const hook = hookOf(each.userId, each.name);

      if (wanted && hook === undefined) {
        const id = randomBytes(18).toString("base64url");

        store.run(
          "insert into routines_hooks (id, user_id, name, secret) values (?, ?, ?, ?)",
          id,
          each.userId,
          each.name,
          store.seal(randomBytes(32).toString("hex"), id),
        );
      } else if (!wanted && hook !== undefined) {
        store.run("delete from routines_hooks where id = ?", hook.id);
      }
    }

    for (const hook of store.all("select * from routines_hooks") as HookRow[]) {
      if (!loaded.has(key(hook.user_id, hook.name))) {
        store.run("delete from routines_hooks where id = ?", hook.id);
      }
    }
  };

  const pendingDue = (row: PendingRow): number =>
    Math.min(row.last_at + quietMs, row.first_at + longestQuietMs);

  const arm = (): void => {
    clearTimeout(timer);

    const [next] = store.all(
      "select next_at from routines_state where next_at is not null and paused is null order by next_at limit 1",
    ) as { next_at: number }[];

    const pending = (
      store.all("select * from routines_pending") as PendingRow[]
    ).map(pendingDue);

    const soonest = Math.min(
      ...pending,
      ...(next === undefined ? [] : [next.next_at]),
    );

    if (soonest === Infinity || context.signal.aborted) {
      return;
    }

    const at = Math.max(soonest, startedAt + startGraceMs);

    timer = setTimeout(
      fire,
      Math.min(Math.max(at - Date.now(), 0), maxTimerMs),
    );
  };

  const record = (
    userId: string,
    name: string,
    cause: string,
    outcome: RunOutcome,
    reason: string | null = null,
    runKey = "",
    events: readonly Event[] = [],
  ): RunRow => {
    const row: RunRow = {
      id: crypto.randomUUID(),
      user_id: userId,
      name,
      fired_at: Date.now(),
      cause,
      session_id: null,
      outcome,
      reason,
      ended_at:
        outcome === "running" || outcome === "queued" ? null : Date.now(),
      key: runKey,
      events: events.length === 0 ? null : JSON.stringify(events),
    };

    store.run(
      "insert into routines_runs (id, user_id, name, fired_at, cause, session_id, outcome, reason, ended_at, key, events) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      row.id,
      userId,
      name,
      row.fired_at,
      cause,
      null,
      outcome,
      reason,
      row.ended_at,
      runKey,
      row.events,
    );

    store.run(
      "delete from routines_runs where user_id = ? and name = ? and id not in (select id from routines_runs where user_id = ? and name = ? order by fired_at desc, rowid desc limit ?)",
      userId,
      name,
      userId,
      name,
      keptRuns,
    );

    return row;
  };

  const end = (
    run: Pick<RunRow, "id" | "user_id" | "name">,
    outcome: RunOutcome,
    reason: string | null = null,
  ): void => {
    store.run(
      "update routines_runs set outcome = ?, reason = ?, ended_at = ? where id = ?",
      outcome,
      reason,
      Date.now(),
      run.id,
    );

    log("routine run ended", { id: run.id, name: run.name, outcome, reason });

    if (outcome === "failed" || outcome === "blocked") {
      store.run(
        "update routines_state set failures = failures + 1 where user_id = ? and name = ?",
        run.user_id,
        run.name,
      );

      const state = stateOf(run.user_id, run.name);

      if (state !== undefined && state.failures >= failuresToPause) {
        store.run(
          "update routines_state set paused = ? where user_id = ? and name = ?",
          `Paused after ${String(failuresToPause)} failed runs in a row. The last: ${reason ?? outcome}`,
          run.user_id,
          run.name,
        );

        log("routine paused after failures", {
          userId: run.user_id,
          name: run.name,
        });
      }
    } else {
      store.run(
        "update routines_state set failures = 0 where user_id = ? and name = ?",
        run.user_id,
        run.name,
      );
    }

    changes.publish("routines");

    const [queued] = runsOf(
      "user_id = ? and name = ? and outcome = 'queued'",
      run.user_id,
      run.name,
    );

    if (queued !== undefined && !busy(run.user_id, run.name)) {
      deliver(queued);
    }

    arm();
  };

  const busy = (userId: string, name: string): boolean =>
    runsOf("user_id = ? and name = ? and outcome = 'running'", userId, name)
      .length > 0;

  const deliver = (run: RunRow): void => {
    const routine = loaded.get(key(run.user_id, run.name))?.routine;

    if (routine === undefined) {
      end(run, "blocked", "the routine's file is gone or doesn't load");

      return;
    }

    store.run(
      "update routines_runs set outcome = 'running' where id = ?",
      run.id,
    );

    const target = routine.run;

    const events =
      run.events === null
        ? ""
        : `\n\n${eventsText(JSON.parse(run.events) as Event[])}`;

    if ("session" in target) {
      const sent = sessions.send(
        target.session,
        `${target.prompt}${events}`,
        "plugin:routines",
        { kind: "routine", data: { title: routine.title } },
      );

      if (sent.ok) {
        store.run(
          "update routines_runs set session_id = ? where id = ?",
          target.session,
          run.id,
        );

        end(run, "ok");
      } else {
        end(run, "blocked", `the Session is ${sent.reason.replace("_", " ")}`);
      }

      return;
    }

    if (
      target.environment !== undefined &&
      !context.environments.list().some(({ id }) => id === target.environment)
    ) {
      end(run, "blocked", `no Environment ${target.environment}`);

      return;
    }

    const [provider, ...model] = target.model?.split("/") ?? [];

    try {
      const session = sessions.start(
        {
          actor: `user:${run.user_id}`,
          workspace: target.workspace,
          ...(target.environment !== undefined && {
            environment: target.environment,
          }),
          ...(target.profile !== undefined && { profile: target.profile }),
          ...(target.as !== undefined && { actsAs: target.as }),
          ...(provider !== undefined &&
            model.length > 0 && {
              model: { provider, id: model.join("/") },
            }),
          systemPrompt: runPrompt(routine.title),
          firstMessage: `${target.prompt}${events}`,
        },
        key(run.user_id, run.name),
      );

      store.run(
        "update routines_runs set session_id = ? where id = ?",
        session.id,
        run.id,
      );

      log("routine run started", {
        id: run.id,
        name: run.name,
        sessionId: session.id,
      });

      changes.publish("routines");
    } catch (error) {
      end(
        run,
        "blocked",
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  const trigger = (
    userId: string,
    name: string,
    cause: string,
    runKey = "",
    events: readonly Event[] = [],
  ): RunRow => {
    const routine = loaded.get(key(userId, name))?.routine;

    if (routine !== undefined && runKey === "" && busy(userId, name)) {
      const queued =
        (routine.overlap ?? "skip") === "queue" &&
        runsOf("user_id = ? and name = ? and outcome = 'queued'", userId, name)
          .length === 0;

      const row = queued
        ? record(userId, name, cause, "queued", null, runKey, events)
        : record(
            userId,
            name,
            cause,
            "skipped",
            "the last run was still going",
            runKey,
            events,
          );

      changes.publish("routines");

      return row;
    }

    const row = record(userId, name, cause, "running", null, runKey, events);
    deliver(row);

    return row;
  };

  // A key whose last run has a Session that is still there gets the events
  // as a message, instead of a run of its own.
  const flush = (pending: PendingRow): void => {
    store.run(
      "delete from routines_pending where user_id = ? and name = ? and key = ?",
      pending.user_id,
      pending.name,
      pending.key,
    );

    const routine = loaded.get(key(pending.user_id, pending.name))?.routine;
    const events = JSON.parse(pending.events) as Event[];

    if (routine === undefined) {
      return;
    }

    const [last] =
      pending.key === "" || "session" in routine.run
        ? []
        : runsOf(
            "user_id = ? and name = ? and key = ? and session_id is not null",
            pending.user_id,
            pending.name,
            pending.key,
          );

    const session =
      last === undefined || last.session_id === null
        ? undefined
        : sessions.get(last.session_id);

    if (session?.archivedAt !== null) {
      trigger(pending.user_id, pending.name, "event", pending.key, events);

      return;
    }

    const sent = sessions.send(
      session.id,
      eventsText(events),
      "plugin:routines",
      {
        kind: "routine_events",
        data: { title: routine.title, count: events.length },
      },
    );

    const row = record(
      pending.user_id,
      pending.name,
      "event",
      sent.ok ? "ok" : "blocked",
      sent.ok ? "sent to the key's Session" : `the Session is ${sent.reason}`,
      pending.key,
      events,
    );

    store.run(
      "update routines_runs set session_id = ? where id = ?",
      session.id,
      row.id,
    );

    changes.publish("routines");
  };

  function fire(): void {
    for (const pending of store.all(
      "select * from routines_pending",
    ) as PendingRow[]) {
      if (pendingDue(pending) <= Date.now()) {
        flush(pending);
      }
    }

    const due = store.all(
      "select * from routines_state where next_at is not null and next_at <= ? and paused is null",
      Date.now(),
    ) as StateRow[];

    for (const state of due) {
      const routine = loaded.get(key(state.user_id, state.name))?.routine;

      store.run(
        "update routines_state set next_at = ? where user_id = ? and name = ?",
        routine === undefined ? null : nextOf(routine, Date.now()),
        state.user_id,
        state.name,
      );

      if (routine !== undefined) {
        trigger(state.user_id, state.name, "schedule");
      }
    }

    arm();
  }

  const runOfSession = (sessionId: string): RunRow | undefined =>
    runsOf("session_id = ? and outcome = 'running'", sessionId)[0];

  context.events.subscribe("TurnEnded", ({ session }) => {
    const run =
      session.owner?.plugin === "routines"
        ? runOfSession(session.id)
        : undefined;

    if (run !== undefined) {
      end(run, "ok");
    }
  });

  context.events.subscribe("SessionStateChanged", ({ session }) => {
    const run =
      session.owner?.plugin === "routines"
        ? runOfSession(session.id)
        : undefined;

    if (run !== undefined && session.status === "failed") {
      end(run, "failed", session.error ?? "the run's Session failed");
    }
  });

  const owned = (userId: string, name: string): Loaded => {
    const found = loaded.get(key(userId, name));

    if (found === undefined) {
      throw new NotFound(`no routine ${name}`);
    }

    return found;
  };

  const webhookOf = (
    userId: string,
    name: string,
  ): Pick<RoutineDetail, "webhook"> => {
    const hook = hookOf(userId, name);

    return hook === undefined
      ? {}
      : {
          webhook: {
            path: `/api/plugins/routines/hooks/${hook.id}`,
            secret: store.open(hook.secret, hook.id),
          },
        };
  };

  const viewOf = (each: Loaded): RoutineView => {
    const state = stateOf(each.userId, each.name);
    const [last] = runsOf("user_id = ? and name = ?", each.userId, each.name);

    return {
      name: each.name,
      title: each.routine?.title ?? each.name,
      ...(each.error !== undefined && { error: each.error }),
      paused: state?.paused ?? null,
      nextAt:
        state === undefined || state.next_at === null
          ? null
          : new Date(state.next_at).toISOString(),
      lastRun: last === undefined ? null : runView(last),
    };
  };

  mkdirSync(config.dir, { recursive: true });
  reload();

  let settle: ReturnType<typeof setTimeout> | undefined;

  const watcher = watch(config.dir, { recursive: true }, () => {
    clearTimeout(settle);
    settle = setTimeout(reload, 200);
  });

  context.signal.addEventListener("abort", () => {
    clearTimeout(timer);
    clearTimeout(settle);
    watcher.close();
  });

  return {
    list: (userId) =>
      [...loaded.values()]
        .filter((each) => each.userId === userId)
        .map(viewOf)
        .sort((a, b) => a.title.localeCompare(b.title)),
    get: (userId, name) => {
      const each = owned(userId, name);

      return {
        ...viewOf(each),
        file: readFileSync(fileOf(userId, name), "utf8"),
        ...webhookOf(userId, name),
        runs: runsOf("user_id = ? and name = ?", userId, name).map(runView),
      };
    },
    save: (userId, name, value) => {
      if (!namePattern.test(name)) {
        throw new BadRequest(
          "a routine's name is lower-case letters, digits and dashes",
        );
      }

      try {
        routineOf(value);
      } catch (error) {
        throw new BadRequest(
          error instanceof Error ? error.message : String(error),
        );
      }

      mkdirSync(join(config.dir, userId), { recursive: true });

      writeFileSync(
        fileOf(userId, name),
        `${JSON.stringify(value, null, 2)}\n`,
      );

      reload();
    },
    remove: (userId, name) => {
      owned(userId, name);
      rmSync(fileOf(userId, name));
      reload();
    },
    runNow: (userId, name) => {
      const each = owned(userId, name);

      if (each.routine === undefined) {
        throw new BadRequest(each.error ?? "the routine doesn't load");
      }

      return runView(trigger(userId, name, "by hand"));
    },
    pause: (userId, name, paused) => {
      owned(userId, name);

      store.run(
        "update routines_state set paused = ?, failures = 0 where user_id = ? and name = ?",
        paused ? "Paused by you" : null,
        userId,
        name,
      );

      changes.publish("routines");
      arm();
    },
    hook: (id, body, signature) => {
      const [hook] = store.all(
        "select * from routines_hooks where id = ?",
        id,
      ) as HookRow[];

      const each =
        hook === undefined
          ? undefined
          : loaded.get(key(hook.user_id, hook.name));

      if (hook === undefined || each === undefined) {
        return "unknown";
      }

      const expected = Buffer.from(
        `sha256=${createHmac("sha256", store.open(hook.secret, hook.id)).update(body).digest("hex")}`,
      );

      const given = Buffer.from(signature ?? "");

      if (
        given.length !== expected.length ||
        !timingSafeEqual(given, expected)
      ) {
        return "unsigned";
      }

      let fields: unknown;

      try {
        fields = JSON.parse(body);
      } catch {
        fields = { body };
      }

      wait(each, {
        ...(typeof fields === "object" &&
        fields !== null &&
        !Array.isArray(fields)
          ? fields
          : { body: fields }),
        type: "routines.webhook",
      });

      arm();

      return "accepted";
    },
    reportNothing: (session) => {
      const run = runOfSession(session.id);

      if (run === undefined) {
        throw new Error("this Session isn't a routine run that is going");
      }

      end(run, "nothing");

      return "Noted: nothing to do this time. End your turn.";
    },
  };
}

function runView(row: RunRow): Run {
  return {
    id: row.id,
    firedAt: new Date(row.fired_at).toISOString(),
    cause: row.cause,
    sessionId: row.session_id,
    outcome: row.outcome,
    reason: row.reason,
    endedAt:
      row.ended_at === null ? null : new Date(row.ended_at).toISOString(),
  };
}

function runPrompt(title: string): string {
  return [
    `You are running the routine "${title}" on its own; nobody is watching this Session as it works.`,
    "Do the task in the first message. Your final reply is the result the person reads later, not a plan or a question.",
    "When there is nothing to do this time, call report_nothing and end your turn.",
  ].join(" ");
}
