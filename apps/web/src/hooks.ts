import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type {
  Environment,
  HubLayout,
  HubPage,
  Invite,
  ListedTemplate,
  Person,
  PluginInfo,
  Profile,
  Session,
} from "@pipoca/protocol";
import { responseOrder, watchChanges } from "@pipoca/plugins/web";
import { api } from "./api";
import { noticeText, settled } from "./notices";

function subscribeHash(onChange: () => void): () => void {
  window.addEventListener("hashchange", onChange);

  return () => {
    window.removeEventListener("hashchange", onChange);
  };
}

export function useHash(): string {
  return useSyncExternalStore(subscribeHash, () => location.hash.slice(1));
}

interface WatchedList<T> {
  readonly value: readonly T[];
  // False until the first read comes back, while value is still empty.
  readonly loaded: boolean;
  readonly reload: () => void;
}

// Reads a JSON list from the server and reads it again whenever the server
// says its topic changed (ADR 0038).
function useWatchedList(path: string, topic: string): WatchedList<unknown> {
  const [value, setValue] = useState<readonly unknown[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [order] = useState(responseOrder);

  const reload = useCallback(() => {
    const request = order.send();

    api(path)
      .then(async (response) => {
        const list = (await response.json()) as unknown[];

        if (order.accept(request)) {
          setValue(list);
          setLoaded(true);
        }
      })
      .catch((error: unknown) => {
        // The browser session ended, so the page goes back to signing in.
        if (error instanceof Error && error.cause === "signed_out") {
          location.reload();
        }
      });
  }, [path, order]);

  useEffect(() => {
    reload();
    const unwatch = watchChanges([topic], reload);

    return () => {
      unwatch();
      order.drop();
    };
  }, [reload, order, topic]);

  return { value, loaded, reload };
}

export function useSessions(archived: boolean): WatchedList<Session> {
  return useWatchedList(
    `/api/sessions?archived=${String(archived)}&owner=all`,
    "sessions",
  ) as WatchedList<Session>;
}

// Every user sees the team's Sessions (ADR 0064).
export function useTeamSessions(): WatchedList<Session> {
  return useWatchedList(
    "/api/sessions?owner=team",
    "sessions",
  ) as WatchedList<Session>;
}

// The team hub's pages, or null while it shows every panel on Home.
export function useHubLayout(): {
  readonly pages: readonly HubPage[] | null;
  readonly reload: () => void;
} {
  const [pages, setPages] = useState<readonly HubPage[] | null>(null);

  const reload = useCallback(() => {
    api("/api/hub")
      .then(async (response) => {
        setPages(((await response.json()) as HubLayout).pages);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    reload();

    return watchChanges(["hub"], reload);
  }, [reload]);

  return { pages, reload };
}

export function useProfiles(): WatchedList<Profile> {
  return useWatchedList("/api/profiles", "profiles") as WatchedList<Profile>;
}

export function usePlugins(): WatchedList<PluginInfo> {
  return useWatchedList("/api/plugins", "plugins") as WatchedList<PluginInfo>;
}

export function useEnvironments(): WatchedList<Environment> {
  return useWatchedList(
    "/api/environments",
    "environments",
  ) as WatchedList<Environment>;
}

// For admins: everyone, and an outline of their Environments and active
// Sessions (ADR 0049).
export function usePeople(): WatchedList<Person> {
  return useWatchedList("/api/people", "environments") as WatchedList<Person>;
}

export function useInvites(): WatchedList<Invite> {
  return useWatchedList("/api/invites", "environments") as WatchedList<Invite>;
}

export function useEveryonesEnvironments(): WatchedList<Environment> {
  return useWatchedList(
    "/api/environments?people=all",
    "environments",
  ) as WatchedList<Environment>;
}

export function useEveryonesSessions(): WatchedList<Session> {
  return useWatchedList(
    "/api/sessions?archived=false&owner=all&people=all",
    "sessions",
  ) as WatchedList<Session>;
}

export function useTemplates(): WatchedList<ListedTemplate> {
  return useWatchedList(
    "/api/templates",
    "environments",
  ) as WatchedList<ListedTemplate>;
}

export interface McpToken {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
}

export function useMcpTokens(): WatchedList<McpToken> {
  return useWatchedList(
    "/api/mcp-tokens",
    "mcp-tokens",
  ) as WatchedList<McpToken>;
}

// Tells the browser when a session stops working, unless it is on screen or
// the browser gets push notifications for it instead.
export function useSettledNotices(
  sessions: readonly Session[],
  route: string,
): void {
  const previous = useRef<readonly Session[]>([]);

  useEffect(() => {
    const done = settled(previous.current, sessions);
    previous.current = sessions;

    if (
      done.length === 0 ||
      typeof Notification === "undefined" ||
      Notification.permission !== "granted"
    ) {
      return;
    }

    void pushed().then((subscribed) => {
      if (!subscribed) {
        notify(done, route);
      }
    });
  }, [sessions, route]);

  // A clicked push notification asks an open window to show its Session.
  useEffect(() => {
    if (!("serviceWorker" in navigator)) {
      return;
    }

    const open = (event: MessageEvent): void => {
      const data = event.data as { type?: unknown; session?: unknown };
      if (data.type === "open-session" && typeof data.session === "string") {
        location.hash = data.session;
      }
    };

    navigator.serviceWorker.addEventListener("message", open);

    return () => {
      navigator.serviceWorker.removeEventListener("message", open);
    };
  }, []);
}

async function pushed(): Promise<boolean> {
  if (!("serviceWorker" in navigator)) {
    return false;
  }

  const registration = await navigator.serviceWorker.getRegistration("/");

  const subscription = await registration?.pushManager.getSubscription();

  return subscription !== undefined && subscription !== null;
}

function notify(done: readonly Session[], route: string): void {
  for (const session of done) {
    if (session.id === route && document.visibilityState === "visible") {
      continue;
    }

    let notice: Notification;

    // Android Chrome grants permission but throws here: it only allows
    // notifications from a service worker.
    try {
      notice = new Notification(noticeText(session), { tag: session.id });
    } catch {
      return;
    }

    notice.addEventListener("click", () => {
      window.focus();
      location.hash = session.id;
      notice.close();
    });
  }
}

// The time now, again every 30 seconds, for saying how long ago something was.
export function useNow(): number {
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 30_000);

    return () => {
      clearInterval(timer);
    };
  }, []);

  return now;
}
