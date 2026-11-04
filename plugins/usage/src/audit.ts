import type { KernelEvent, PluginStore } from "@pipoca/plugins";
import type { Actor, Session } from "@pipoca/protocol";

// One kernel action on team work, or one use of the team's key (ADR 0066).
export interface AuditEntry {
  readonly at: string;
  readonly actor: Actor | null;
  readonly sessionId: string;
  readonly action: string;
  readonly detail: string | null;
}

export interface AuditLog {
  readonly add: (entry: Omit<AuditEntry, "at">) => void;
  // Newest first, everyone's or one actor's.
  readonly entries: (
    actor: Actor | undefined,
    limit: number | undefined,
  ) => readonly AuditEntry[];
}

export function auditLog(store: PluginStore): AuditLog {
  store.exec(
    "create table if not exists usage_audit (id integer primary key, at text not null, actor text, session_id text not null, action text not null, detail text)",
  );

  return {
    add: ({ actor, sessionId, action, detail }) => {
      store.run(
        "insert into usage_audit (at, actor, session_id, action, detail) values (?, ?, ?, ?, ?)",
        new Date().toISOString(),
        actor,
        sessionId,
        action,
        detail,
      );
    },
    entries: (actor, limit = -1) =>
      (
        (actor === undefined
          ? store.all(
              "select at, actor, session_id, action, detail from usage_audit order by id desc limit ?",
              limit,
            )
          : store.all(
              "select at, actor, session_id, action, detail from usage_audit where actor = ? order by id desc limit ?",
              actor,
              limit,
            )) as (Omit<AuditEntry, "sessionId"> & { session_id: string })[]
      ).map(({ session_id: sessionId, ...row }) => ({ ...row, sessionId })),
  };
}

type Audited = Extract<
  KernelEvent,
  {
    type:
      "SessionCreated" | "SessionArchived" | "SessionUnarchived" | "StopAsked";
  }
>;

const actions: Readonly<Record<Audited["type"], string>> = {
  SessionCreated: "started",
  SessionArchived: "archived",
  SessionUnarchived: "unarchived",
  StopAsked: "stopped",
};

// The entry a kernel event on a team Session makes, if any.
export function auditedAction(
  event: Audited,
): Omit<AuditEntry, "at"> | undefined {
  const { session } = event;

  if (!isTeam(session)) {
    return undefined;
  }

  return {
    actor: event.actor ?? null,
    sessionId: session.id,
    action: actions[event.type],
    detail: session.title,
  };
}

function isTeam(session: Session): boolean {
  return session.ownedBy === "team";
}

// Rows as CSV, quoting every field so commas and quotes in titles survive.
export function csv<Key extends string>(
  rows: readonly Readonly<Record<Key, string | number | null>>[],
  columns: readonly Key[],
): string {
  const field = (value: string | number | null): string =>
    `"${(value ?? "").toString().replaceAll('"', '""')}"`;

  return [columns, ...rows.map((row) => columns.map((key) => row[key]))]
    .map((row) => row.map(field).join(","))
    .join("\r\n");
}
