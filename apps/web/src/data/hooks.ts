import {
  type ApiArgs,
  type ApiInput,
  apiPath,
  type ApiReply,
  type RouteKey,
  type Routes,
  type User,
} from "@pipoca/protocol";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { errorText, request, store } from "./client";

// The routes a page reads: GETs that answer JSON.
export type QueryKey = {
  [Key in RouteKey]: Routes[Key]["method"] extends "GET"
    ? ApiReply<Key> extends Response | undefined
      ? never
      : Key
    : never;
}[RouteKey];

// The change topics after which each route is read again (ADR 0038).
const topicsOf: Readonly<Partial<Record<QueryKey, readonly string[]>>> = {
  "auth.status": ["people"],
  me: ["people"],
  "me.setup": ["setup"],
  "me.pinnedPages": ["pinned-pages"],
  "me.accessTokens": ["access-tokens"],
  "me.profileDefaults": ["profiles"],
  "me.profileDefaults.files": ["profiles"],
  "settings.team": ["team"],
  "settings.hub": ["hub"],
  "settings.newcomers": ["newcomers"],
  "settings.config": ["config"],
  "settings.config.file": ["config"],
  "settings.baseProfile": ["profiles"],
  "settings.baseProfile.files": ["profiles"],
  "people.list": ["people"],
  "invites.list": ["invites"],
  "plugins.list": ["plugins"],
  "plugins.files": ["plugins"],
  "plugins.config": ["plugins"],
  "environments.list": ["environments"],
  "environmentTemplates.list": ["templates"],
  "profiles.list": ["profiles"],
  "profiles.get": ["profiles"],
  "profiles.files": ["profiles"],
  "sessions.list": ["sessions"],
  "sessions.get": ["sessions"],
};

export interface QueryOptions {
  // Topics besides the route's own.
  readonly topics?: readonly string[];
  // Read again this often, for what changes outside Pipoca.
  readonly everyMs?: number;
  // False leaves it unread, such as a list only admins may read.
  readonly enabled?: boolean;
}

export interface Query<T> {
  readonly data: T | undefined;
  readonly error: string | undefined;
  readonly loading: boolean;
  readonly reload: () => void;
}

type QueryArgs<Key extends QueryKey> =
  ApiArgs<Key> extends [input: infer Input]
    ? [input: Input, options?: QueryOptions]
    : [input?: ApiInput<Key>, options?: QueryOptions];

const idle = { data: undefined, error: undefined, loading: false };

const ignore = (): (() => void) => () => undefined;

// Data from the server, shared by every component that reads the same key
// and read again when one of its topics changes.
export function useLoad<T>(
  key: string,
  load: () => Promise<T>,
  { topics = [], everyMs, enabled = true }: QueryOptions = {},
): Query<T> {
  const latest = useRef(load);
  const watched = topics.join(" ");

  useEffect(() => {
    latest.current = load;
  });

  const subscribe = useCallback(
    (listener: () => void) =>
      store.subscribe(
        key,
        {
          load: async () => latest.current(),
          topics: watched === "" ? [] : watched.split(" "),
        },
        listener,
      ),
    [key, watched],
  );

  const snapshot = useSyncExternalStore(enabled ? subscribe : ignore, () =>
    enabled ? store.read<T>(key) : idle,
  );

  useEffect(() => {
    if (!enabled || everyMs === undefined) {
      return undefined;
    }

    const timer = setInterval(() => void store.reload(key), everyMs);

    return () => {
      clearInterval(timer);
    };
  }, [key, enabled, everyMs]);

  const reload = useCallback(() => void store.reload(key), [key]);

  return {
    data: snapshot.data,
    error: snapshot.error?.message,
    loading: snapshot.loading,
    reload,
  };
}

const cacheKey = <Key extends QueryKey>(key: Key, args: ApiArgs<Key>): string =>
  `GET ${apiPath(key, ...args)}`;

// Reads again what watches the topics, for a change the page learned of
// another way, such as a Session's own events.
export function invalidate(topics: readonly string[]): void {
  store.invalidate(topics);
}

// An answer the page already has, such as one read before it first drew.
export function seed<Key extends QueryKey>(
  key: Key,
  data: ApiReply<Key>,
  ...args: ApiArgs<Key>
): void {
  store.seed(cacheKey(key, args), data);
}

// A route's answer, typed by the route table.
export function useQuery<Key extends QueryKey>(
  key: Key,
  ...[input, options = {}]: QueryArgs<Key>
): Query<ApiReply<Key>> {
  const args = [input] as ApiArgs<Key>;

  return useLoad(
    cacheKey(key, args),
    async () => signedIn(request(key, ...args)),
    {
      ...options,
      topics: [...(topicsOf[key] ?? []), ...(options.topics ?? [])],
    },
  );
}

// The browser's session ended, so the page goes back to signing in.
async function signedIn<T>(reply: Promise<T>): Promise<T> {
  return reply.catch((reason: unknown) => {
    if (reason instanceof Error && reason.cause === "signed_out") {
      location.reload();
    }

    throw reason;
  });
}

export interface Action<Args extends readonly unknown[], Result> {
  // Resolves undefined when it fails, with error set.
  readonly run: (...args: Args) => Promise<Result | undefined>;
  readonly pending: boolean;
  readonly error: string | undefined;
  readonly clear: () => void;
}

// Something a person does, with whether it is under way and what failed.
export function useAction<Args extends readonly unknown[], Result>(
  action: (...args: Args) => Promise<Result>,
): Action<Args, Result> {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const latest = useRef(action);
  const mounted = useRef(true);

  useEffect(() => {
    latest.current = action;
  });

  useEffect(() => {
    mounted.current = true;

    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(async (...args: Args) => {
    setPending(true);
    setError(undefined);

    try {
      return await latest.current(...args);
    } catch (reason) {
      if (mounted.current) {
        setError(errorText(reason));
      }

      return undefined;
    } finally {
      if (mounted.current) {
        setPending(false);
      }
    }
  }, []);

  const clear = useCallback(() => {
    setError(undefined);
  }, []);

  return { run, pending, error, clear };
}

export interface Me {
  readonly user: User;
  readonly admin: boolean;
  // A server several people use has a team (ADR 0064).
  readonly team: boolean;
  readonly solo: boolean;
}

// Who is signed in, from the page's first read of the server.
export function useMe(): Me {
  const status = useQuery("auth.status").data;
  const user = status?.user;

  if (status === undefined || user === null || user === undefined) {
    throw new Error("useMe needs a signed-in page");
  }

  return { user, admin: user.admin, team: !status.solo, solo: status.solo };
}
