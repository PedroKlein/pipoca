import type { KernelEvent, PluginStore } from "@pipoca/plugins";
import type { Actor, Session, SessionAccess } from "@pipoca/protocol";

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
  // Newest first, what people did to team work.
  readonly actions: (limit: number) => readonly AuditEntry[];
}

export function auditLog(store: PluginStore): AuditLog {
  const rows = (found: unknown[]): readonly AuditEntry[] =>
    (
      found as (Omit<AuditEntry, "sessionId" | "at"> & {
        session_id: string;
        at: number;
      })[]
    ).map(({ session_id: sessionId, at, ...row }) => ({
      ...row,
      at: new Date(at).toISOString(),
      sessionId,
    }));

  return {
    add: ({ actor, sessionId, action, detail }) => {
      store.run(
        "insert into usage_audit (at, actor, session_id, action, detail) values (?, ?, ?, ?, ?)",
        Date.now(),
        actor,
        sessionId,
        action,
        detail,
      );
    },
    entries: (actor, limit = -1) =>
      rows(
        actor === undefined
          ? store.all(
              "select at, actor, session_id, action, detail from usage_audit order by id desc limit ?",
              limit,
            )
          : store.all(
              "select at, actor, session_id, action, detail from usage_audit where actor = ? order by id desc limit ?",
              actor,
              limit,
            ),
      ),
    actions: (limit) =>
      rows(
        store.all(
          "select at, actor, session_id, action, detail from usage_audit where actor like 'user:%' order by id desc limit ?",
          limit,
        ),
      ),
  };
}

type Audited = Extract<
  KernelEvent,
  {
    type:
      | "SessionCreated"
      | "SessionMoved"
      | "SessionArchived"
      | "SessionUnarchived"
      | "StopAsked"
      | "AccessChanged";
  }
>;

const accessActions: Readonly<Record<SessionAccess["kind"], string>> = {
  team: "opened to the team",
  view: "made view only",
  named: "limited to named people",
};

function actionOf(event: Audited): string {
  switch (event.type) {
    case "SessionCreated":
      return "started";
    case "SessionMoved":
      return "moved to the team";
    case "SessionArchived":
      return "archived";
    case "SessionUnarchived":
      return "unarchived";
    case "StopAsked":
      return "stopped";
    case "AccessChanged":
      return accessActions[event.session.access.kind];
  }
}

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
    action: actionOf(event),
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
