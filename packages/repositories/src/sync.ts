import type { Log, RepositorySource } from "@pipoca/protocol";
import { type Clone, withClone } from "./fetch";

// Something made from a repository that follows it, such as a Profile or an
// Environment template (ADR 0063).
interface Follower {
  readonly id: string;
  readonly source: RepositorySource | null;
}

// Brings each follower whose repository moved on up to the latest commit,
// cloning each repository once. A follower that fails to update is logged
// and the others still are.
export async function syncFollowers<T extends Follower>(
  followers: readonly T[],
  options: {
    // What the followers are, such as "profile", for the log.
    readonly kind: string;
    // Only the followers of this repository, when given.
    readonly url?: string | undefined;
    readonly log: Log;
    readonly update: (
      follower: T,
      clone: Clone,
      source: RepositorySource,
    ) => void;
    // Called after each repository's followers were updated.
    readonly updated?: () => void;
  },
): Promise<void> {
  const { kind, log } = options;

  const synced = followers.filter(
    ({ source }) =>
      source !== null &&
      (options.url === undefined || source.url === options.url),
  );

  if (synced.length === 0) {
    return;
  }

  const urls = [...new Set(synced.map(({ source }) => source?.url ?? ""))];
  let changed = 0;
  let failed = 0;

  log(`${kind}s syncing`, {
    [`${kind}s`]: synced.length,
    repositories: urls.length,
  });

  for (const url of urls) {
    await withClone(url, (clone) => {
      for (const follower of synced) {
        const { source } = follower;
        if (source?.url !== url || source.commit === clone.commit) {
          continue;
        }

        try {
          options.update(follower, clone, { ...source, commit: clone.commit });
          changed++;

          log(`${kind} synced`, {
            [`${kind}Id`]: follower.id,
            commit: clone.commit,
          });
        } catch (error) {
          failed++;

          log(`${kind} sync failed`, {
            [`${kind}Id`]: follower.id,
            error: String(error),
          });
        }
      }

      options.updated?.();
    }).catch((error: unknown) => {
      failed++;
      log(`${kind} sync failed`, { url, error: String(error) });
    });
  }

  log(`${kind}s synced`, { checked: synced.length, changed, failed });
}
