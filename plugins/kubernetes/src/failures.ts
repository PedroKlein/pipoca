import { type Backoff, backoff } from "@pipoca/plugins";
import type { PodFailure } from "./settings";

export interface FailedPod {
  // What the pod was started for: its Environment's shared pods, or one
  // Session's own pod, which backs off alone.
  readonly key: string;
  readonly environmentId: string;
  readonly pod: string;
  readonly problem: string;
}

interface Failure extends Backoff {
  readonly environmentId: string;
  readonly last: PodFailure;
}

// Runner pods that failed in a row. The next pod for the same key waits as
// backoff says.
export class PodFailures {
  readonly #retryAfterMs: number;
  readonly #byKey = new Map<string, Failure>();

  constructor(retryAfterMs: number) {
    this.#retryAfterMs = retryAfterMs;
  }

  // One pass's failures: pods of one key failing together count once.
  record(failed: readonly FailedPod[], now: number): void {
    const keys = new Map(failed.map((each) => [each.key, each]));

    for (const { key, environmentId, pod, problem } of keys.values()) {
      const next = backoff(this.#byKey.get(key), now, this.#retryAfterMs);

      this.#byKey.set(key, {
        ...next,
        environmentId,
        last: {
          pod,
          problem,
          at: new Date(now).toISOString(),
          retryAt: new Date(next.retryAt).toISOString(),
        },
      });
    }
  }

  waiting(key: string, now: number): boolean {
    const retryAt = this.#byKey.get(key)?.retryAt;

    return retryAt !== undefined && retryAt > now;
  }

  clear(key: string): void {
    this.#byKey.delete(key);
  }

  // New settings may well fix what failed.
  clearEnvironment(environmentId: string): void {
    for (const [key, { environmentId: id }] of this.#byKey) {
      if (id === environmentId) {
        this.#byKey.delete(key);
      }
    }
  }

  last(environmentId: string): PodFailure | null {
    return (
      [...this.#byKey.values()]
        .filter(({ environmentId: id }) => id === environmentId)
        .map(({ last }) => last)
        .sort((a, b) => b.at.localeCompare(a.at))[0] ?? null
    );
  }
}
