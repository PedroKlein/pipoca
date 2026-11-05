import { serve, type ServeOptions } from "../serve";
import { firstUserCookie, firstUserLogin, setupTokenOf } from "./sign-in";

export interface TestClock {
  readonly now: () => number;
  readonly advance: (ms: number) => void;
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

// The clock follows the system's until a test moves it. The first user is
// made on first use, unless a cookie from an earlier server on the same
// database is given.
export function testServer(
  options: Partial<Omit<ServeOptions, "clock">> & {
    readonly cookie?: string;
  } = {},
): TestServer {
  const { cookie, log, ...serveOptions } = options;
  const logs: string[] = [];
  let ahead = 0;

  const clock: TestClock = {
    now: () => Date.now() + ahead,
    advance: (ms) => {
      ahead += ms;
    },
  };

  const server = serve({
    port: 0,
    database: ":memory:",
    ...serveOptions,
    clock,
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

    const response = await fetch(new URL("/api/auth/login", server.url), {
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

export async function until<T>(
  read: () => T | Promise<T>,
  done: (value: T) => boolean = Boolean,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const value = await read();
    if (done(value)) {
      return value;
    }

    if (Date.now() > deadline) {
      throw new Error(`not done after ${String(timeoutMs)} ms`);
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export async function json<T>(response: Promise<Response>): Promise<T> {
  return (await (await response).json()) as T;
}
