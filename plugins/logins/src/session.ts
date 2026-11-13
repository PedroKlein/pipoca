import type {
  AuthOperationOptions,
  Credential,
  CredentialStore,
} from "@earendil-works/pi-ai";
import {
  defineSession,
  isHttpError,
  type McpLoginState,
  type McpLoginStore,
  type TypedClient,
} from "@pipoca/plugins";
import { type Log, noticeType } from "@pipoca/protocol";
import { logins } from "../plugin";
import { type Lease, mcpKey, type Release } from "./model";

const teamWorkLogins =
  "Team work runs on the team's keys and keeps no personal logins. An admin adds a key in Team setup, under Credentials.";

// The server answers busy after waiting a while for another runner's
// refresh, so a few asks cover a slow one.
const busyAsks = 5;

interface ProxyProviders {
  readonly providers: readonly {
    readonly provider: string;
    readonly baseUrl: string;
  }[];
  readonly token?: string;
}

// The Session's model and MCP logins are its owner's on the server, so
// /login, /mcp login and token refreshes reach every runner (ADR 0045). A
// team Session reaches the team's providers through the server's proxy,
// with a token of its own in place of the key (ADR 0066).
export const session = defineSession(logins, (s) => {
  s.extension(async (pi) => {
    const proxy = await s.api
      .get<ProxyProviders>("proxy")
      .catch((error: unknown) => {
        s.log("team providers not set up", { error: String(error) });

        return undefined;
      });

    for (const { provider, baseUrl } of proxy?.providers ?? []) {
      pi.registerProvider(provider, { baseUrl, apiKey: proxy?.token ?? "" });
    }

    if (proxy?.token !== undefined) {
      for (const name of ["login", "logout"]) {
        pi.registerCommand(name, {
          description: "Team work runs on the team's keys",
          handler: async () => {
            pi.sendMessage({
              customType: noticeType,
              content: teamWorkLogins,
              display: true,
              details: { plugin: logins.id, kind: "team-login", data: {} },
            });

            return Promise.resolve();
          },
        });
      }
    }
  });

  s.provide.modelCredentials(async () => ({
    models: modelLogins(leased<Credential>(s.api, "credentials")),
    mcp: await mcpLogins(leased<McpLoginState>(s.api, "mcp"), s.log),
  }));
});

interface Leased<T> {
  readonly keys: (
    options?: AuthOperationOptions,
  ) => Promise<readonly { readonly key: string; readonly type: string }[]>;
  readonly values: (
    options?: AuthOperationOptions,
  ) => Promise<Readonly<Record<string, T>>>;
  // Runs fn while the Session holds the login's lease, and writes back what
  // it returns as next. The lease is let go even when fn throws, so the next
  // runner doesn't wait for it to lapse.
  readonly withLease: <R>(
    key: string,
    fn: (current: T | undefined) => Promise<{
      readonly result: R;
      readonly next?: T | null;
    }>,
    options?: AuthOperationOptions,
  ) => Promise<R>;
}

// One kind of login on the server, through the Session's requests to it.
function leased<T>(api: TypedClient, kind: string): Leased<T> {
  const signal = (options?: AuthOperationOptions) =>
    options?.signal === undefined ? {} : { signal: options.signal };

  const pathOf = (key: string): string => `${kind}/${encodeURIComponent(key)}`;

  const lock = async (
    key: string,
    options?: AuthOperationOptions,
  ): Promise<Lease<T>> => {
    for (let ask = 1; ; ask++) {
      try {
        return await api.post<Lease<T>>(
          `${pathOf(key)}/lock`,
          undefined,
          signal(options),
        );
      } catch (error) {
        const busy =
          isHttpError(error) && error.status === 409 && error.code === "busy";

        if (!busy || ask === busyAsks) {
          throw error;
        }
      }
    }
  };

  const release = async (key: string, body: Release<T>): Promise<void> => {
    await api.post(`${pathOf(key)}/release`, body);
  };

  return {
    keys: async (options) => api.get(kind, undefined, signal(options)),
    values: async (options) =>
      api.get(`${kind}/values`, undefined, signal(options)),
    withLease: async (key, fn, options) => {
      const { lease, value } = await lock(key, options);

      let outcome: Awaited<ReturnType<typeof fn>>;
      try {
        outcome = await fn(value ?? undefined);
      } catch (error) {
        await release(key, { lease }).catch(() => undefined);
        throw error;
      }

      await release(key, {
        lease,
        ...(outcome.next !== undefined && { value: outcome.next }),
      });

      return outcome.result;
    },
  };
}

function modelLogins(models: Leased<Credential>): CredentialStore {
  // Pi checks every provider at once, so the reads that start together share
  // one request for all of the owner's logins.
  let reading: Promise<Readonly<Record<string, Credential>>> | undefined;

  return {
    read: async (providerId, options) => {
      reading ??= models.values(options).finally(() => {
        reading = undefined;
      });

      return (await reading)[providerId];
    },
    list: async (options) =>
      (await models.keys(options)).map(({ key, type }) => ({
        providerId: key,
        type: type as Credential["type"],
      })),
    modify: async (providerId, fn, options) =>
      models.withLease(
        providerId,
        async (current) => {
          const next = await fn(current);

          return { result: next ?? current, ...(next && { next }) };
        },
        options,
      ),
    delete: async (providerId, options) => {
      await models.withLease(
        providerId,
        async () => Promise.resolve({ result: undefined, next: null }),
        options,
      );
    },
  };
}

// Pi reads and writes MCP sign-ins without waiting, so the Session keeps the
// owner's in memory, loaded when it starts, and writes each change back in
// order. A token refresh holds the server's lease, reading the newest state
// first, so two runners don't spend one refresh token.
async function mcpLogins(
  mcp: Leased<McpLoginState>,
  log: Log,
): Promise<McpLoginStore> {
  const states = new Map(Object.entries(await mcp.values()));
  const refreshing = new Set<string>();
  let writes = Promise.resolve();

  const writeBack = (key: string, next: McpLoginState | null): void => {
    writes = writes
      .then(async () =>
        mcp.withLease(key, async () =>
          Promise.resolve({ result: undefined, next }),
        ),
      )
      .catch((error: unknown) => {
        log("MCP login not saved", { server: key, error: String(error) });
      });
  };

  return {
    forServer: (name, serverUrl) => {
      const key = mcpKey(name, serverUrl);

      return {
        load: () => states.get(key),
        save: (state) => {
          states.set(key, state);

          if (!refreshing.has(key)) {
            writeBack(key, state);
          }
        },
        withRefreshLock: async (fn) =>
          mcp.withLease(key, async (current) => {
            if (current === undefined) {
              states.delete(key);
            } else {
              states.set(key, current);
            }

            refreshing.add(key);
            try {
              const result = await fn();
              const next = states.get(key);

              return {
                result,
                ...(next !== current && { next: next ?? null }),
              };
            } finally {
              refreshing.delete(key);
            }
          }),
      };
    },
    tokens: (name, serverUrl) => states.get(mcpKey(name, serverUrl))?.tokens,
    remove: (name, serverUrl) => {
      const key = mcpKey(name, serverUrl);
      const removed = states.delete(key);

      if (removed) {
        writeBack(key, null);
      }

      return removed;
    },
  };
}
