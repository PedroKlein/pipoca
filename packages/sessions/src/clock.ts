export interface Clock {
  readonly now: () => number;
}

export const systemClock: Clock = { now: () => Date.now() };
