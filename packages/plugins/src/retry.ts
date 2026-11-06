export interface Retry {
  readonly inARow: number;
  readonly retryAt: number;
}

const mostDoublings = 5;

// Waits firstMs after a failure, twice as long after each one in a row, up
// to 32 times as long. A quiet spell longer than that starts over.
export function retryAfter(
  last: Retry | undefined,
  now: number,
  firstMs: number,
): Retry {
  const quiet =
    last === undefined || now - last.retryAt > firstMs * 2 ** mostDoublings;

  const inARow = quiet ? 1 : last.inARow + 1;

  return {
    inARow,
    retryAt: now + firstMs * 2 ** Math.min(inARow - 1, mostDoublings),
  };
}
