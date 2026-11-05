import {
  NotFound,
  type ServerPluginContext,
  type ServerTool,
} from "@pipoca/plugins";
import type { Session, ToolResult } from "@pipoca/protocol";
import type { WakeUp } from "./model";
import { teamRoutines } from "./engine";

const minuteMs = 60_000;
const dayMs = 24 * 60 * minuteMs;
const maxAheadMs = 30 * dayMs;
const maxPending = 10;
const maxDeliveredPerDay = 48;
const offlineRetryMs = 30_000;
// setTimeout fires at once past about 24.8 days, so a later wake-up re-arms.
const maxTimerMs = 60 * minuteMs;
const maxReasonLength = 120;
const maxMessageLength = 4000;

const toolName = "schedule_wakeup";
const noticeKind = "wakeup";

interface Row {
  readonly id: string;
  readonly session_id: string;
  readonly user_id: string;
  readonly due_at: number;
  readonly reason: string;
  readonly message: string;
}

export interface WakeUps {
  // The person's pending wake-ups in one of their Sessions.
  readonly pending: (userId: string, sessionId: string) => readonly WakeUp[];
  readonly cancel: (userId: string, id: string) => void;
}

// One-time wake-ups a Session schedules for itself (ADR 0059). One timer is
// armed for the earliest due one.
export function wakeUps(
  context: Pick<
    ServerPluginContext,
    "store" | "sessions" | "tools" | "events" | "changes" | "signal" | "log"
  >,
): WakeUps {
  const { store, sessions, changes, log } = context;

  let timer: ReturnType<typeof setTimeout> | undefined;

  const pendingRows = (where: string, ...params: string[]): Row[] =>
    store.all(
      `select id, session_id, coalesce(owner_user_id, 'team') as user_id, due_at, reason, message from routines_wakeups where delivered_at is null and ${where} order by due_at`,
      ...params,
    ) as Row[];

  const arm = (): void => {
    clearTimeout(timer);

    const [next] = store.all(
      "select try_at from routines_wakeups where delivered_at is null order by try_at limit 1",
    ) as { try_at: number }[];

    if (next === undefined || context.signal.aborted) {
      return;
    }

    timer = setTimeout(
      fire,
      Math.min(Math.max(next.try_at - Date.now(), 0), maxTimerMs),
    );
  };

  const deliver = (row: Row): void => {
    const sent = sessions.send(
      row.session_id,
      `Wake-up you scheduled: ${row.reason}\n\n${row.message}`,
      "plugin:routines",
      { kind: noticeKind, data: { reason: row.reason } },
    );

    if (sent.ok) {
      store.run(
        "update routines_wakeups set delivered_at = ? where id = ?",
        Date.now(),
        row.id,
      );

      log("wake-up delivered", { id: row.id, sessionId: row.session_id });

      return;
    }

    if (sent.reason === "offline") {
      store.run(
        "update routines_wakeups set try_at = ? where id = ?",
        Date.now() + offlineRetryMs,
        row.id,
      );

      log("wake-up waits for its Session to come online", {
        id: row.id,
        sessionId: row.session_id,
      });

      return;
    }

    store.run("delete from routines_wakeups where id = ?", row.id);

    log("wake-up dropped", {
      id: row.id,
      sessionId: row.session_id,
      reason: sent.reason,
    });
  };

  function fire(): void {
    const due = store.all(
      "select id, session_id, coalesce(owner_user_id, 'team') as user_id, due_at, reason, message from routines_wakeups where delivered_at is null and try_at <= ? order by due_at",
      Date.now(),
    ) as Row[];

    due.forEach(deliver);

    store.run(
      "delete from routines_wakeups where delivered_at < ?",
      Date.now() - dayMs,
    );

    if (due.length > 0) {
      changes.publish("wakeups");
    }

    arm();
  }

  const schedule = (session: Session, input: Input): string => {
    const reason = input.reason?.trim() ?? "";
    const message = input.message?.trim() ?? "";

    if (reason === "" || reason.length > maxReasonLength) {
      throw new Error(
        `reason must be a short line of at most ${String(maxReasonLength)} characters`,
      );
    }

    if (message === "" || message.length > maxMessageLength) {
      throw new Error(
        `message must be text of at most ${String(maxMessageLength)} characters`,
      );
    }

    const dueAt = dueOf(input);
    const ahead = dueAt - Date.now();

    if (ahead < minuteMs || ahead > maxAheadMs) {
      throw new Error("a wake-up must be 1 minute to 30 days ahead");
    }

    if (pendingRows("session_id = ?", session.id).length >= maxPending) {
      throw new Error(
        `this Session already has ${String(maxPending)} pending wake-ups; cancel one first`,
      );
    }

    const [delivered] = store.all(
      "select count(*) as count from routines_wakeups where session_id = ? and delivered_at >= ?",
      session.id,
      Date.now() - dayMs,
    ) as { count: number }[];

    if ((delivered?.count ?? 0) >= maxDeliveredPerDay) {
      throw new Error(
        `this Session woke up ${String(maxDeliveredPerDay)} times in the last day, the most it may`,
      );
    }

    const id = Bun.randomUUIDv7();

    store.run(
      "insert into routines_wakeups (id, session_id, owner_user_id, due_at, try_at, reason, message) values (?, ?, nullif(?, 'team'), ?, ?, ?, ?)",
      id,
      session.id,
      session.startedBy ?? teamRoutines,
      dueAt,
      dueAt,
      reason,
      message,
    );

    changes.publish("wakeups");
    arm();

    log("wake-up scheduled", {
      id,
      sessionId: session.id,
      dueAt: new Date(dueAt).toISOString(),
    });

    return `Scheduled wake-up ${id} for ${new Date(dueAt).toISOString()}. End your turn now; the message comes back to you then.`;
  };

  const list = (session: Session): string => {
    const rows = pendingRows("session_id = ?", session.id);

    if (rows.length === 0) {
      return "No pending wake-ups.";
    }

    return rows
      .map(
        (row) =>
          `${row.id}: ${new Date(row.due_at).toISOString()}, ${row.reason}`,
      )
      .join("\n");
  };

  const cancelOf = (session: Session, id: string): string => {
    if (pendingRows("id = ? and session_id = ?", id, session.id).length === 0) {
      throw new Error(`this Session has no pending wake-up ${id}`);
    }

    store.run("delete from routines_wakeups where id = ?", id);
    changes.publish("wakeups");
    arm();

    return `Cancelled wake-up ${id}.`;
  };

  context.tools.register({
    name: toolName,
    description:
      "Come back to something later: at the time, this Session gets the message as a new turn. Use it instead of sleeping or polling, such as to check CI again in 15 minutes. 1 minute to 30 days ahead. action list shows the pending ones and cancel removes one by id.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["schedule", "list", "cancel"],
          description: "schedule when left out",
        },
        delay_minutes: {
          type: "number",
          description: "How long from now. Give this or at.",
        },
        at: {
          type: "string",
          description:
            "When, as an ISO 8601 time with a time zone, such as 2026-11-03T08:00:00+01:00. Give this or delay_minutes.",
        },
        reason: {
          type: "string",
          description: "A short line the user sees, such as Check CI on #552.",
        },
        message: {
          type: "string",
          description:
            "What you get back at that time: enough to pick the work up without remembering it.",
        },
        id: { type: "string", description: "The wake-up to cancel." },
      },
      additionalProperties: false,
    },
    exposure: "direct",
    annotations: { readOnlyHint: false, destructiveHint: false },
    appliesTo: () => true,
    run: async (raw, { session }) => {
      const input = (raw ?? {}) as Input;

      return Promise.resolve(
        answer(() => {
          switch (input.action ?? "schedule") {
            case "schedule":
              return schedule(session, input);
            case "list":
              return list(session);
            case "cancel":
              return cancelOf(session, input.id ?? "");
          }
        }),
      );
    },
  } satisfies ServerTool);

  context.events.subscribe("SessionArchived", ({ session }) => {
    store.run(
      "delete from routines_wakeups where session_id = ? and delivered_at is null",
      session.id,
    );

    changes.publish("wakeups");
    arm();
  });

  context.signal.addEventListener("abort", () => {
    clearTimeout(timer);
  });

  arm();

  return {
    pending: (userId, sessionId) =>
      pendingRows(
        "owner_user_id is nullif(?, 'team') and session_id = ?",
        userId,
        sessionId,
      ).map((row) => ({
        id: row.id,
        sessionId: row.session_id,
        dueAt: new Date(row.due_at).toISOString(),
        reason: row.reason,
        message: row.message,
      })),
    cancel: (userId, id) => {
      if (
        pendingRows("id = ? and owner_user_id is nullif(?, 'team')", id, userId)
          .length === 0
      ) {
        throw new NotFound(`no pending wake-up ${id}`);
      }

      store.run("delete from routines_wakeups where id = ?", id);
      changes.publish("wakeups");
      arm();
    },
  };
}

interface Input {
  readonly action?: "schedule" | "list" | "cancel";
  readonly delay_minutes?: number;
  readonly at?: string;
  readonly reason?: string;
  readonly message?: string;
  readonly id?: string;
}

function dueOf({ delay_minutes: delay, at }: Input): number {
  if ((delay === undefined) === (at === undefined)) {
    throw new Error("give either delay_minutes or at");
  }

  if (delay !== undefined) {
    if (!Number.isFinite(delay)) {
      throw new Error("delay_minutes must be a number");
    }

    return Date.now() + delay * minuteMs;
  }

  const due = Date.parse(at ?? "");

  if (Number.isNaN(due) || !/(Z|[+-]\d\d:?\d\d)$/i.test(at ?? "")) {
    throw new Error("at must be an ISO 8601 time with a time zone");
  }

  return due;
}

function answer(run: () => string): ToolResult {
  try {
    return { text: run(), isError: false };
  } catch (failure) {
    return {
      text: failure instanceof Error ? failure.message : String(failure),
      isError: true,
    };
  }
}
