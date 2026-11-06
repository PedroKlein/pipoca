export interface Scheduled {
  readonly key: string;
  readonly when: number;
  readonly payload: unknown;
}

// Durable time for a plugin. A run that throws is logged; an interval runs
// again after its interval, and an `at` key retries after 1, 5 and 30
// minutes before it is dropped.
export interface Schedule {
  readonly every: (
    name: string,
    interval: number | (() => number),
    fn: () => void | Promise<void>,
  ) => void;
  readonly at: (key: string, when: number, payload?: unknown) => void;
  readonly on: (
    prefix: string,
    fn: (payload: unknown, key: string) => void | Promise<void>,
  ) => void;
  readonly cancel: (key: string) => void;
  readonly pending: (prefix: string) => readonly Scheduled[];
}
