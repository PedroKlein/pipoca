import { setTimeout as sleep } from "node:timers/promises";

interface Backoff {
  // How long the next wait lasts.
  readonly delayMs: () => number;
  readonly reset: () => void;
  // Waits, or less if the signal aborts, and doubles the next wait up to the
  // longest.
  readonly wait: (signal: AbortSignal) => Promise<void>;
}

export function backoff(initialMs: number, maxMs: number): Backoff {
  let delayMs = initialMs;

  return {
    delayMs: () => delayMs,
    reset: () => {
      delayMs = initialMs;
    },
    wait: async (signal) => {
      await sleep(delayMs, undefined, { signal }).catch(() => undefined);
      delayMs = Math.min(delayMs * 2, maxMs);
    },
  };
}
