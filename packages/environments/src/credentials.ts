import type { Joined } from "@pipoca/protocol";
import { type Clock, systemClock } from "@pipoca/protocol";
import { secretToken, tokenHash } from "@pipoca/people";

// Who sent a call to /agent/: a runner, or one of its Sessions.
export interface RunnerCaller {
  // The provider name of the runner's Environment.
  readonly environment: string;
  readonly runner: string;
  readonly sessionId: string | null;
  // Joined with the Environment's key, so a new key lets it go. Runners a
  // plugin or the server starts got their token without one.
  readonly joined: boolean;
}

export interface CredentialStore {
  // Also lets go of every runner that joined with the earlier key.
  readonly setEnvironmentKey: (provider: string, keyHash: string) => void;
  // A runner's own token and its Sessions' tokens.
  readonly deleteRunnerTokens: (provider: string, runner: string) => void;
  readonly keyEnvironment: (keyHash: string) => string | undefined;
  // A join key belongs to no Environment until a runner joins with it, and
  // then becomes the key of the Environment made for that runner (ADR 0040).
  readonly insertJoinKey: (keyHash: string, ownerId: string) => void;
  // The person whose Environment a runner joining with the key gets.
  readonly joinKeyOwner: (keyHash: string) => string | undefined;
  readonly claimJoinKey: (keyHash: string, provider: string) => void;
  // A Session holds one token, for its current attempt.
  readonly insertRunnerToken: (
    tokenHash: string,
    holder: RunnerCaller,
    now: string,
  ) => void;
  readonly runnerToken: (
    tokenHash: string,
  ) => { readonly holder: RunnerCaller; readonly lastUsed: string } | undefined;
  readonly useRunnerToken: (tokenHash: string, now: string) => void;
  // Runner tokens last used before the time, and their Sessions' tokens.
  readonly deleteUnusedRunnerTokens: (usedBefore: string) => void;
}

// How stale a token's last use may get before it is written again, so a
// poll seldom writes to the database.
const lastUsedStepMs = 60 * 60_000;

// The keys runners join an Environment with, and the tokens runners and
// their Sessions call the server with.
export class RunnerCredentials {
  readonly #store: CredentialStore;
  readonly #clock: Clock;
  // How long a runner token lasts unused.
  readonly #tokenDays: () => number;
  readonly #ownTokens = new Map<string, RunnerCaller>();

  constructor(
    store: CredentialStore,
    options: {
      readonly clock?: Clock;
      readonly runnerTokenDays?: () => number;
    } = {},
  ) {
    this.#store = store;
    this.#clock = options.clock ?? systemClock;
    this.#tokenDays = options.runnerTokenDays ?? (() => 30);
  }

  // The key runners join the Environment with, shown only now.
  newKey(provider: string): string {
    const key = secretToken("pck_");
    this.#store.setEnvironmentKey(provider, tokenHash(key));

    return key;
  }

  newJoinKey(ownerId: string): string {
    const key = secretToken("pck_");
    this.#store.insertJoinKey(tokenHash(key), ownerId);

    return key;
  }

  // The first runner to join with a join key gets an Environment that
  // environments.create makes for it, and the key becomes that Environment's.
  // A runner is refused the name of one online in the Environment, and takes
  // over the name of one offline, whose tokens stop working (ADR 0032).
  join(
    key: string,
    runner: string,
    environments: {
      readonly create: (runner: string, ownerId: string) => string;
      readonly online: (environment: string, runner: string) => boolean;
    },
  ): Joined | "online" | undefined {
    const hashed = tokenHash(key);
    const owner = this.#store.joinKeyOwner(hashed);
    if (owner !== undefined) {
      this.#store.claimJoinKey(hashed, environments.create(runner, owner));
    }

    const environment = this.#store.keyEnvironment(hashed);
    if (environment === undefined) {
      return undefined;
    }

    if (environments.online(environment, runner)) {
      return "online";
    }

    this.#store.deleteRunnerTokens(environment, runner);

    return {
      token: this.#token({
        environment,
        runner,
        sessionId: null,
        joined: true,
      }),
      environment,
    };
  }

  // The server's own runner needs no key, and it and its Sessions stop with
  // the server, so their tokens live only in memory. A new key for its
  // Environment leaves them be.
  ownRunnerToken(environment: string, runner: string): string {
    return this.#token(
      { environment, runner, sessionId: null, joined: false },
      true,
    );
  }

  // For a runner a plugin starts, such as a Kubernetes pod (ADR 0032).
  runnerToken(environment: string, runner: string): string {
    return this.#token({ environment, runner, sessionId: null, joined: false });
  }

  revokeRunner(environment: string, runner: string): void {
    this.#store.deleteRunnerTokens(environment, runner);
  }

  // The token a Session of the calling runner uses for its current attempt.
  sessionToken(runner: RunnerCaller, sessionId: string): string {
    return this.#token(
      { ...runner, sessionId },
      [...this.#ownTokens.values()].includes(runner),
    );
  }

  // A runner token nobody used for runnerTokenDays stops working, and the
  // tokens of that runner's Sessions with it (ADR 0032).
  callerOf(request: Request): RunnerCaller | undefined {
    const [scheme, token] = (request.headers.get("authorization") ?? "").split(
      " ",
    );

    if (scheme !== "Bearer" || token === undefined) {
      return undefined;
    }

    const hashed = tokenHash(token);
    const own = this.#ownTokens.get(hashed);
    if (own !== undefined) {
      return own;
    }

    const stored = this.#store.runnerToken(hashed);
    if (stored?.holder.sessionId !== null) {
      return stored?.holder;
    }

    const now = this.#clock.now();
    const lastUsed = Date.parse(stored.lastUsed);
    if (now - lastUsed < lastUsedStepMs) {
      return stored.holder;
    }

    const usedBefore = now - this.#tokenDays() * 24 * 60 * 60_000;
    const expired = lastUsed < usedBefore;

    if (!expired) {
      this.#store.useRunnerToken(hashed, new Date(now).toISOString());
    }

    this.#store.deleteUnusedRunnerTokens(new Date(usedBefore).toISOString());

    return expired ? undefined : stored.holder;
  }

  #token(holder: RunnerCaller, own = false): string {
    const token = secretToken("pct_");
    const hashed = tokenHash(token);

    if (!own) {
      this.#store.insertRunnerToken(
        hashed,
        holder,
        new Date(this.#clock.now()).toISOString(),
      );

      return token;
    }

    for (const [previous, { sessionId }] of this.#ownTokens) {
      if (sessionId !== null && sessionId === holder.sessionId) {
        this.#ownTokens.delete(previous);
      }
    }

    this.#ownTokens.set(hashed, holder);

    return token;
  }
}
