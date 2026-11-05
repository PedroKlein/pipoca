import type { ModelRef } from "@pipoca/protocol";
import type { CredentialStore, RunnerCaller } from "../credentials";
import type { EnvironmentStore, StoredEnvironment } from "../environments";

export function memoryEnvironments(): EnvironmentStore {
  let environments: StoredEnvironment[] = [];
  const models = new Map<string, readonly ModelRef[]>();

  return {
    ensureEnvironment: (provider, ownerId, templateId = null) => {
      if (environments.some((each) => each.provider === provider)) {
        return;
      }

      environments.push({
        id: `env-${String(environments.length + 1)}`,
        name: provider,
        provider,
        ownerId,
        createdAt: new Date(0).toISOString(),
        isolation: "process",
        image: null,
        setupScript: "",
        variables: {},
        secrets: {},
        hasKey: false,
        templateId,
      });
    },
    environments: () => environments,
    updateEnvironment: (environment) => {
      environments = environments.map((each) =>
        each.id === environment.id ? environment : each,
      );
    },
    deleteEnvironment: (id) => {
      environments = environments.filter((each) => each.id !== id);
    },
    registeredModels: (provider) =>
      [...models]
        .filter(([key]) => key.startsWith(`${provider}\n`))
        .flatMap(([, refs]) => refs),
    setRegisteredModels: (provider, runner, refs) => {
      models.set(`${provider}\n${runner}`, refs);
    },
  };
}

export function memoryCredentials(): CredentialStore {
  const keys = new Map<string, string>();
  const joinKeys = new Map<string, string>();

  const tokens = new Map<string, { holder: RunnerCaller; lastUsed: string }>();

  const drop = (keep: (holder: RunnerCaller) => boolean) => {
    for (const [hash, { holder }] of tokens) {
      if (!keep(holder)) {
        tokens.delete(hash);
      }
    }
  };

  return {
    setEnvironmentKey: (provider, keyHash) => {
      keys.set(keyHash, provider);
      drop((holder) => !(holder.environment === provider && holder.joined));
    },
    deleteRunnerTokens: (provider, runner) => {
      drop(
        (holder) =>
          !(holder.environment === provider && holder.runner === runner),
      );
    },
    keyEnvironment: (keyHash) => keys.get(keyHash),
    insertJoinKey: (keyHash, ownerId) => {
      joinKeys.set(keyHash, ownerId);
    },
    joinKeyOwner: (keyHash) => joinKeys.get(keyHash),
    claimJoinKey: (keyHash, provider) => {
      joinKeys.delete(keyHash);
      keys.set(keyHash, provider);
    },
    insertRunnerToken: (hash, holder, now) => {
      if (holder.sessionId !== null) {
        drop((each) => each.sessionId !== holder.sessionId);
      }

      tokens.set(hash, { holder, lastUsed: now });
    },
    runnerToken: (hash) => tokens.get(hash),
    useRunnerToken: (hash, now) => {
      const token = tokens.get(hash);

      if (token !== undefined) {
        token.lastUsed = now;
      }
    },
    deleteUnusedRunnerTokens: (usedBefore) => {
      for (const [hash, { holder, lastUsed }] of tokens) {
        if (holder.sessionId === null && lastUsed < usedBefore) {
          tokens.delete(hash);

          drop(
            (each) =>
              !(
                each.sessionId !== null &&
                each.environment === holder.environment &&
                each.runner === holder.runner
              ),
          );
        }
      }
    },
  };
}
