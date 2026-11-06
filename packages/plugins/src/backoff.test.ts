import { expect, test } from "bun:test";
import { type Backoff, backoff } from "./backoff";

test("doubles the wait after each failure in a row, up to 32 times the first", () => {
  const waits: number[] = [];
  let last: Backoff | undefined;
  let now = 0;

  for (let failure = 0; failure < 8; failure++) {
    last = backoff(last, now, 100);
    waits.push(last.retryAt - now);
    now = last.retryAt;
  }

  expect(waits).toEqual([100, 200, 400, 800, 1600, 3200, 3200, 3200]);
});

test("starts over after a quiet spell longer than the longest wait", () => {
  const second = backoff(backoff(undefined, 0, 100), 100, 100);

  expect(backoff(second, second.retryAt + 3200, 100).inARow).toBe(3);

  expect(backoff(second, second.retryAt + 3201, 100)).toEqual({
    inARow: 1,
    retryAt: second.retryAt + 3301,
  });
});
