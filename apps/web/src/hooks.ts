import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type {
  AccessToken,
  Account,
  Environment,
  HubPage,
  Invite,
  ListedTemplate,
  Person,
  PluginInfo,
  Profile,
  Session,
  Teammate,
  TeamView,
} from "@pipoca/protocol";
import { teamMessagesRead } from "@pipoca/protocol";
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

// Reads a list from the server and reads it again whenever the server says
// its topic changed (ADR 0038). The list is read again when key changes.
function useWatchedList<T>(
  key: string,
  load: () => Promise<readonly T[]>,
  ...topics: readonly string[]
): WatchedList<T> {
  const [value, setValue] = useState<readonly T[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [order] = useState(responseOrder);

  const reload = useCallback(() => {
    const request = order.send();

    load()
      .then((list) => {
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
    // key names what load reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, order]);

  const watched = topics.join(" ");

  useEffect(() => {
    reload();
    const unwatch = watchChanges(watched.split(" "), reload);

    return () => {
      unwatch();
      order.drop();
    };
  }, [reload, order, watched]);

  return { value, loaded, reload };
}

// Owned Sessions too, for search and notices (ADR 0028).
export function useSessions(archived: boolean): WatchedList<Session> {
  return useWatchedList(
    String(archived),
    async () => api("sessions.list", { query: { archived, plugins: true } }),
    "sessions",
  );
}

// Every user sees the team's Sessions (ADR 0064).
export function useTeamSessions(): WatchedList<Session> {
  return useWatchedList(
    "team",
    async () => api("sessions.list", { query: { scope: "team" } }),
    "sessions",
  );
}

// The team's Environments and Profiles, which any user starts team work on.
export function useTeamEnvironments(): WatchedList<Environment> {
  return useWatchedList(
    "team",
    async () => api("environments.list", { query: { scope: "team" } }),
    "environments",
  );
}

export function useTeamProfiles(): WatchedList<Profile> {
  return useWatchedList(
    "team",
    async () => api("profiles.list", { query: { scope: "team" } }),
    "profiles",
  );
}

// The team hub's pages, or null while it shows every panel on Home.
export function useHubLayout(): {
  readonly pages: readonly HubPage[] | null;
  readonly reload: () => void;
} {
  const [pages, setPages] = useState<readonly HubPage[] | null>(null);

  const reload = useCallback(() => {
    api("settings.hub")
      .then((layout) => {
        setPages(layout.pages);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    reload();

    return watchChanges(["hub"], reload);
  }, [reload]);

  return { pages, reload };
}

// The team's name, null while admins haven't given it one, and how many of
// its messages Pi reads.
export function useTeam(): TeamView {
  const [team, setTeam] = useState<TeamView>({
    name: null,
    messagesRead: teamMessagesRead,
  });

  useEffect(() => {
    const read = (): void => {
      api("settings.team")
        .then(setTeam)
        .catch(() => undefined);
    };

    read();

    return watchChanges(["team"], read);
  }, []);

  return team;
}

// The signed-in person's own account, undefined until it is read.
export function useAccount(): Account | undefined {
  const [account, setAccount] = useState<Account>();

  useEffect(() => {
    const read = (): void => {
      api("me")
        .then(setAccount)
        .catch(() => undefined);
    };

    read();

    return watchChanges(["people"], read);
  }, []);

  return account;
}

export function useProfiles(): WatchedList<Profile> {
  return useWatchedList("", async () => api("profiles.list"), "profiles");
}

export function usePlugins(): WatchedList<PluginInfo> {
  return useWatchedList("", async () => api("plugins.list"), "plugins");
}

export function useEnvironments(): WatchedList<Environment> {
  return useWatchedList(
    "",
    async () => api("environments.list"),
    "environments",
  );
}

// For admins: everyone, and an outline of their Environments and active
// Sessions (ADR 0049).
export function usePeople(): WatchedList<Person> {
  return useWatchedList(
    "",
    async () => (await api("people.list")) as readonly Person[],
    "people",
    // Their outline changes as runners and Sessions come and go.
    "environments",
    "sessions",
  );
}

// Everyone else sees only names.
export function useTeammates(): WatchedList<Teammate> {
  return useWatchedList("", async () => api("people.list"), "people");
}

export function useInvites(): WatchedList<Invite> {
  return useWatchedList("", async () => api("invites.list"), "people");
}

export function useEveryonesEnvironments(): WatchedList<Environment> {
  return useWatchedList(
    "all",
    async () => api("environments.list", { query: { scope: "all" } }),
    "environments",
  );
}

export function useEveryonesSessions(): WatchedList<Session> {
  return useWatchedList(
    "all",
    async () =>
      api("sessions.list", {
        query: { scope: "all", archived: false, plugins: true },
      }),
    "sessions",
  );
}

export function useTemplates(): WatchedList<ListedTemplate> {
  return useWatchedList(
    "",
    async () => api("environmentTemplates.list"),
    "environments",
  );
}

export function useAccessTokens(): WatchedList<AccessToken> {
  return useWatchedList(
    "",
    async () => api("me.accessTokens"),
    "access-tokens",
  );
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
