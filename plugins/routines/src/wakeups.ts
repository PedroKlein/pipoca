import {
  NotFound,
  type ServerContext,
  type Session,
  type Static,
  StringEnum,
  ToolError,
  Type,
} from "@pipoca/plugins";
import type { routines } from "../plugin";
import type { WakeUp } from "./model";
import { isZonedTime } from "./routine";

const minuteMs = 60_000;
const dayMs = 24 * 60 * minuteMs;
const maxPending = 10;
const maxDeliveredPerDay = 48;
const maxReasonLength = 120;
const maxMessageLength = 4000;
const prefix = "wakeup:";

type Context = Pick<
  ServerContext<typeof routines>,
  | "store"
  | "sessions"
  | "tools"
  | "events"
  | "routes"
  | "schedule"
  | "clock"
  | "config"
  | "log"
>;

interface Payload {
  readonly reason: string;
  readonly message: string;
}

export interface WakeUps {
  readonly pending: (sessionId: string) => readonly WakeUp[];
  // Cancels a wake-up of a Session the check lets through.
  readonly cancel: (id: string, may: (sessionId: string) => boolean) => void;
}

const params = Type.Object(
  {
    action: Type.Optional(
      StringEnum(["schedule", "list", "cancel"] as const, {
        description: "schedule when left out",
      }),
    ),
    delay_minutes: Type.Optional(
      Type.Number({ description: "How long from now. Give this or at." }),
    ),
    at: Type.Optional(
      Type.String({
        description:
          "When, as an ISO 8601 time with a time zone, such as 2026-11-03T08:00:00+01:00. Give this or delay_minutes.",
      }),
    ),
    reason: Type.Optional(
      Type.String({
        description: "A short line the user sees, such as Check CI on #552.",
      }),
    ),
    message: Type.Optional(
      Type.String({
        description:
          "What you get back at that time: enough to pick the work up without remembering it.",
      }),
    ),
    id: Type.Optional(Type.String({ description: "The wake-up to cancel." })),
  },
  { additionalProperties: false },
);

type Input = Static<typeof params>;

// One-time wake-ups a Session schedules for itself (ADR 0059), each a
// firing in the plugin's schedule keyed by its Session.
export function wakeUps(context: Context): WakeUps {
  const { store, sessions, routes, schedule, clock, config, log } = context;

  const keyOf = (sessionId: string, id: string): string =>
    `${prefix}${sessionId}:${id}`;

  const pending = (sessionId: string): WakeUp[] =>
    schedule.pending(`${prefix}${sessionId}:`).map(({ key, when, payload }) => {
      const { reason, message } = payload as Payload;

      return {
        id: key.slice(`${prefix}${sessionId}:`.length),
        sessionId,
        dueAt: new Date(when).toISOString(),
        reason,
        message,
      };
    });

  const changed = (): void => {
    routes.topic("wakeups");
  };

  schedule.on(prefix, (payload, key) => {
    const [sessionId = "", id = ""] = key.slice(prefix.length).split(":");
    const { reason, message } = payload as Payload;
    const now = clock.now();

    const sent = sessions.send(sessionId, {
      text: `Wake-up you scheduled: ${reason}\n\n${message}`,
      turn: true,
      notice: { kind: "wakeup", data: { reason } },
      dedupe: id,
    });

    if (sent === "queued") {
      store.run(
        "insert into routines_wakeups (id, session_id, delivered_at) values (?, ?, ?)",
        id,
        sessionId,
        now,
      );

      store.run(
        "delete from routines_wakeups where delivered_at < ?",
        now - dayMs,
      );

      log("wake-up delivered", { id, sessionId });
    } else {
      log("wake-up dropped, since its Session is gone", { id, sessionId });
    }

    changed();
  });

  const dueOf = ({ delay_minutes: delay, at }: Input): number => {
    if ((delay === undefined) === (at === undefined)) {
      throw new ToolError("give either delay_minutes or at");
    }

    if (delay !== undefined) {
      return clock.now() + delay * minuteMs;
    }

    if (at === undefined || !isZonedTime(at)) {
      throw new ToolError("at must be an ISO 8601 time with a time zone");
    }

    return Date.parse(at);
  };

  const scheduled = (session: Session, input: Input): string => {
    const reason = input.reason?.trim() ?? "";
    const message = input.message?.trim() ?? "";
    const days = config.get().wakeUpDays;

    if (reason === "" || reason.length > maxReasonLength) {
      throw new ToolError(
        `reason must be a short line of at most ${String(maxReasonLength)} characters`,
      );
    }

    if (message === "" || message.length > maxMessageLength) {
      throw new ToolError(
        `message must be text of at most ${String(maxMessageLength)} characters`,
      );
    }

    const dueAt = dueOf(input);
    const ahead = dueAt - clock.now();

    if (ahead < minuteMs || ahead > days * dayMs) {
      throw new ToolError(
        `a wake-up must be 1 minute to ${String(days)} days ahead`,
      );
    }

    if (pending(session.id).length >= maxPending) {
      throw new ToolError(
        `this Session already has ${String(maxPending)} pending wake-ups; cancel one first`,
      );
    }

    const delivered = store.get<{ count: number }>(
      "select count(*) as count from routines_wakeups where session_id = ? and delivered_at >= ?",
      session.id,
      clock.now() - dayMs,
    );

    if ((delivered?.count ?? 0) >= maxDeliveredPerDay) {
      throw new ToolError(
        `this Session woke up ${String(maxDeliveredPerDay)} times in the last day, the most it may`,
      );
    }

    const id = Bun.randomUUIDv7();

    schedule.at(keyOf(session.id, id), dueAt, {
      reason,
      message,
    } satisfies Payload);

    changed();

    log("wake-up scheduled", {
      id,
      sessionId: session.id,
      dueAt: new Date(dueAt).toISOString(),
    });

    return `Scheduled wake-up ${id} for ${new Date(dueAt).toISOString()}. End your turn now; the message comes back to you then.`;
  };

  const cancelled = (sessionId: string, id: string): boolean => {
    if (!pending(sessionId).some((each) => each.id === id)) {
      return false;
    }

    schedule.cancel(keyOf(sessionId, id));
    changed();

    return true;
  };

  context.tools.define({
    name: "schedule_wakeup",
    description: `Come back to something later: at the time, this Session gets the message as a new turn. Use it instead of sleeping or polling, such as to check CI again in 15 minutes. 1 minute to ${String(config.get().wakeUpDays)} days ahead. action list shows the pending ones and cancel removes one by id.`,
    params,
    exposure: "direct",
    annotations: { readOnly: false, destructive: false },
    run: (input, { session }) => {
      switch (input.action ?? "schedule") {
        case "schedule":
          return scheduled(session, input);
        case "list": {
          const rows = pending(session.id);

          return rows.length === 0
            ? "No pending wake-ups."
            : rows
                .map(({ id, dueAt, reason }) => `${id}: ${dueAt}, ${reason}`)
                .join("\n");
        }

        case "cancel": {
          const id = input.id ?? "";

          if (!cancelled(session.id, id)) {
            throw new ToolError(`this Session has no pending wake-up ${id}`);
          }

          return `Cancelled wake-up ${id}.`;
        }
      }
    },
  });

  context.events.on("SessionArchived", ({ session }) => {
    for (const { id } of pending(session.id)) {
      schedule.cancel(keyOf(session.id, id));
    }

    changed();
  });

  return {
    pending,
    cancel: (id, may) => {
      const found = schedule
        .pending(prefix)
        .find(({ key }) => key.endsWith(`:${id}`));

      const sessionId = found?.key.slice(prefix.length).split(":")[0];

      if (sessionId === undefined || !may(sessionId)) {
        throw new NotFound(`no pending wake-up ${id}`);
      }

      cancelled(sessionId, id);
    },
  };
}
