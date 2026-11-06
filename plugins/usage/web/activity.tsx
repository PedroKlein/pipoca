import { usage } from "../plugin";
import { ago, useLoaded, useNow, useApi } from "@pipoca/plugins/web";
import type { ReactElement } from "react";

interface Action {
  readonly at: string;
  readonly actor: string;
  readonly sessionId: string;
  readonly action: string;
  readonly detail: string | null;
}

// Who started, stopped, moved and limited the team's work lately, for the
// hub's Home (ADR 0065).
export function Activity(): ReactElement {
  const api = useApi(usage);

  const now = useNow();

  const { value: actions } = useLoaded(
    async () => api.get<readonly Action[]>("activity"),
    "activity",
    { topics: ["usage.audit"] },
  );

  const { value: teammates = [] } = useLoaded(
    async () => api.get<readonly { id: string; name: string }[]>("/api/people"),
    "teammates",
  );

  if (actions === undefined) {
    return <p className="text-label text-fg-dim">Loading…</p>;
  }

  if (actions.length === 0) {
    return (
      <p className="text-label text-fg-dim">
        Nothing yet. What people do to team work shows up here.
      </p>
    );
  }

  const who = (actor: string): string => {
    const id = actor.slice("user:".length);

    return teammates.find((each) => each.id === id)?.name ?? "Someone";
  };

  return (
    <ul aria-label="Activity" className="flex flex-col gap-2 text-label">
      {actions.map(({ at, actor, sessionId, action, detail }) => (
        <li key={`${at}-${sessionId}-${action}`} className="flex gap-2">
          <span className="min-w-0 flex-1">
            <span className="font-medium text-fg-strong">{who(actor)}</span>{" "}
            {action}{" "}
            <a href={`#${sessionId}`} className="text-fg hover:underline">
              {detail ?? "a Session"}
            </a>
          </span>
          <span className="shrink-0 text-caption text-fg-dim">
            {ago(at, now)}
          </span>
        </li>
      ))}
    </ul>
  );
}
