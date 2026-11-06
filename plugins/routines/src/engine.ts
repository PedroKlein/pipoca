import { createHash, randomBytes, randomUUID } from "node:crypto";
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
  type Owner,
  owners,
  type ServerContext,
  type Session,
} from "@pipoca/plugins";
import type { routines } from "../plugin";
import type {
  RoutineDetail,
  RoutineView,
  Run,
  RunOutcome,
  RunResult,
} from "./model";
import {
  eventsText,
  type Heard,
  keyOf,
  matches,
  namePattern,
  nextFiring,
  type Routine,
  routineOf,
} from "./routine";

const failuresToPause = 3;
// The kernel takes an interrupted Session again, so one that keeps dying
// would run forever (ADR 0059).
const deathsToPark = 5;
// Overdue firings wait this long after a start, so runners can come back.
const startGraceMs = 30_000;
const keptRuns = 200;
// Events with the same key within the quiet window go as one; a busy key
// still gets through when the window has been open this long (ADR 0059).
const quietMs = 30_000;
const longestQuietMs = 5 * 60_000;
const maxBatch = 20;
// Keyed runs that go at once, unless the routine says otherwise.
const defaultMaxRunning = 3;
// Hand edits of a routine's file come in bursts.
const settleMs = 200;

// The git host plugin whose technical users a run acts as (ADR 0060).
const technicalUsers = "git-hosts";

type Context = Pick<
  ServerContext<typeof routines>,
  | "store"
  | "sessions"
  | "events"
  | "routes"
  | "schedule"
  | "environments"
  | "config"
  | "secrets"
  | "clock"
  | "timer"
  | "signal"
  | "log"
  | "transcript"
>;

interface Loaded {
  readonly owner: Owner;
  readonly name: string;
  readonly version: string;
  readonly routine?: Routine;
  readonly error?: string;
}

interface StateRow {
  readonly version: string;
  readonly paused_reason: string | null;
  readonly failures: number;
}

interface RunRow {
  readonly id: string;
  readonly owner_user_id: string | null;
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
  readonly owner_user_id: string | null;
  readonly name: string;
  readonly secret: string;
}

// A routine's firing time and its key's waiting events live in the plugin's
// schedule under these keys, with this as their payload.
interface Firing {
  readonly owner: Owner;
  readonly name: string;
}

interface Batch extends Firing {
  readonly key: string;
  readonly events: readonly Heard[];
  readonly firstAt: number;
  readonly lastAt: number;
}

const firingKey = ({ owner, name }: Firing): string => `fire:${owner}:${name}`;

const batchKey = (firing: Firing, key: string): string =>
  `batch:${firing.owner}:${firing.name}:${key}`;

export interface Routines {
  readonly list: (owner: Owner) => readonly RoutineView[];
  readonly get: (owner: Owner, name: string) => RoutineDetail;
  readonly save: (owner: Owner, name: string, value: unknown) => void;
  readonly remove: (owner: Owner, name: string) => void;
  readonly runNow: (owner: Owner, name: string) => Run;
  readonly pause: (owner: Owner, name: string, paused: boolean) => void;
  readonly exists: (owner: Owner, name: string) => boolean;
  // Ends the run a Session belongs to, as its agent says (ADR 0061).
  readonly endRun: (
    session: Session,
    result: RunResult,
    summary: string,
  ) => string;
  // The secret a webhook's deliveries are signed with.
  readonly hookSecret: (id: string) => string | undefined;
  // A webhook's signed delivery.
  readonly hook: (id: string, body: string) => void;
}

// A routine's file is in its owner's folder: a person's id, or team.
function folderOf(owner: Owner): string {
  return owners.personId(owner) ?? "team";
}

function ownerOfFolder(folder: string): Owner {
  return folder === "team" ? "team" : owners.of(folder);
}

// The key a routine's Sessions are owned by, which its page reads back.
export function sessionKey(owner: Owner, name: string): string {
  return `${owner}/${name}`;
}

// Fires each person's and the team's routines from their JSON files and
// records each firing as a run (ADR 0059). The plugin's schedule keeps each
// routine's next firing and each key's waiting events.
export function routinesEngine(context: Context): Routines {
  const { store, sessions, routes, schedule, config, secrets, clock, log } =
    context;

  const startedAt = clock.now();
  const sql = owners.toSql;
  let loaded = new Map<string, Loaded>();
  const listening = new Set<string>();
  const idOf = sessionKey;

  const changed = (): void => {
    routes.topic("routines");
  };

  const fileOf = (owner: Owner, name: string) =>
    join(config.dir, folderOf(owner), `${name}.json`);

  const stateOf = (owner: Owner, name: string): StateRow | undefined =>
    store.get<StateRow>(
      "select version, paused_reason, failures from routines_state where owner_user_id is ? and name = ?",
      sql(owner),
      name,
    );

  const runsOf = (where: string, ...params: (string | null)[]): RunRow[] =>
    store.all<RunRow>(
      `select * from routines_runs where ${where} order by fired_at desc, rowid desc`,
      ...params,
    );

  const runsOfRoutine = (
    owner: Owner,
    name: string,
    where = "true",
    ...params: string[]
  ): RunRow[] =>
    runsOf(
      `owner_user_id is ? and name = ? and ${where}`,
      sql(owner),
      name,
      ...params,
    );

  const nextOf = (routine: Routine, after: number): number | undefined => {
    const times = routine.triggers
      .map((each) => nextFiring(each, after))
      .filter((at): at is number => at !== undefined);

    return times.length === 0 ? undefined : Math.min(...times);
  };

  const pausedOf = (owner: Owner, name: string): string | null =>
    stateOf(owner, name)?.paused_reason ?? null;

  // Arms the routine's next firing, or takes it away while it is paused.
  const plan = (each: Loaded): number | undefined => {
    const firing = { owner: each.owner, name: each.name };

    const next =
      each.routine === undefined || pausedOf(each.owner, each.name) !== null
        ? undefined
        : nextOf(each.routine, clock.now());

    if (next === undefined) {
      schedule.cancel(firingKey(firing));
    } else {
      schedule.at(firingKey(firing), next, firing);
    }

    return next;
  };

  const read = (): Map<string, Loaded> => {
    const found = new Map<string, Loaded>();

    if (!existsSync(config.dir)) {
      return found;
    }

    for (const folder of readdirSync(config.dir, { withFileTypes: true })) {
      if (!folder.isDirectory()) {
        continue;
      }

      const owner = ownerOfFolder(folder.name);

      for (const file of readdirSync(join(config.dir, folder.name))) {
        const name = file.replace(/\.json$/, "");

        if (!file.endsWith(".json") || !namePattern.test(name)) {
          continue;
        }

        const text = readFileSync(join(config.dir, folder.name, file), "utf8");
        const version = createHash("sha256").update(text).digest("hex");

        try {
          found.set(idOf(owner, name), {
            owner,
            name,
            version,
            routine: routineOf(JSON.parse(text)),
          });
        } catch (error) {
          found.set(idOf(owner, name), {
            owner,
            name,
            version,
            error: messageOf(error),
          });
        }
      }
    }

    return found;
  };

  const heard = (event: Heard & { readonly to: readonly Owner[] }): void => {
    for (const each of loaded.values()) {
      const triggered = each.routine?.triggers.some(
        (trigger) =>
          "event" in trigger &&
          trigger.event === event.type &&
          matches(event, trigger.filter),
      );

      if (triggered === true && event.to.includes(each.owner)) {
        wait(each, { type: event.type, fields: event.fields });
      }
    }
  };

  const reload = (): void => {
    loaded = read();

    for (const each of loaded.values()) {
      if (stateOf(each.owner, each.name)?.version === each.version) {
        continue;
      }

      try {
        store.run(
          "insert into routines_state (owner_user_id, name, version) values (?, ?, ?) on conflict (coalesce(owner_user_id, ''), name) do update set version = excluded.version",
          sql(each.owner),
          each.name,
          each.version,
        );
      } catch (error) {
        // A folder left by a person who is gone, or one no person has.
        loaded.delete(idOf(each.owner, each.name));

        log("routine skipped", {
          owner: each.owner,
          name: each.name,
          error: messageOf(error),
        });

        continue;
      }

      const next = plan(each);

      log("routine loaded", {
        owner: each.owner,
        name: each.name,
        nextAt: next === undefined ? null : new Date(next).toISOString(),
        error: each.error,
      });
    }

    for (const state of store.all<{
      owner_user_id: string | null;
      name: string;
    }>("select owner_user_id, name from routines_state")) {
      const owner = owners.fromSql(state.owner_user_id);

      if (!loaded.has(idOf(owner, state.name))) {
        store.run(
          "delete from routines_state where owner_user_id is ? and name = ?",
          state.owner_user_id,
          state.name,
        );

        schedule.cancel(firingKey({ owner, name: state.name }));
      }
    }

    // A listener stays once added: heard looks only at loaded routines.
    for (const each of loaded.values()) {
      for (const trigger of each.routine?.triggers ?? []) {
        if ("event" in trigger && !listening.has(trigger.event)) {
          listening.add(trigger.event);

          context.events.on(
            trigger.event as `${string}.${string}`,
            ({ type, fields, to }) => {
              heard({ type, fields, to });
            },
          );
        }
      }
    }

    keepHooks();
    changed();
  };

  // Keeps the event with others of its key until the quiet window ends.
  const wait = (each: Loaded, event: Heard): void => {
    if (
      each.routine === undefined ||
      pausedOf(each.owner, each.name) !== null
    ) {
      return;
    }

    const firing = { owner: each.owner, name: each.name };
    const eventKey = keyOf(event, each.routine.key);
    const scheduled = batchKey(firing, eventKey);
    const now = clock.now();

    const waiting = schedule
      .pending(scheduled)
      .find(({ key }) => key === scheduled)?.payload as Batch | undefined;

    const batch: Batch = {
      ...firing,
      key: eventKey,
      events: [...(waiting?.events ?? []), event].slice(-maxBatch),
      firstAt: waiting?.firstAt ?? now,
      lastAt: now,
    };

    schedule.at(
      scheduled,
      Math.min(batch.lastAt + quietMs, batch.firstAt + longestQuietMs),
      batch,
    );

    log("routine heard an event", {
      owner: each.owner,
      name: each.name,
      type: event.type,
      key: eventKey,
      waiting: batch.events.length,
    });
  };

  const hookOf = (owner: Owner, name: string): HookRow | undefined =>
    store.get<HookRow>(
      "select * from routines_hooks where owner_user_id is ? and name = ?",
      sql(owner),
      name,
    );

  // Every routine with a webhook trigger has a hook with a secret of its own.
  const keepHooks = (): void => {
    for (const each of loaded.values()) {
      const wanted =
        each.routine?.triggers.some((trigger) => "webhook" in trigger) === true;

      const hook = hookOf(each.owner, each.name);

      if (wanted && hook === undefined) {
        const id = randomBytes(18).toString("base64url");

        store.run(
          "insert into routines_hooks (id, owner_user_id, name, secret) values (?, ?, ?, ?)",
          id,
          sql(each.owner),
          each.name,
          secrets.seal("routines_hooks", id, randomBytes(32).toString("hex")),
        );
      } else if (!wanted && hook !== undefined) {
        store.run("delete from routines_hooks where id = ?", hook.id);
      }
    }

    for (const hook of store.all<HookRow>("select * from routines_hooks")) {
      if (!loaded.has(idOf(owners.fromSql(hook.owner_user_id), hook.name))) {
        store.run("delete from routines_hooks where id = ?", hook.id);
      }
    }
  };

  const record = (
    owner: Owner,
    name: string,
    cause: string,
    outcome: RunOutcome,
    reason: string | null = null,
    runKey = "",
    events: readonly Heard[] = [],
  ): RunRow => {
    const now = clock.now();

    const row: RunRow = {
      id: randomUUID(),
      owner_user_id: sql(owner),
      name,
      fired_at: now,
      cause,
      session_id: null,
      outcome,
      reason,
      ended_at: outcome === "running" || outcome === "queued" ? null : now,
      key: runKey,
      events: events.length === 0 ? null : JSON.stringify(events),
    };

    store.run(
      "insert into routines_runs (id, owner_user_id, name, fired_at, cause, session_id, outcome, reason, ended_at, key, events) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      row.id,
      row.owner_user_id,
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
      "delete from routines_runs where owner_user_id is ? and name = ? and id not in (select id from routines_runs where owner_user_id is ? and name = ? order by fired_at desc, rowid desc limit ?)",
      row.owner_user_id,
      name,
      row.owner_user_id,
      name,
      keptRuns,
    );

    return row;
  };

  const running = (owner: Owner, name: string): number =>
    runsOfRoutine(owner, name, "outcome = 'running'").filter(
      ({ session_id }) =>
        session_id === null || sessions.get(session_id)?.archivedAt === null,
    ).length;

  const hasRoom = (owner: Owner, name: string): boolean =>
    running(owner, name) <
    (loaded.get(idOf(owner, name))?.routine?.maxRunning ?? defaultMaxRunning);

  const end = (
    run: Pick<RunRow, "id" | "owner_user_id" | "name">,
    outcome: RunOutcome,
    reason: string | null = null,
    // An agent that says it is blocked did its job. Only runs that failed
    // or couldn't start count towards pausing the routine.
    failure = outcome === "failed" || outcome === "blocked",
  ): void => {
    const owner = owners.fromSql(run.owner_user_id);

    store.run(
      "update routines_runs set outcome = ?, reason = ?, ended_at = ? where id = ?",
      outcome,
      reason,
      clock.now(),
      run.id,
    );

    log("routine run ended", { id: run.id, name: run.name, outcome, reason });

    if (failure) {
      store.run(
        "update routines_state set failures = failures + 1 where owner_user_id is ? and name = ?",
        run.owner_user_id,
        run.name,
      );

      const state = stateOf(owner, run.name);

      if (state?.paused_reason === null && state.failures >= failuresToPause) {
        store.run(
          "update routines_state set paused_at = ?, paused_reason = ? where owner_user_id is ? and name = ?",
          clock.now(),
          `Paused after ${String(failuresToPause)} failed runs in a row. The last: ${reason ?? outcome}`,
          run.owner_user_id,
          run.name,
        );

        schedule.cancel(firingKey({ owner, name: run.name }));
        log("routine paused after failures", { owner, name: run.name });
      }
    } else {
      store.run(
        "update routines_state set failures = 0 where owner_user_id is ? and name = ?",
        run.owner_user_id,
        run.name,
      );
    }

    changed();

    const queued = runsOfRoutine(owner, run.name, "outcome = 'queued'").at(-1);

    if (
      queued !== undefined &&
      (queued.key === ""
        ? running(owner, run.name) === 0
        : hasRoom(owner, run.name))
    ) {
      deliver(queued);
    }
  };

  const deliver = (run: RunRow): void => {
    const owner = owners.fromSql(run.owner_user_id);
    const person = owners.personId(owner);
    const routine = loaded.get(idOf(owner, run.name))?.routine;

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
        : `\n\n${eventsText(JSON.parse(run.events) as Heard[])}`;

    if ("session" in target) {
      if (person === undefined || !sessions.sees(target.session, person)) {
        end(run, "blocked", `no Session ${target.session} of the owner's`);

        return;
      }

      const sent = sessions.send(target.session, {
        text: `${target.prompt}${events}`,
        turn: true,
        notice: { kind: "routine", data: { title: routine.title } },
        dedupe: run.id,
      });

      if (sent === "queued") {
        store.run(
          "update routines_runs set session_id = ? where id = ?",
          target.session,
          run.id,
        );

        end(run, "ok");
      } else {
        end(run, "blocked", "the Session is archived or gone");
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
      const session = sessions.start({
        ...(person === undefined
          ? { actor: "plugin:routines", team: true }
          : { actor: `user:${person}` }),
        workspace: target.workspace,
        ...(target.environment !== undefined && {
          environment: target.environment,
        }),
        ...(target.profile !== undefined && { profile: target.profile }),
        ...(target.as !== undefined && {
          actsAs: { plugin: technicalUsers, name: target.as },
        }),
        ...(provider !== undefined &&
          model.length > 0 && {
            model: { provider, id: model.join("/") },
          }),
        systemPrompt: runPrompt(routine.title),
        firstMessage: `${target.prompt}${events}`,
        key: idOf(owner, run.name),
      });

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

      changed();
    } catch (error) {
      end(run, "blocked", messageOf(error));
    }
  };

  const trigger = (
    owner: Owner,
    name: string,
    cause: string,
    runKey = "",
    events: readonly Heard[] = [],
  ): RunRow => {
    const routine = loaded.get(idOf(owner, name))?.routine;

    if (routine !== undefined && runKey === "" && running(owner, name) > 0) {
      const queued =
        (routine.overlap ?? "skip") === "queue" &&
        runsOfRoutine(owner, name, "outcome = 'queued'").length === 0;

      const row = queued
        ? record(owner, name, cause, "queued", null, runKey, events)
        : record(
            owner,
            name,
            cause,
            "skipped",
            "the last run was still going",
            runKey,
            events,
          );

      changed();

      return row;
    }

    if (runKey !== "" && !hasRoom(owner, name)) {
      const row = record(owner, name, cause, "queued", null, runKey, events);
      changed();

      return row;
    }

    const row = record(owner, name, cause, "running", null, runKey, events);
    deliver(row);

    return runsOf("id = ?", row.id)[0] ?? row;
  };

  // A key whose last run has a Session that is still there gets the events
  // as a message, instead of a run of its own.
  const flush = (batch: Batch): void => {
    const { owner, name, key, events } = batch;
    const routine = loaded.get(idOf(owner, name))?.routine;

    if (routine === undefined) {
      return;
    }

    const [waiting] = runsOfRoutine(
      owner,
      name,
      "key = ? and outcome = 'queued'",
      key,
    );

    if (waiting !== undefined) {
      store.run(
        "update routines_runs set events = ? where id = ?",
        JSON.stringify(
          [...(JSON.parse(waiting.events ?? "[]") as Heard[]), ...events].slice(
            -maxBatch,
          ),
        ),
        waiting.id,
      );

      return;
    }

    const [last] =
      key === "" || "session" in routine.run
        ? []
        : runsOfRoutine(owner, name, "key = ? and session_id is not null", key);

    const session =
      last?.session_id === null || last === undefined
        ? undefined
        : sessions.get(last.session_id);

    if (session?.archivedAt !== null) {
      trigger(owner, name, "event", key, events);

      return;
    }

    const sent = sessions.send(session.id, {
      text: eventsText(events),
      turn: true,
      notice: {
        kind: "routine_events",
        data: { title: routine.title, count: events.length },
      },
    });

    const row = record(
      owner,
      name,
      "event",
      sent === "queued" ? "ok" : "blocked",
      sent === "queued"
        ? "sent to the key's Session"
        : "the key's Session is gone",
      key,
      events,
    );

    store.run(
      "update routines_runs set session_id = ? where id = ?",
      session.id,
      row.id,
    );

    changed();
  };

  const fire = (firing: Firing): void => {
    const each = loaded.get(idOf(firing.owner, firing.name));
    const now = clock.now();

    if (each?.routine === undefined) {
      return;
    }

    if (now < startedAt + startGraceMs) {
      schedule.at(firingKey(firing), startedAt + startGraceMs, firing);

      return;
    }

    if (plan(each) === undefined && pausedOf(each.owner, each.name) !== null) {
      return;
    }

    trigger(firing.owner, firing.name, "schedule");
  };

  schedule.on("fire:", (payload) => {
    fire(payload as Firing);
  });

  schedule.on("batch:", (payload) => {
    flush(payload as Batch);
  });

  const runOfSession = (sessionId: string): RunRow | undefined =>
    runsOf("session_id = ? and outcome = 'running'", sessionId)[0];

  context.events.on("TurnEnded", ({ session }) => {
    const run =
      session.owner?.plugin === "routines"
        ? runOfSession(session.id)
        : undefined;

    if (run !== undefined) {
      end(run, "stopped", "the turn ended without end_run");
    }
  });

  context.events.on("SessionStateChanged", ({ session }) => {
    const run =
      session.owner?.plugin === "routines"
        ? runOfSession(session.id)
        : undefined;

    if (run !== undefined && session.status === "failed") {
      end(run, "failed", session.error ?? "the run's Session failed");
    }

    if (run !== undefined && session.status === "stopped") {
      end(run, "stopped", "the run's Session stopped");
    }

    if (run !== undefined && session.status === "interrupted") {
      died(run, session.id);
    }
  });

  const died = (run: RunRow, sessionId: string): void => {
    const progress = context.transcript.messages(sessionId).length;

    const before = store.get<{ deaths: number; progress: number }>(
      "select deaths, progress from routines_runs where id = ?",
      run.id,
    );

    const deaths =
      before === undefined || progress > before.progress
        ? 1
        : before.deaths + 1;

    store.run(
      "update routines_runs set deaths = ?, progress = ? where id = ?",
      deaths,
      progress,
      run.id,
    );

    if (deaths < deathsToPark) {
      return;
    }

    const owner = owners.fromSql(run.owner_user_id);

    store.run(
      "update routines_state set paused_at = ?, paused_reason = ? where owner_user_id is ? and name = ? and paused_reason is null",
      clock.now(),
      `Parked after a run's Session died ${String(deathsToPark)} times without progress.`,
      run.owner_user_id,
      run.name,
    );

    schedule.cancel(firingKey({ owner, name: run.name }));
    log("routine parked", { owner, name: run.name, sessionId });

    end(
      run,
      "failed",
      `the run's Session died ${String(deathsToPark)} times without progress`,
    );

    sessions.archive(sessionId);
  };

  context.events.on("SessionArchived", ({ session }) => {
    const run =
      session.owner?.plugin === "routines"
        ? runOfSession(session.id)
        : undefined;

    if (run !== undefined) {
      end(run, "stopped", "the run's Session was archived");
    }
  });

  const owned = (owner: Owner, name: string): Loaded => {
    const found = loaded.get(idOf(owner, name));

    if (found === undefined) {
      throw new NotFound(`no routine ${name}`);
    }

    return found;
  };

  const viewOf = (each: Loaded): RoutineView => {
    const key = firingKey(each);
    const [last] = runsOfRoutine(each.owner, each.name);

    const next = schedule
      .pending(key)
      .find((scheduled) => scheduled.key === key)?.when;

    return {
      name: each.name,
      title: each.routine?.title ?? each.name,
      ...(each.error !== undefined && { error: each.error }),
      paused: pausedOf(each.owner, each.name),
      nextAt: next === undefined ? null : new Date(next).toISOString(),
      lastRun: last === undefined ? null : runView(last),
    };
  };

  mkdirSync(config.dir, { recursive: true });
  reload();

  let settle: (() => void) | undefined;

  const watcher = watch(config.dir, { recursive: true }, () => {
    settle?.();

    settle = context.timer.after(settleMs, async () => {
      settle = undefined;
      reload();

      await Promise.resolve();
    });
  });

  context.signal.addEventListener("abort", () => {
    settle?.();
    watcher.close();
  });

  return {
    list: (owner) =>
      [...loaded.values()]
        .filter((each) => each.owner === owner)
        .map(viewOf)
        .sort((a, b) => a.title.localeCompare(b.title)),
    get: (owner, name) => {
      const each = owned(owner, name);
      const hook = hookOf(owner, name);

      return {
        ...viewOf(each),
        file: readFileSync(fileOf(owner, name), "utf8"),
        ...(hook && {
          webhook: {
            path: `/api/ext/routines/hooks/${hook.id}`,
            secret: secrets.open("routines_hooks", hook.id, hook.secret),
          },
        }),
        runs: runsOfRoutine(owner, name).map(runView),
      };
    },
    exists: (owner, name) => loaded.has(idOf(owner, name)),
    save: (owner, name, value) => {
      if (!namePattern.test(name)) {
        throw new BadRequest(
          "a routine's name is lower-case letters, digits and dashes",
        );
      }

      let routine;

      try {
        routine = routineOf(value);
      } catch (error) {
        throw new BadRequest(messageOf(error));
      }

      if (owner === "team" && "session" in routine.run) {
        throw new BadRequest(
          "a team routine starts a Session of its own each time",
        );
      }

      mkdirSync(join(config.dir, folderOf(owner)), { recursive: true });

      writeFileSync(fileOf(owner, name), `${JSON.stringify(value, null, 2)}\n`);

      reload();
    },
    remove: (owner, name) => {
      owned(owner, name);
      rmSync(fileOf(owner, name));
      reload();
    },
    runNow: (owner, name) => {
      const each = owned(owner, name);

      if (each.routine === undefined) {
        throw new BadRequest(each.error ?? "the routine doesn't load");
      }

      return runView(trigger(owner, name, "by hand"));
    },
    pause: (owner, name, paused) => {
      const each = owned(owner, name);

      store.run(
        "update routines_state set paused_at = ?, paused_reason = ?, failures = 0 where owner_user_id is ? and name = ?",
        paused ? clock.now() : null,
        paused ? "Paused by you" : null,
        sql(owner),
        name,
      );

      plan(each);
      changed();
    },
    hookSecret: (id) => {
      const hook = store.get<HookRow>(
        "select * from routines_hooks where id = ?",
        id,
      );

      return hook && secrets.open("routines_hooks", hook.id, hook.secret);
    },
    hook: (id, body) => {
      const hook = store.get<HookRow>(
        "select * from routines_hooks where id = ?",
        id,
      );

      const each =
        hook === undefined
          ? undefined
          : loaded.get(idOf(owners.fromSql(hook.owner_user_id), hook.name));

      if (each === undefined) {
        throw new NotFound("no such webhook");
      }

      let fields: unknown;

      try {
        fields = JSON.parse(body);
      } catch {
        fields = body;
      }

      wait(each, {
        type: "routines.webhook",
        fields:
          typeof fields === "object" &&
          fields !== null &&
          !Array.isArray(fields)
            ? (fields as Readonly<Record<string, unknown>>)
            : { body: fields },
      });
    },
    endRun: (session, result, summary) => {
      const run = runOfSession(session.id);

      if (run === undefined) {
        throw new BadRequest("this Session isn't a routine run that is going");
      }

      const outcomes = {
        done: "ok",
        nothing: "nothing",
        blocked: "blocked",
      } as const;

      end(run, outcomes[result], summary, false);

      return "Noted. End your turn.";
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
    "When you finish, call end_run with done and a one-line summary. When there is nothing to do this time, call it with nothing. When you can't go on without a person, such as a question only they can answer, call it with blocked and say why. Then end your turn.",
  ].join(" ");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
