import type { DatabaseSync, SQLInputValue, StatementSync } from "node:sqlite";
import type {
  Actor,
  Clock,
  SessionAccess,
  SessionStatus,
  ThinkingLevel,
  ToolResult,
  Workspace,
  WorkspaceRemoval,
} from "@pipoca/protocol";
import {
  defaultProfileId as sharedDefault,
  type ProfileFolders,
  type ProfileStore,
} from "@pipoca/profiles";
import type {
  OutboxStore,
  Queued,
  SessionStore,
  StoredSession,
  StoredVoice,
} from "@pipoca/sessions";
import { transaction } from "./database";
import { iso, isoOrNull, ms, msOrNull, userOf } from "./rows";

interface SessionRow {
  id: string;
  environment_id: string;
  plugin: string | null;
  plugin_key: string | null;
  provider: string;
  runner: string | null;
  profile_id: string;
  workspace: string;
  model_provider: string | null;
  model_id: string | null;
  system_prompt: string | null;
  first_message: string | null;
  thinking: ThinkingLevel | null;
  title: string | null;
  status: SessionStatus;
  generation: number;
  created_at: number;
  interrupted_at: number | null;
  error: string | null;
  archived_at: number | null;
  workspace_removal: WorkspaceRemoval | null;
  workspace_kept_reason: string | null;
  started_by: string | null;
  acts_as_plugin: string | null;
  acts_as: string | null;
}

interface VoiceRow {
  kind: StoredVoice["kind"];
  actor: Actor;
  text: string | null;
  quote_from: string | null;
  quote_text: string | null;
  plugin: string | null;
  notice: string | null;
  at: number;
}

export function sessionStore(
  db: DatabaseSync,
  clock: Clock,
  profiles: ProfileFolders | undefined,
): SessionStore {
  const toSession = (row: SessionRow): StoredSession => ({
    id: row.id,
    environmentId: row.environment_id,
    plugin:
      row.plugin === null || row.plugin_key === null
        ? null
        : { id: row.plugin, key: row.plugin_key },
    provider: row.provider,
    runner: row.runner,
    profileId: row.profile_id,
    workspace: JSON.parse(row.workspace) as Workspace,
    model:
      row.model_provider === null || row.model_id === null
        ? null
        : { provider: row.model_provider, id: row.model_id },
    systemPrompt: row.system_prompt,
    thinking: row.thinking,
    firstMessage: row.first_message,
    title: row.title,
    status: row.status,
    generation: row.generation,
    createdAt: iso(row.created_at),
    interruptedAt: isoOrNull(row.interrupted_at),
    error: row.error,
    archivedAt: isoOrNull(row.archived_at),
    workspaceRemoval: row.workspace_removal,
    workspaceKeptReason: row.workspace_kept_reason,
    startedBy: row.started_by,
    actsAs:
      row.acts_as_plugin === null || row.acts_as === null
        ? null
        : { plugin: row.acts_as_plugin, name: row.acts_as },
  });

  const sessionRows = (statement: StatementSync, ...params: SQLInputValue[]) =>
    (statement.all(...params) as unknown as SessionRow[]).map(toSession);

  const insertSession = db.prepare(
    "insert into sessions (id, environment_id, plugin, plugin_key, runner, profile_id, workspace, model_provider, model_id, system_prompt, first_message, thinking, title, status, generation, created_at, interrupted_at, error, archived_at, workspace_removal, workspace_kept_reason, started_by, acts_as_plugin, acts_as) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );

  const updateSession = db.prepare(
    "update sessions set runner = ?, workspace = ?, status = ?, generation = ?, interrupted_at = ?, error = ?, archived_at = ?, workspace_removal = ?, workspace_kept_reason = ? where id = ?",
  );

  const withProvider =
    "select sessions.*, environments.slug as provider from sessions join environments on environments.id = sessions.environment_id";

  const selectSession = db.prepare(`${withProvider} where sessions.id = ?`);

  const selectSessions = db.prepare(
    `${withProvider} order by sessions.created_at desc`,
  );

  const selectUnarchivedSessions = db.prepare(
    `${withProvider} where sessions.archived_at is null order by sessions.created_at desc`,
  );

  const selectOwnedSessions = db.prepare(
    `${withProvider} where plugin = ? and plugin_key = ? order by sessions.created_at desc`,
  );

  const selectUnarchivedOwnedSessions = db.prepare(
    `${withProvider} where plugin = ? and plugin_key = ? and sessions.archived_at is null order by sessions.created_at desc`,
  );

  const selectVoices = db.prepare(
    "select kind, actor, text, quote_from, quote_text, plugin, notice, at from session_messages where session_id = ? order by seq",
  );

  const insertVoice = db.prepare(
    "insert into session_messages (session_id, seq, kind, actor, user_id, request_id, text, quote_from, quote_text, plugin, notice, at) values (?1, (select coalesce(max(seq), 0) + 1 from session_messages where session_id = ?1), ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11) on conflict (session_id, request_id) do nothing",
  );

  const insertBinding = db.prepare(
    "insert into session_bindings (plugin, key, session_id, created_at) values (?, ?, ?, ?) on conflict (plugin, key) do update set session_id = excluded.session_id, created_at = excluded.created_at",
  );

  const selectBinding = db.prepare(
    "select session_id from session_bindings where plugin = ? and key = ?",
  );


  const selectAccess = db.prepare("select access from sessions where id = ?");

  const selectAccessPeople = db.prepare(
    "select user_id from session_access_people where session_id = ? order by rowid",
  );

  const updateAccess = db.prepare(
    "update sessions set access = ? where id = ?",
  );

  const deleteAccessPeople = db.prepare(
    "delete from session_access_people where session_id = ?",
  );

  const insertAccessPerson = db.prepare(
    "insert or ignore into session_access_people (session_id, user_id) values (?, ?)",
  );

  const selectByEnvironment = db.prepare(
    `${withProvider} where environments.slug = ? and status in (select value from json_each(?)) order by sessions.created_at`,
  );

  const selectByRunner = db.prepare(
    `${withProvider} where environments.slug = ? and runner = ? and status in (select value from json_each(?)) order by sessions.created_at`,
  );

  const selectPendingRemovals = db.prepare(
    `${withProvider} where environments.slug = ? and (runner = ? or runner is null) and status = ? and workspace_removal in (?, ?) order by sessions.created_at`,
  );

  const countTranscript = db.prepare(
    "select count(*) as n from transcript_lines where session_id = ?",
  );

  const insertTranscriptLine = db.prepare(
    "insert into transcript_lines (session_id, line, entry) values (?, ?, ?)",
  );

  const updateTitle = db.prepare("update sessions set title = ? where id = ?");

  const updateModel = db.prepare(
    "update sessions set model_provider = ?, model_id = ? where id = ?",
  );

  const selectDefault = db.prepare(
    "select default_profile_id from users where id = ?",
  );

  const selectDefaultEnvironment = db.prepare(
    "select default_environment_id from users where id = ?",
  );

  const selectTrust = db.prepare(
    "select trusted from repository_trust where owner_user_id is ? and repository = ?",
  );

  const deleteTrust = db.prepare(
    "delete from repository_trust where owner_user_id is ? and repository = ?",
  );

  const insertTrust = db.prepare(
    "insert into repository_trust (owner_user_id, repository, trusted, decided_at) values (?, ?, ?, ?)",
  );

  const selectTranscript = db.prepare(
    "select entry from transcript_lines where session_id = ? and line >= ? order by line",
  );

  return {
    insert: (s) => {
      insertSession.run(
        s.id,
        s.environmentId,
        s.plugin?.id ?? null,
        s.plugin?.key ?? null,
        s.runner,
        s.profileId,
        JSON.stringify(s.workspace),
        s.model?.provider ?? null,
        s.model?.id ?? null,
        s.systemPrompt,
        s.firstMessage,
        s.thinking,
        s.title,
        s.status,
        s.generation,
        ms(s.createdAt),
        msOrNull(s.interruptedAt),
        s.error,
        msOrNull(s.archivedAt),
        s.workspaceRemoval,
        s.workspaceKeptReason,
        s.startedBy,
        s.actsAs?.plugin ?? null,
        s.actsAs?.name ?? null,
      );
    },
    update: (s) => {
      updateSession.run(
        s.runner,
        JSON.stringify(s.workspace),
        s.status,
        s.generation,
        msOrNull(s.interruptedAt),
        s.error,
        msOrNull(s.archivedAt),
        s.workspaceRemoval,
        s.workspaceKeptReason,
        s.id,
      );
    },
    get: (id) => {
      const row = selectSession.get(id) as SessionRow | undefined;

      return row && toSession(row);
    },
    list: ({ includeArchived, plugin: ownedBy }) =>
      ownedBy
        ? sessionRows(
            includeArchived
              ? selectOwnedSessions
              : selectUnarchivedOwnedSessions,
            ownedBy.id,
            ownedBy.key,
          )
        : sessionRows(
            includeArchived ? selectSessions : selectUnarchivedSessions,
          ),
    access: (id) => {
      const row = selectAccess.get(id) as
        { access: SessionAccess["kind"] } | undefined;

      if (row === undefined || row.access === "team") {
        return undefined;
      }

      return row.access === "view"
        ? { kind: "view" }
        : {
            kind: "named",
            people: (selectAccessPeople.all(id) as { user_id: string }[]).map(
              ({ user_id }) => user_id,
            ),
          };
    },
    setAccess: (id, access) => {
      transaction(db, () => {
        updateAccess.run(access.kind, id);
        deleteAccessPeople.run(id);

        if (access.kind === "named") {
          for (const person of access.people) {
            insertAccessPerson.run(id, person);
          }
        }
      });
    },
    voices: (id) =>
      (selectVoices.all(id) as unknown as VoiceRow[]).map((row) => ({
        kind: row.kind,
        actor: row.actor,
        at: iso(row.at),
        ...(row.text !== null && { text: row.text }),
        ...(row.quote_from !== null &&
          row.quote_text !== null && {
            quote: { from: row.quote_from, text: row.quote_text },
          }),
        ...(row.plugin !== null &&
          row.notice !== null && {
            notice: {
              plugin: row.plugin,
              ...(JSON.parse(row.notice) as { kind: string; data?: unknown }),
            },
          }),
      })),
    addVoice: (id, voice) =>
      insertVoice.run(
        id,
        voice.kind,
        voice.actor,
        voice.actor.startsWith("user:")
          ? voice.actor.slice("user:".length)
          : null,
        voice.requestId ?? null,
        voice.text ?? null,
        voice.quote?.from ?? null,
        voice.quote?.text ?? null,
        voice.notice?.plugin ?? null,
        voice.notice === undefined
          ? null
          : JSON.stringify({
              kind: voice.notice.kind,
              data: voice.notice.data,
            }),
        ms(voice.at),
      ).changes > 0,
    outbox: outboxStore(db),
    bindings: {
      bind: (plugin, key, sessionId, at) => {
        insertBinding.run(plugin, key, sessionId, at);
      },
      boundTo: (plugin, key) =>
        (selectBinding.get(plugin, key) as { session_id: string } | undefined)
          ?.session_id,
    },
    byEnvironment: (provider, statuses) =>
      sessionRows(selectByEnvironment, provider, JSON.stringify(statuses)),
    byRunner: (provider, runner, statuses) =>
      sessionRows(selectByRunner, provider, runner, JSON.stringify(statuses)),
    pendingRemovals: (provider, runner) =>
      sessionRows(
        selectPendingRemovals,
        provider,
        runner,
        "stopped" satisfies SessionStatus,
        "pending" satisfies WorkspaceRemoval,
        "forced" satisfies WorkspaceRemoval,
      ),
    transcriptLength: (id) => (countTranscript.get(id) as { n: number }).n,
    appendTranscript: (id, start, lines) => {
      transaction(db, () => {
        lines.forEach((entry, i) =>
          insertTranscriptLine.run(id, start + i, entry),
        );
      });
    },
    setModel: (id, model) => {
      updateModel.run(model.provider, model.id, id);
    },
    setTitle: (id, title) => {
      updateTitle.run(title, id);
    },
    transcript: (id, from) =>
      (selectTranscript.all(id, from) as { entry: string }[]).map(
        (r) => r.entry,
      ),
    profile: (id) => profiles?.read(id),
    profileFiles: (id, personId) => profiles?.files(id, personId ?? undefined),
    baseProfileFiles: (personId) => profiles?.layers(personId ?? undefined),
    // Owners use the shared default Profile until they pick another
    // (ADR 0041).
    defaultProfileId: (ownerId) =>
      (
        selectDefault.get(ownerId) as
          { default_profile_id: string | null } | undefined
      )?.default_profile_id ?? sharedDefault,
    defaultEnvironmentId: (userId) =>
      (
        selectDefaultEnvironment.get(userId) as
          { default_environment_id: string | null } | undefined
      )?.default_environment_id ?? null,
    repositoryTrust: (ownerId, repository) => {
      const row = selectTrust.get(userOf(ownerId), repository) as
        { trusted: number } | undefined;

      return row === undefined ? null : row.trusted === 1;
    },
    setRepositoryTrust: (ownerId, repository, trusted) => {
      transaction(db, () => {
        deleteTrust.run(userOf(ownerId), repository);

        insertTrust.run(
          userOf(ownerId),
          repository,
          trusted ? 1 : 0,
          clock.now(),
        );
      });
    },
  };
}

export function profileStore(db: DatabaseSync): ProfileStore {
  const selectDefault = db.prepare(
    "select default_profile_id from users where id = ?",
  );

  const updateDefault = db.prepare(
    "update users set default_profile_id = ? where id = ?",
  );

  const selectProfileUse = db.prepare(
    "select 1 from sessions where profile_id = ? and archived_at is null limit 1",
  );

  return {
    // Owners use the shared default Profile until they pick another
    // (ADR 0041).
    defaultProfileId: (ownerId) =>
      (
        selectDefault.get(ownerId) as
          { default_profile_id: string | null } | undefined
      )?.default_profile_id ?? sharedDefault,
    setDefaultProfile: (ownerId, id) => {
      updateDefault.run(id, ownerId);
    },
    profileInUse: (id) => selectProfileUse.get(id) !== undefined,
  };
}

interface OutboxRow {
  id: string;
  session_id: string;
  plugin: string | null;
  actor: Actor;
  kind: Queued["kind"];
  text: string | null;
  notice: string | null;
  turn: number;
  generation: number | null;
  payload: string | null;
  dedupe: string | null;
  created_at: number;
}

function outboxStore(db: DatabaseSync): OutboxStore {
  const insert = db.prepare(
    "insert into session_outbox (id, session_id, plugin, actor, kind, text, notice, turn, generation, payload, dedupe, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict (session_id, plugin, dedupe) do nothing",
  );

  const selectFirst = db.prepare(
    "select * from session_outbox where session_id = ? order by id limit 1",
  );

  const deleteOne = db.prepare("delete from session_outbox where id = ?");

  const deleteAll = db.prepare(
    "delete from session_outbox where session_id = ? returning *",
  );

  const selectSessions = db.prepare(
    "select distinct session_id from session_outbox",
  );

  return {
    add: (message) => {
      const toolResult =
        message.kind === "tool_result"
          ? {
              generation: message.generation,
              payload: JSON.stringify({
                call: message.call,
                result: message.result,
              }),
            }
          : { generation: null, payload: null };

      return (
        insert.run(
          message.id,
          message.sessionId,
          message.plugin,
          message.actor,
          message.kind,
          message.kind === "tool_result" ? null : message.text,
          message.kind === "notice" ? JSON.stringify(message.notice) : null,
          message.kind === "message" ||
            (message.kind === "notice" && message.turn)
            ? 1
            : 0,
          toolResult.generation,
          toolResult.payload,
          message.dedupe,
          message.createdAt,
        ).changes > 0
      );
    },
    first: (sessionId) => {
      const row = selectFirst.get(sessionId) as OutboxRow | undefined;

      return row && queuedOf(row);
    },
    remove: (id) => {
      deleteOne.run(id);
    },
    removeAll: (sessionId) =>
      (deleteAll.all(sessionId) as unknown as OutboxRow[])
        .map(queuedOf)
        .toSorted((a, b) => a.id.localeCompare(b.id)),
    sessions: () =>
      (selectSessions.all() as { session_id: string }[]).map(
        ({ session_id }) => session_id,
      ),
  };
}

function queuedOf(row: OutboxRow): Queued {
  const base = {
    id: row.id,
    sessionId: row.session_id,
    plugin: row.plugin,
    actor: row.actor,
    dedupe: row.dedupe,
    createdAt: row.created_at,
  };

  switch (row.kind) {
    case "message":
    case "context":
      return { ...base, kind: row.kind, text: row.text ?? "" };
    case "notice":
      return {
        ...base,
        kind: row.kind,
        text: row.text ?? "",
        notice: JSON.parse(row.notice ?? "{}") as {
          kind: string;
          data?: unknown;
        },
        turn: row.turn === 1,
      };
    case "tool_result": {
      const { call, result } = JSON.parse(row.payload ?? "{}") as {
        call: string;
        result: ToolResult;
      };

      return {
        ...base,
        kind: row.kind,
        generation: row.generation ?? 0,
        call,
        result,
      };
    }
  }
}
