export type Log = (
  message: string,
  fields?: Readonly<Record<string, unknown>>,
) => void;

export interface Clock {
  readonly now: () => number;
}

export const systemClock: Clock = { now: () => Date.now() };
