import type { ServerPluginContext } from "@pipoca/plugins";
import type { GitLogin, Session } from "@pipoca/protocol";
import { HostRefused, reach } from "./github";
import type { HostStore } from "./hosts";
import {
  type AppUser,
  installationsOf,
  installationToken,
  type TechnicalUser,
  type TechnicalUsers,
  teamOwner,
} from "./technical-users";

// A Session gets a token that lives at least this long, and the tokens are
// checked this often.
const freshMs = 50 * 60_000;
const refreshMs = 5 * 60_000;

interface Cached {
  readonly token: string;
  readonly expiresAt: number;
}

export interface TeamReach {
  readonly host: string;
  readonly login: string;
  readonly kind: "app" | "token";
  readonly token: string;
}

export interface Identity {
  readonly name: string;
  readonly email: string;
}

export interface Acting {
  // The logins of a Session that acts as a technical user: the bot's on its
  // host, and the person's own on the others.
  readonly logins: (
    userId: string,
    session: Pick<Session, "actsAs" | "workspace">,
    own: readonly GitLogin[],
  ) => readonly GitLogin[];
  // The logins of team work that acts as no one in particular: on each host,
  // the technical user admins chose for the team.
  readonly team: (session: Pick<Session, "workspace">) => readonly GitLogin[];
  // What team work can reach on each host: a machine user's token, or a
  // token for each of the App's installations.
  readonly teamReach: () => readonly TeamReach[];
  // Who the Session's commits are by.
  readonly identity: (name: string) => Promise<Identity | undefined>;
  readonly refresh: () => Promise<void>;
}

// Sessions that act as a technical user sign git in as it (ADR 0060). The
// runner gets its token when it claims the Session, which can't wait on the
// host, so the server keeps a fresh token for each of each App's
// installations.
export function acting(
  context: ServerPluginContext,
  hosts: HostStore,
  users: TechnicalUsers,
): Acting {
  const tokens = new Map<string, Cached>();
  const ids = new Map<string, number>();
  let refreshing: Promise<void> | undefined;

  const keyOf = (name: string, account: string): string =>
    `${name} ${account.toLowerCase()}`;

  const refreshApp = async (user: AppUser): Promise<void> => {
    const host = hosts.get(user.host);

    if (host === undefined) {
      return;
    }

    for (const { id, account } of await installationsOf(host, user.app)) {
      const key = keyOf(user.name, account);

      if ((tokens.get(key)?.expiresAt ?? 0) - Date.now() > freshMs) {
        continue;
      }

      tokens.set(key, await installationToken(host, user.app, id));
    }
  };

  const refresh = async (): Promise<void> => {
    refreshing ??= (async () => {
      for (const user of users.list()) {
        if (!("app" in user)) {
          continue;
        }

        await refreshApp(user).catch((failure: unknown) => {
          if (!(failure instanceof HostRefused)) {
            throw failure;
          }

          context.log("could not refresh a technical user's tokens", {
            name: user.name,
            error: failure.message,
          });
        });
      }
    })().finally(() => {
      refreshing = undefined;
    });

    return refreshing;
  };

  const kick = (): void => {
    refresh().catch((failure: unknown) => {
      context.log("refreshing technical users' tokens failed", {
        error: String(failure),
      });
    });
  };

  kick();

  const timer = setInterval(kick, refreshMs);

  context.signal.addEventListener("abort", () => {
    clearInterval(timer);
  });

  const tokenOf = (
    user: TechnicalUser,
    workspace: Session["workspace"],
  ): string | undefined => {
    if (!("app" in user)) {
      return user.token;
    }

    for (const account of accountsIn(workspace, user.host)) {
      const cached = tokens.get(keyOf(user.name, account));

      if (cached !== undefined && cached.expiresAt > Date.now()) {
        return cached.token;
      }
    }

    return undefined;
  };

  const teamUsers = (): readonly TechnicalUser[] =>
    users.list().filter((user) => user.users.includes(teamOwner));

  const installed = (user: TechnicalUser): readonly Cached[] =>
    [...tokens]
      .filter(
        ([key, { expiresAt }]) =>
          key.startsWith(`${user.name} `) && expiresAt > Date.now(),
      )
      .map(([, cached]) => cached);

  return {
    refresh,
    logins: (userId, { actsAs, workspace }, own) => {
      const user = actsAs === null ? undefined : users.get(actsAs);

      if (user?.users.includes(userId) !== true) {
        context.log("a Session can't act as this technical user", {
          name: actsAs,
          userId,
        });

        return [];
      }

      const others = own.filter(({ host }) => host !== user.host);
      const token = tokenOf(user, workspace);

      if (token === undefined) {
        context.log("the App isn't installed where the Session works", {
          name: user.name,
        });

        kick();

        return others;
      }

      return [{ host: user.host, token }, ...others];
    },
    // A package can live outside the workspace's accounts, so an App falls
    // back to any of its installations.
    team: ({ workspace }) =>
      teamUsers().flatMap((user) => {
        const token = tokenOf(user, workspace) ?? installed(user).at(0)?.token;

        return token === undefined ? [] : [{ host: user.host, token }];
      }),
    teamReach: () =>
      teamUsers().flatMap((user): readonly TeamReach[] =>
        "app" in user
          ? installed(user).map(({ token }) => ({
              host: user.host,
              login: `${user.app.slug}[bot]`,
              kind: "app",
              token,
            }))
          : [
              {
                host: user.host,
                login: user.login,
                kind: "token",
                token: user.token,
              },
            ],
      ),
    identity: async (name) => {
      const user = users.get(name);
      const host = user && hosts.get(user.host);

      if (user === undefined || host === undefined) {
        return undefined;
      }

      const login = "app" in user ? `${user.app.slug}[bot]` : user.login;
      let id = ids.get(name);

      if (id === undefined) {
        id = await userIdOf(host, login).catch(() => undefined);

        if (id !== undefined) {
          ids.set(name, id);
        }
      }

      const domain =
        user.host === "github.com"
          ? "users.noreply.github.com"
          : `users.noreply.${user.host}`;

      return {
        name: login,
        email: `${id === undefined ? "" : `${String(id)}+`}${login}@${domain}`,
      };
    },
  };
}

async function userIdOf(
  host: NonNullable<ReturnType<HostStore["get"]>>,
  login: string,
): Promise<number | undefined> {
  const response = await reach(
    host,
    `${host.api}/users/${encodeURIComponent(login)}`,
    { headers: { accept: "application/vnd.github+json" } },
  );

  const { id } = (await response.json().catch(() => ({}))) as {
    id?: unknown;
  };

  return response.ok && typeof id === "number" ? id : undefined;
}

// The accounts that own the repositories a Session works in on the host.
function accountsIn(
  workspace: Session["workspace"],
  host: string,
): readonly string[] {
  const urls = (() => {
    switch (workspace.kind) {
      case "clone":
        return [workspace.repository];
      case "repositories":
        return workspace.repositories.map(({ repository }) => repository);
      case "folder":
      case "worktree":
        return [];
    }
  })();

  return urls.flatMap((url) => {
    const match = /^(?:https?:\/\/|git@)([^/:]+)[/:]([^/]+)\//.exec(url);

    return match?.[1]?.toLowerCase() === host && match[2] !== undefined
      ? [match[2]]
      : [];
  });
}
