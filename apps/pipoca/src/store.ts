import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync, SQLInputValue, StatementSync } from "node:sqlite";
import type {
  Invite,
  SessionAccess,
  SessionStatus,
  ThinkingLevel,
  Voice,
  Workspace,
  WorkspaceRemoval,
} from "@pipoca/protocol";
import type { PluginStore, ServerPlugin } from "@pipoca/plugins";
import {
  defaultProfileId as sharedDefault,
  type ProfileFolders,
  type ProfileStore,
} from "@pipoca/profiles";
import {
  type Clock,
  owner,
  type SessionStore,
  type StoredEnvironment,
  type StoredSession,
  systemClock,
} from "@pipoca/sessions";
import type { AuthStore, User } from "./auth";
import { openDatabase, resetPlugin, transaction } from "./database";
import { kernelSchema } from "./schema";
import { fileSecretKey, SecretBox } from "./secret-box";

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
  acts_as: string | null;
}

interface EnvironmentRow {
  id: string;
  slug: string;
  name: string;
  owner_user_id: string | null;
  template_id: string | null;
  isolation: string;
  image: string | null;
  setup_script: string;
  variables: string;
  secrets_sealed: string | null;
  key_hash: string | null;
  created_at: number;
}

interface VoiceRow {
  kind: Voice["kind"];
  person: string;
  text: string | null;
  quote_from: string | null;
  quote_text: string | null;
  at: number;
}

// The wire keeps ISO times and named owners; the tables keep milliseconds
// and a user id, or NULL for the team (ADR 0064).
const teamOwner = "team";

function iso(at: number): string {
  return new Date(at).toISOString();
}

function isoOrNull(at: number | null): string | null {
  return at === null ? null : iso(at);
}

function ms(at: string): number {
  return Date.parse(at);
}

function msOrNull(at: string | null): number | null {
  return at === null ? null : ms(at);
}

function ownerOf(userId: string | null): string {
  return userId ?? teamOwner;
}

function userOf(ownerId: string): string | null {
  return ownerId === teamOwner || ownerId === owner ? null : ownerId;
}

const monthMs = 30 * 24 * 60 * 60 * 1000;

export function openStore(
  path: string,
  secretKey?: Buffer,
  profiles?: ProfileFolders,
  clock: Clock = systemClock,
  plugins: readonly Pick<ServerPlugin, "name" | "schema">[] = [],
): SessionStore &
  ProfileStore & {
    auth: AuthStore;
    check: () => void;
    close: () => void;
    plugin: (name: string) => PluginStore;
    // Why a plugin's tables can't be used, if they can't.
    pluginFailure: (name: string) => string | undefined;
    // Drops a plugin's tables and makes them again, or says why it couldn't.
    resetPlugin: (name: string) => string | undefined;
  } {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }

  const box = new SecretBox(
    secretKey ??
      (path === ":memory:" ? randomBytes(32) : fileSecretKey(`${path}.key`)),
  );

  const { db, failures } = openDatabase(
    path,
    kernelSchema,
    plugins.flatMap(({ name, schema }) =>
      schema === undefined ? [] : [{ owner: name, ...schema }],
    ),
    clock.now,
  );

  // A key that doesn't open what is sealed stops the start.
  const sealed = db
    .prepare(
      "select id, secrets_sealed from environments where secrets_sealed is not null limit 1",
    )
    .get() as { id: string; secrets_sealed: string } | undefined;

  if (sealed !== undefined) {
    box.open(sealed.secrets_sealed, sealed.id);
  }

  const toSession = (row: SessionRow): StoredSession => ({
    id: row.id,
    environmentId: row.environment_id,
    ownerId: owner,
    owner:
      row.plugin === null || row.plugin_key === null
        ? null
        : { plugin: row.plugin, key: row.plugin_key },
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
    actsAs: row.acts_as,
  });

  const sessionRows = (statement: StatementSync, ...params: SQLInputValue[]) =>
    (statement.all(...params) as unknown as SessionRow[]).map(toSession);

  const insertSession = db.prepare(
    "insert into sessions (id, environment_id, plugin, plugin_key, runner, profile_id, workspace, model_provider, model_id, system_prompt, first_message, thinking, title, status, generation, created_at, interrupted_at, error, archived_at, workspace_removal, workspace_kept_reason, started_by, acts_as) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );

  const updateSession = db.prepare(
    "update sessions set runner = ?, workspace = ?, status = ?, generation = ?, interrupted_at = ?, error = ?, archived_at = ?, workspace_removal = ?, workspace_kept_reason = ? where id = ?",
  );

  const selectAnySession = db.prepare("select 1 from sessions limit 1");

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
    "select kind, person, text, quote_from, quote_text, at from session_messages where session_id = ? order by seq",
  );

  const insertVoice = db.prepare(
    "insert into session_messages (session_id, seq, kind, person, text, quote_from, quote_text, at) values (?1, (select coalesce(max(seq), 0) + 1 from session_messages where session_id = ?1), ?2, ?3, ?4, ?5, ?6, ?7)",
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

  const selectFirstUser = db.prepare(
    "select id from users order by created_at limit 1",
  );

  const firstUser = (): string | null =>
    (selectFirstUser.get() as { id: string } | undefined)?.id ?? null;

  // Environments made before anyone signed up, such as the server's own
  // runner's, are the first person's (ADR 0049).
  const environmentOwner = (ownerId: string | undefined): string | null =>
    ownerId === undefined || ownerId === owner ? firstUser() : userOf(ownerId);

  const toEnvironment = (
    row: EnvironmentRow,
    nobody: boolean,
  ): StoredEnvironment => ({
    id: row.id,
    name: row.name,
    provider: row.slug,
    ownerId:
      row.owner_user_id === null && nobody ? owner : ownerOf(row.owner_user_id),
    createdAt: iso(row.created_at),
    isolation: row.isolation === "container" ? "container" : "process",
    image: row.image,
    setupScript: row.setup_script,
    variables: JSON.parse(row.variables) as Record<string, string>,
    secrets:
      row.secrets_sealed === null
        ? {}
        : (JSON.parse(box.open(row.secrets_sealed, row.id)) as Record<
            string,
            string
          >),
    hasKey: row.key_hash !== null,
    templateId: row.template_id,
  });

  const insertEnvironment = db.prepare(
    "insert into environments (id, slug, name, owner_user_id, template_id, created_at) values (?, ?, ?, ?, ?, ?) on conflict (slug) do nothing",
  );

  const updateEnvironment = db.prepare(
    "update environments set name = ?, isolation = ?, image = ?, setup_script = ?, variables = ?, secrets_sealed = ? where id = ?",
  );

  const deleteEnvironment = db.prepare("delete from environments where id = ?");

  const selectEnvironments = db.prepare(
    "select * from environments order by created_at, name",
  );

  const selectRunnerModels = db.prepare(
    "select runner_models.provider, model_id from runner_models join environments on environments.id = environment_id where slug = ? order by reported_at, runner, position",
  );

  const deleteRunnerModels = db.prepare(
    "delete from runner_models where environment_id = (select id from environments where slug = ?) and runner = ?",
  );

  const insertRunnerModel = db.prepare(
    "insert into runner_models (environment_id, runner, position, provider, model_id, reported_at) values ((select id from environments where slug = ?), ?, ?, ?, ?, ?)",
  );

  // Runners started on demand each have a name of their own, so what the
  // ones gone for a month reported is dropped.
  const deleteOldRunnerModels = db.prepare(
    "delete from runner_models where reported_at < ?",
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

  const updateDefault = db.prepare(
    "update users set default_profile_id = ? where id = ?",
  );

  const selectProfileUse = db.prepare(
    "select 1 from sessions where profile_id = ? and archived_at is null limit 1",
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

  const pluginStores = new Map<string, PluginStore>();

  return {
    insert: (s) => {
      insertSession.run(
        s.id,
        s.environmentId,
        s.owner?.plugin ?? null,
        s.owner?.key ?? null,
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
        s.actsAs,
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
    list: ({ includeArchived, owner: ownedBy }) =>
      ownedBy
        ? sessionRows(
            includeArchived
              ? selectOwnedSessions
              : selectUnarchivedOwnedSessions,
            ownedBy.plugin,
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
        person: row.person,
        at: iso(row.at),
        ...(row.text !== null && { text: row.text }),
        ...(row.quote_from !== null &&
          row.quote_text !== null && {
            quote: { from: row.quote_from, text: row.quote_text },
          }),
      })),
    addVoice: (id, voice) => {
      insertVoice.run(
        id,
        voice.kind,
        voice.person,
        voice.text ?? null,
        voice.quote?.from ?? null,
        voice.quote?.text ?? null,
        ms(voice.at),
      );
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
    ensureEnvironment: (provider, ownerId, templateId = null) => {
      insertEnvironment.run(
        Bun.randomUUIDv7(),
        provider,
        provider,
        environmentOwner(ownerId),
        templateId,
        clock.now(),
      );
    },
    environments: () => {
      const nobody = firstUser() === null;

      return (selectEnvironments.all() as unknown as EnvironmentRow[]).map(
        (row) => toEnvironment(row, nobody),
      );
    },
    registeredModels: (provider) =>
      (
        selectRunnerModels.all(provider) as {
          provider: string;
          model_id: string;
        }[]
      ).map((row) => ({ provider: row.provider, id: row.model_id })),
    setRegisteredModels: (provider, runner, models) => {
      const now = clock.now();

      transaction(db, () => {
        deleteRunnerModels.run(provider, runner);

        models.forEach((model, position) => {
          insertRunnerModel.run(
            provider,
            runner,
            position,
            model.provider,
            model.id,
            now,
          );
        });

        deleteOldRunnerModels.run(now - monthMs);
      });
    },
    updateEnvironment: (environment) => {
      updateEnvironment.run(
        environment.name,
        environment.isolation,
        environment.image,
        environment.setupScript,
        JSON.stringify(environment.variables),
        Object.keys(environment.secrets).length === 0
          ? null
          : box.seal(JSON.stringify(environment.secrets), environment.id),
        environment.id,
      );
    },
    deleteEnvironment: (id) => {
      deleteEnvironment.run(id);
    },
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
    check: () => {
      selectAnySession.get();
    },
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
    setDefaultProfile: (ownerId, id) => {
      updateDefault.run(id, ownerId);
    },
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
    profileInUse: (id) => selectProfileUse.get(id) !== undefined,
    auth: authStore(db, clock),
    plugin: (name) => {
      const failure = failures.get(name);

      if (failure !== undefined) {
        throw new Error(failure);
      }

      const found = pluginStores.get(name) ?? pluginStore(db, name, box);
      pluginStores.set(name, found);

      return found;
    },
    pluginFailure: (name) => failures.get(name),
    resetPlugin: (name) => {
      const declared = plugins.find((each) => each.name === name)?.schema;

      const failure =
        declared === undefined
          ? undefined
          : resetPlugin(db, { owner: name, ...declared }, clock.now());

      if (failure === undefined) {
        failures.delete(name);
      } else {
        failures.set(name, failure);
      }

      return failure;
    },
    close: () => {
      db.close();
    },
  };
}

interface UserRow {
  readonly id: string;
  readonly name: string;
  readonly admin: number;
}

function userOfRow(row: UserRow | undefined): User | undefined {
  return row && { id: row.id, name: row.name, admin: row.admin === 1 };
}

interface InviteRow {
  readonly id: string;
  readonly email: string | null;
  readonly admin: number;
  readonly created_by: string | null;
  readonly created_at: number;
  readonly expires_at: number;
  readonly uses: number;
}

function inviteOf(row: InviteRow): Invite {
  return {
    id: row.id,
    email: row.email,
    admin: row.admin === 1,
    createdBy: row.created_by ?? "",
    createdAt: iso(row.created_at),
    expiresAt: iso(row.expires_at),
    uses: row.uses,
  };
}

function authStore(db: DatabaseSync, clock: Clock): AuthStore {
  const countUsers = db.prepare("select count(*) as n from users");

  const selectUser = db.prepare(
    "select id, name, password_hash, created_at, admin from users where name = ?",
  );

  const selectUserById = db.prepare(
    "select id, name, admin from users where id = ?",
  );

  const selectUsers = db.prepare(
    "select id, name, admin from users order by created_at",
  );

  const insertUser = db.prepare(
    "insert into users (id, name, password_hash, created_at, admin) values (?, ?, ?, ?, ?)",
  );

  const giveEnvironments = db.prepare(
    "update environments set owner_user_id = ? where owner_user_id is null",
  );

  const updateAdmin = db.prepare("update users set admin = ? where id = ?");

  const selectPeople = db.prepare(
    "select id, name, admin, setup_finished_at, last_active_at from users order by created_at",
  );

  const updateLastActive = db.prepare(
    "update users set last_active_at = ? where id = ?",
  );

  const insertBrowserSession = db.prepare(
    "insert into browser_sessions (token_hash, user_id, created_at, expires_at) values (?, ?, ?, ?)",
  );

  const selectBrowserSessionUser = db.prepare(
    "select users.id, users.name, users.admin from browser_sessions join users on users.id = browser_sessions.user_id where token_hash = ? and expires_at > ?",
  );

  const deleteBrowserSession = db.prepare(
    "delete from browser_sessions where token_hash = ?",
  );

  const deleteExpired = db.prepare(
    "delete from browser_sessions where expires_at <= ?",
  );

  const updateKey = db.prepare(
    "update environments set key_hash = ? where slug = ?",
  );

  const insertInvite = db.prepare(
    "insert into invites (id, token_hash, email, admin, created_by, created_at, expires_at) values (?, ?, ?, ?, ?, ?, ?)",
  );

  const inviteColumns =
    "select id, email, admin, created_by, created_at, expires_at, uses from invites";

  // An invite with an email is used up once someone joins with it.
  const selectInvites = db.prepare(
    `${inviteColumns} where expires_at > ? and (email is null or uses = 0) order by created_at`,
  );

  const selectInviteByToken = db.prepare(
    `${inviteColumns} where token_hash = ? and expires_at > ? and (email is null or uses = 0)`,
  );

  const selectInviteByEmail = db.prepare(
    `${inviteColumns} where email = ? and expires_at > ? and uses = 0 order by created_at desc`,
  );

  const deleteInvite = db.prepare("delete from invites where id = ?");

  const useInvite = db.prepare(
    "update invites set uses = uses + 1 where id = ?",
  );

  const insertJoinKey = db.prepare(
    "insert into environment_join_keys (key_hash, owner_user_id, created_at) values (?, ?, ?)",
  );

  const selectJoinKey = db.prepare(
    "select owner_user_id from environment_join_keys where key_hash = ?",
  );

  const deleteJoinKey = db.prepare(
    "delete from environment_join_keys where key_hash = ?",
  );

  const selectKeyEnvironment = db.prepare(
    "select slug from environments where key_hash = ?",
  );

  const insertAgentToken = db.prepare(
    "insert into runner_tokens (token_hash, environment_id, runner, session_id, joined, created_at, last_used_at) values (?1, (select id from environments where slug = ?2), ?3, ?4, ?5, ?6, ?6)",
  );

  const selectAgentToken = db.prepare(
    "select slug, runner, session_id, joined, last_used_at from runner_tokens join environments on environments.id = environment_id where token_hash = ?",
  );

  const updateLastUsed = db.prepare(
    "update runner_tokens set last_used_at = ? where token_hash = ?",
  );

  const deleteJoinedTokens = db.prepare(
    "delete from runner_tokens where environment_id = (select id from environments where slug = ?) and joined = 1",
  );

  const deleteRunnerTokens = db.prepare(
    "delete from runner_tokens where environment_id = (select id from environments where slug = ?) and runner = ?",
  );

  const deleteSessionTokens = db.prepare(
    "delete from runner_tokens where session_id = ?",
  );

  const deleteUnusedRunnerTokens = db.prepare(
    "delete from runner_tokens where session_id is null and last_used_at < ?",
  );

  const deleteOrphanedSessionTokens = db.prepare(`
    delete from runner_tokens where session_id is not null and not exists (
      select 1 from runner_tokens runners
      where runners.session_id is null
        and runners.environment_id = runner_tokens.environment_id
        and runners.runner = runner_tokens.runner
    )
  `);

  const insertMcpToken = db.prepare(
    "insert into access_tokens (id, token_hash, user_id, name, created_at) values (?, ?, ?, ?, ?)",
  );

  const selectPinnedAt = db.prepare("select pinned_at from users where id = ?");

  const selectPinnedPages = db.prepare(
    "select page from user_pinned_pages where user_id = ? order by position",
  );

  const updatePinnedAt = db.prepare(
    "update users set pinned_at = ? where id = ?",
  );

  const deletePinnedPages = db.prepare(
    "delete from user_pinned_pages where user_id = ?",
  );

  const insertPinnedPage = db.prepare(
    "insert into user_pinned_pages (user_id, position, page) values (?, ?, ?)",
  );

  const selectSetupFinished = db.prepare(
    "select setup_finished_at from users where id = ?",
  );

  const selectDismissed = db.prepare(
    "select step from user_dismissed_steps where user_id = ? order by rowid",
  );

  const updateSetupFinished = db.prepare(
    "update users set setup_finished_at = case when ?1 then coalesce(setup_finished_at, ?2) end where id = ?3",
  );

  const deleteDismissed = db.prepare(
    "delete from user_dismissed_steps where user_id = ?",
  );

  const insertDismissed = db.prepare(
    "insert or ignore into user_dismissed_steps (user_id, step) values (?, ?)",
  );

  const selectMcpTokens = db.prepare(
    "select id, name, created_at from access_tokens where user_id = ? order by created_at",
  );

  const selectMcpTokenUser = db.prepare(
    "select users.id, users.name, users.admin from access_tokens join users on users.id = access_tokens.user_id where token_hash = ?",
  );

  const deleteMcpToken = db.prepare(
    "delete from access_tokens where id = ? and user_id = ?",
  );

  return {
    userCount: () => (countUsers.get() as { n: number }).n,
    userByName: (name) => {
      const row = selectUser.get(name) as
        | {
            id: string;
            name: string;
            password_hash: string | null;
            created_at: number;
            admin: number;
          }
        | undefined;

      return (
        row && {
          id: row.id,
          name: row.name,
          admin: row.admin === 1,
          passwordHash: row.password_hash ?? "",
          createdAt: iso(row.created_at),
        }
      );
    },
    userById: (id) => userOfRow(selectUserById.get(id) as UserRow | undefined),
    users: () =>
      (selectUsers.all() as unknown as UserRow[]).flatMap(
        (row) => userOfRow(row) ?? [],
      ),
    insertUser: (user) => {
      transaction(db, () => {
        insertUser.run(
          user.id,
          user.name,
          user.passwordHash === "" ? null : user.passwordHash,
          ms(user.createdAt),
          user.admin ? 1 : 0,
        );

        if ((countUsers.get() as { n: number }).n === 1) {
          giveEnvironments.run(user.id);
        }
      });
    },
    setAdmin: (id, admin) => {
      updateAdmin.run(admin ? 1 : 0, id);
    },
    people: () =>
      (
        selectPeople.all() as unknown as (UserRow & {
          readonly setup_finished_at: number | null;
          readonly last_active_at: number | null;
        })[]
      ).map((row) => ({
        id: row.id,
        name: row.name,
        admin: row.admin === 1,
        settingUp: row.setup_finished_at === null,
        lastActive: isoOrNull(row.last_active_at),
      })),
    setLastActive: (id, at) => {
      updateLastActive.run(ms(at), id);
    },
    insertBrowserSession: (tokenHash, userId, expiresAt) => {
      const now = clock.now();
      deleteExpired.run(now);
      insertBrowserSession.run(tokenHash, userId, now, ms(expiresAt));
    },
    browserSessionUser: (tokenHash, now) =>
      userOfRow(
        selectBrowserSessionUser.get(tokenHash, ms(now)) as UserRow | undefined,
      ),
    deleteBrowserSession: (tokenHash) => {
      deleteBrowserSession.run(tokenHash);
    },
    setEnvironmentKey: (provider, keyHash) => {
      transaction(db, () => {
        updateKey.run(keyHash, provider);
        deleteJoinedTokens.run(provider);
      });
    },
    insertInvite: (invite, tokenHash) => {
      insertInvite.run(
        invite.id,
        tokenHash,
        invite.email,
        invite.admin ? 1 : 0,
        invite.createdBy,
        ms(invite.createdAt),
        ms(invite.expiresAt),
      );
    },
    invites: (now) =>
      (selectInvites.all(ms(now)) as unknown as InviteRow[]).map(inviteOf),
    inviteByToken: (tokenHash, now) => {
      const row = selectInviteByToken.get(tokenHash, ms(now)) as
        InviteRow | undefined;

      return row && inviteOf(row);
    },
    inviteByEmail: (email, now) => {
      const row = selectInviteByEmail.get(email, ms(now)) as
        InviteRow | undefined;

      return row && inviteOf(row);
    },
    deleteInvite: (id) => deleteInvite.run(id).changes > 0,
    useInvite: (id) => {
      useInvite.run(id);
    },
    insertJoinKey: (keyHash, ownerId) => {
      insertJoinKey.run(keyHash, userOf(ownerId), clock.now());
    },
    joinKeyOwner: (keyHash) => {
      const row = selectJoinKey.get(keyHash) as
        { owner_user_id: string | null } | undefined;

      return row && ownerOf(row.owner_user_id);
    },
    claimJoinKey: (keyHash, provider) => {
      transaction(db, () => {
        deleteJoinKey.run(keyHash);
        updateKey.run(keyHash, provider);
      });
    },
    keyEnvironment: (keyHash) =>
      (selectKeyEnvironment.get(keyHash) as { slug: string } | undefined)?.slug,
    insertAgentToken: (tokenHash, holder, now) => {
      transaction(db, () => {
        if (holder.sessionId !== null) {
          deleteSessionTokens.run(holder.sessionId);
        }

        insertAgentToken.run(
          tokenHash,
          holder.environment,
          holder.runner,
          holder.sessionId,
          holder.joined ? 1 : 0,
          ms(now),
        );
      });
    },
    useAgentToken: (tokenHash, now) => {
      updateLastUsed.run(ms(now), tokenHash);
    },
    deleteUnusedAgentTokens: (usedBefore) => {
      transaction(db, () => {
        deleteUnusedRunnerTokens.run(ms(usedBefore));
        deleteOrphanedSessionTokens.run();
      });
    },
    deleteRunnerTokens: (provider, runner) => {
      deleteRunnerTokens.run(provider, runner);
    },
    insertMcpToken: (token, tokenHash) => {
      insertMcpToken.run(
        token.id,
        tokenHash,
        token.userId,
        token.name,
        ms(token.createdAt),
      );
    },
    mcpTokens: (userId) =>
      (
        selectMcpTokens.all(userId) as {
          id: string;
          name: string;
          created_at: number;
        }[]
      ).map((row) => ({
        id: row.id,
        userId,
        name: row.name,
        createdAt: iso(row.created_at),
      })),
    mcpTokenUser: (tokenHash) =>
      userOfRow(selectMcpTokenUser.get(tokenHash) as UserRow | undefined),
    deleteMcpToken: (id, userId) =>
      Number(deleteMcpToken.run(id, userId).changes) > 0,
    pinnedPages: (userId) => {
      const row = selectPinnedAt.get(userId) as
        { pinned_at: number | null } | undefined;

      return row === undefined || row.pinned_at === null
        ? null
        : (selectPinnedPages.all(userId) as { page: string }[]).map(
            ({ page }) => page,
          );
    },
    setPinnedPages: (userId, pages) => {
      transaction(db, () => {
        updatePinnedAt.run(pages === null ? null : clock.now(), userId);
        deletePinnedPages.run(userId);

        pages?.forEach((page, position) => {
          insertPinnedPage.run(userId, position, page);
        });
      });
    },
    setup: (userId) => {
      const row = selectSetupFinished.get(userId) as
        { setup_finished_at: number | null } | undefined;

      return {
        finished: row !== undefined && row.setup_finished_at !== null,
        dismissed: (selectDismissed.all(userId) as { step: string }[]).map(
          ({ step }) => step,
        ),
      };
    },
    setSetup: (userId, state) => {
      transaction(db, () => {
        updateSetupFinished.run(state.finished ? 1 : 0, clock.now(), userId);
        deleteDismissed.run(userId);

        for (const step of state.dismissed) {
          insertDismissed.run(userId, step);
        }
      });
    },
    agentToken: (tokenHash) => {
      const row = selectAgentToken.get(tokenHash) as
        | {
            slug: string;
            runner: string;
            session_id: string | null;
            joined: number;
            last_used_at: number;
          }
        | undefined;

      return (
        row && {
          agent: {
            environment: row.slug,
            runner: row.runner,
            sessionId: row.session_id,
            joined: row.joined === 1,
          },
          lastUsed: iso(row.last_used_at),
        }
      );
    },
  };
}

// Plugins are trusted in v1 (ADR 0022), so their statements reach any table.
function pluginStore(
  db: DatabaseSync,
  name: string,
  box: SecretBox,
): PluginStore {
  const statements = new Map<string, StatementSync>();

  const prepared = (sql: string): StatementSync => {
    const found = statements.get(sql) ?? db.prepare(sql);
    statements.set(sql, found);

    return found;
  };

  return {
    all: (sql, ...params) => prepared(sql).all(...params),
    run: (sql, ...params) => {
      prepared(sql).run(...params);
    },
    transaction: (fn) => transaction(db, fn),
    seal: (text, context) => box.seal(text, `plugin:${name}:${context}`),
    open: (sealed, context) => box.open(sealed, `plugin:${name}:${context}`),
  };
}
