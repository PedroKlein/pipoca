import type { Clock, Timer } from "@pipoca/protocol";
import { serve, type ServeOptions } from "../serve";
import { firstUserCookie, firstUserLogin, setupTokenOf } from "./sign-in";

// Moving the clock fires the timers it passes and waits for what they run.
export interface TestClock extends Clock, Timer {
  readonly advance: (ms: number) => Promise<void>;
}

interface Waiting {
  readonly at: number;
  readonly fire: () => Promise<void>;
}

const longestTimeoutMs = 2 ** 31 - 1;

// The clock follows the system's until a test moves it.
export function testClock(): TestClock {
  let ahead = 0;
  const waiting = new Set<Waiting>();
  const now = (): number => Date.now() + ahead;

  return {
    now,
    after: (ms, fire) => {
      if (ms > longestTimeoutMs) {
        throw new Error(`a timer can't wait ${String(ms)} ms`);
      }

      let fired: Promise<void> | undefined;

      const timer: Waiting = {
        at: now() + ms,
        fire: async () => {
          cancel();
          fired ??= fire();

          return fired;
        },
      };

      const real = setTimeout(() => void timer.fire(), ms);

      const cancel = (): void => {
        clearTimeout(real);
        waiting.delete(timer);
      };

      waiting.add(timer);

      return cancel;
    },
    advance: async (ms) => {
      ahead += ms;

      for (;;) {
        const due = [...waiting].filter(({ at }) => at <= now());

        if (due.length === 0) {
          return;
        }

        await Promise.all(due.map(async ({ fire }) => fire()));
      }
    },
  };
}

export interface ApiInit {
  readonly method?: string;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  readonly redirect?: NonNullable<RequestInit["redirect"]>;
  readonly signal?: AbortSignal;
}

export type Api = (path: string, init?: ApiInit) => Promise<Response>;

const open = new Set<TestServer>();

export interface TestServer {
  readonly url: URL;
  readonly logs: readonly string[];
  readonly clock: TestClock;
  readonly signedIn: () => Promise<string>;
  readonly signIn: () => Promise<string>;
  readonly api: Api;
  readonly as: (cookie?: string) => Api;
  readonly close: () => Promise<void>;
}

// The first user is made on first use, unless a cookie from an earlier
// server on the same database is given. A clock from an earlier server keeps
// its time.
export function testServer(
  options: Partial<Omit<ServeOptions, "clock" | "timer">> & {
    readonly cookie?: string;
    readonly clock?: TestClock;
  } = {},
): TestServer {
  const { cookie, log, clock = testClock(), ...serveOptions } = options;
  const logs: string[] = [];

  const server = serve({
    port: 0,
    database: ":memory:",
    ...serveOptions,
    clock,
    timer: clock,
    log: (message, fields) => {
      logs.push(`${message} ${JSON.stringify(fields)}`);
      log?.(message, fields);
    },
  });

  let signedIn: Promise<string> | undefined =
    cookie === undefined ? undefined : Promise.resolve(cookie);

  const firstUser = async (): Promise<string> => {
    signedIn ??= firstUserCookie(fetch, server.url, setupTokenOf(logs));

    return signedIn;
  };

  const signIn = async (): Promise<string> => {
    await firstUser();

    const response = await fetch(new URL("/api/auth/session", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(firstUserLogin),
    });

    signedIn = Promise.resolve(
      response.headers.get("set-cookie")?.split(";")[0] ?? "",
    );

    return signedIn;
  };

  const caller =
    (cookieOf: () => Promise<string | undefined>): Api =>
    async (path, { method, body, headers, ...init } = {}) => {
      const sent = await cookieOf();

      return fetch(new URL(path, server.url), {
        redirect: "manual",
        ...init,
        method: method ?? (body === undefined ? "GET" : "POST"),
        headers: {
          ...(sent !== undefined && { cookie: sent }),
          ...(body !== undefined && { "content-type": "application/json" }),
          ...headers,
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
    };

  let closed: Promise<void> | undefined;

  const started: TestServer = {
    url: server.url,
    logs,
    clock,
    signedIn: firstUser,
    signIn,
    api: caller(firstUser),
    as: (as) => caller(async () => Promise.resolve(as)),
    close: async () => {
      open.delete(started);
      closed ??= server.stop();

      await closed;
    },
  };

  open.add(started);

  return started;
}

export async function closeServers(): Promise<void> {
  await Promise.all([...open].map(async (server) => server.close()));
}

export async function json<T>(response: Promise<Response>): Promise<T> {
  return (await (await response).json()) as T;
}
