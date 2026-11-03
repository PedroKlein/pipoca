import {
  type NoticeProps,
  json,
  ok,
  type SessionPartProps,
  useLoaded,
  type WebPlugin,
} from "@pipoca/plugins/web";
import { Button, Icon } from "@pipoca/ui";
import type { ReactElement } from "react";
import type { WakeUp } from "../src/model";

// A Session's pending wake-ups above its composer, and the notice each one
// sends when it comes (ADR 0059).
export const routines: WebPlugin = {
  name: "routines",
  Composer: PendingWakeUps,
  notices: { wakeup: WakeUpNotice },
};

function PendingWakeUps({
  context,
  session,
}: SessionPartProps): ReactElement | null {
  const { value, reload } = useLoaded(
    async () =>
      json<readonly WakeUp[]>(
        context.request(`wakeups?session=${encodeURIComponent(session.id)}`),
      ),
    session.id,
    { topics: ["routines.wakeups"] },
  );

  if (value === undefined || value.length === 0) {
    return null;
  }

  return (
    <ul
      aria-label="Wake-ups"
      className="flex flex-col gap-1 rounded-lg border border-line bg-panel px-3 py-1.5"
    >
      {value.map((wakeUp) => (
        <li
          key={wakeUp.id}
          className="flex min-w-0 items-center gap-2 text-label"
        >
          <Icon name="clock" className="size-4 shrink-0 text-fg-dim" />
          <span className="min-w-0 flex-1 truncate text-fg">
            {wakeUp.reason}
          </span>
          <time dateTime={wakeUp.dueAt} className="shrink-0 text-fg-dim">
            {whenOf(wakeUp.dueAt)}
          </time>
          <Button
            variant="ghost"
            className="h-6 px-2"
            aria-label={`Cancel wake-up: ${wakeUp.reason}`}
            onClick={() => {
              void ok(
                context.request(`wakeups/${wakeUp.id}`, { method: "DELETE" }),
              ).finally(reload);
            }}
          >
            Cancel
          </Button>
        </li>
      ))}
    </ul>
  );
}

function WakeUpNotice({ data }: NoticeProps): ReactElement {
  const { reason } = (data ?? {}) as { reason?: unknown };

  return (
    <p className="flex min-w-0 items-center gap-2 px-2 py-1 text-label text-fg-dim">
      <Icon name="clock" className="size-4 shrink-0" />
      <span className="truncate">
        Woke up: {typeof reason === "string" ? reason : "a wake-up"}
      </span>
    </p>
  );
}

function whenOf(iso: string): string {
  const due = new Date(iso);
  const sameDay = due.toDateString() === new Date().toDateString();

  return due.toLocaleString(
    undefined,
    sameDay
      ? { hour: "2-digit", minute: "2-digit" }
      : { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" },
  );
}
