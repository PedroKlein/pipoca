import type { DatabaseSync } from "node:sqlite";
import type { Clock } from "@pipoca/protocol";
import type { CredentialStore } from "@pipoca/environments";
import { transaction } from "./database";
import { iso, ms, ownerOf, userOf } from "./rows";

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
