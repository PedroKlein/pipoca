export type Log = (
  message: string,
  fields?: Readonly<Record<string, unknown>>,
) => void;

export interface Clock {
  readonly now: () => number;
}

export const systemClock: Clock = { now: () => Date.now() };

export interface Timer {
  readonly after: (ms: number, fire: () => Promise<void>) => () => void;
}

export const systemTimer: Timer = {
  after: (ms, fire) => {
    const timer = setTimeout(() => void fire(), ms);

    return () => {
      clearTimeout(timer);
    };
  },
};
