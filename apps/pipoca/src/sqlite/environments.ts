import type { DatabaseSync } from "node:sqlite";
import type { Clock } from "@pipoca/protocol";
import type {
  CredentialStore,
  EnvironmentStore,
  StoredEnvironment,
} from "@pipoca/environments";
import { transaction } from "./database";
import { iso, ms, ownerOf, userOf } from "./rows";
import type { SecretBox } from "./secret-box";

interface EnvironmentRow {
  id: string;
  slug: string;
  name: string;
  owner_user_id: string | null;
  template_id: string | null;
  isolation: string | null;
  image: string | null;
  setup_script: string | null;
  variables: string;
  secrets_sealed: string | null;
  key_hash: string | null;
  created_at: number;
}

const monthMs = 30 * 24 * 60 * 60 * 1000;

export function environmentStore(
  db: DatabaseSync,
  clock: Clock,
  box: SecretBox,
): EnvironmentStore {
  const toEnvironment = (row: EnvironmentRow): StoredEnvironment => ({
    id: row.id,
    name: row.name,
    provider: row.slug,
    ownerId: ownerOf(row.owner_user_id),
    createdAt: iso(row.created_at),
    isolation: row.isolation === "container" ? "container" : "process",
    image: row.image,
    setupScript: row.setup_script ?? "",
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
    "insert into environments (id, slug, name, owner_user_id, template_id, isolation, setup_script, created_at) values (?, ?, ?, ?, ?, ?, ?, ?) on conflict (slug) do nothing",
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

  return {
    ensureEnvironment: (provider, ownerId, templateId = null) => {
      insertEnvironment.run(
        Bun.randomUUIDv7(),
        provider,
        provider,
        userOf(ownerId),
        templateId,
        templateId === null ? "process" : null,
        templateId === null ? "" : null,
        clock.now(),
      );
    },
    environments: () =>
      (selectEnvironments.all() as unknown as EnvironmentRow[]).map(
        toEnvironment,
      ),
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
      const own = environment.templateId === null;

      updateEnvironment.run(
        environment.name,
        own ? environment.isolation : null,
        own ? environment.image : null,
        own ? environment.setupScript : null,
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
  };
}

export function credentialStore(
  db: DatabaseSync,
  clock: Clock,
): CredentialStore {
  const updateKey = db.prepare(
    "update environments set key_hash = ? where slug = ?",
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

  const deleteUnusedTokens = db.prepare(
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

  return {
    setEnvironmentKey: (provider, keyHash) => {
      transaction(db, () => {
        updateKey.run(keyHash, provider);
        deleteJoinedTokens.run(provider);
      });
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
    insertRunnerToken: (tokenHash, holder, now) => {
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
    useRunnerToken: (tokenHash, now) => {
      updateLastUsed.run(ms(now), tokenHash);
    },
    deleteUnusedRunnerTokens: (usedBefore) => {
      transaction(db, () => {
        deleteUnusedTokens.run(ms(usedBefore));
        deleteOrphanedSessionTokens.run();
      });
    },
    deleteRunnerTokens: (provider, runner) => {
      deleteRunnerTokens.run(provider, runner);
    },
    runnerToken: (tokenHash) => {
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
          holder: {
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
