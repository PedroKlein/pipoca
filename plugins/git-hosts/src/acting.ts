import type { Collection, ServerContext } from "@pipoca/plugins";
import type { GitLogin, Owner, Session } from "@pipoca/protocol";
import type { gitHosts, TechnicalUserItem } from "../plugin";
import type { Identity } from "./commit-as";
import { HostRefused, reach } from "./github";
import type { HostConfig, Hosts } from "./hosts";
import {
  type AppUser,
  botLogin,
  installationsOf,
  installationToken,
  isApp,
  type TechnicalUser,
} from "./technical-users";

// A Session gets a token that lives at least this long, and the tokens are
// checked this often.
const freshMs = 50 * 60_000;
const refreshMs = 5 * 60_000;

interface Cached {
  readonly token: string;
  readonly expiresAt: number;
}

export interface TeamBot {
  readonly host: string;
  readonly login: string;
  // Missing while an App has no token where the Session works.
  readonly token: string | undefined;
}

interface TeamReach {
  readonly host: string;
  readonly kind: "app" | "token";
  readonly token: string;
}

export interface Acting {
  // The logins of a Session that acts as a technical user: the bot's on its
  // host, and the person's own on the others.
  readonly logins: (
    owner: Owner,
    session: Pick<Session, "actsAs" | "workspace">,
    own: readonly GitLogin[],
  ) => readonly GitLogin[];
  // The logins of team work that acts as no one in particular: on each host,
  // the technical user admins chose for the team.
  readonly team: (session: Pick<Session, "workspace">) => readonly GitLogin[];
  // The bots team work signs in as, the same ones git gets: the technical
  // user it acts as, or on each host the one admins chose for the team.
  readonly teamBots: (
    session: Pick<Session, "actsAs" | "workspace">,
  ) => readonly TeamBot[];
  // What team work can reach on each host: a machine user's token, or a
  // token for each of the App's installations.
  readonly teamReach: () => readonly TeamReach[];
  // Who the Session's commits are by.
  readonly identity: (name: string) => Promise<Identity | undefined>;
  // Fetches the installation tokens that are missing or about to expire.
  readonly refresh: () => void;
}

// Sessions that act as a technical user sign git in as it (ADR 0060). The
// runner gets its token when it claims the Session, which can't wait on the
// host, so the server keeps a fresh token for each of each App's
// installations.
export function acting(
  {
    clock,
    log,
    schedule,
  }: Pick<ServerContext<typeof gitHosts>, "clock" | "log" | "schedule">,
  hosts: Hosts,
  users: Collection<TechnicalUserItem>,
): Acting {
  const tokens = new Map<string, Cached>();
  const ids = new Map<string, number>();

  const keyOf = (name: string, account: string): string =>
    `${name} ${account.toLowerCase()}`;

  const live = (cached: Cached | undefined): cached is Cached =>
    cached !== undefined && cached.expiresAt > clock.now();

  const refreshApp = async (user: AppUser): Promise<void> => {
    const host = hosts.get(user.host);

    if (host === undefined) {
      return;
    }

    for (const { id, account } of await installationsOf(
      host,
      user.app,
      clock.now(),
    )) {
      const key = keyOf(user.name, account);

      if ((tokens.get(key)?.expiresAt ?? 0) - clock.now() > freshMs) {
        continue;
      }

      tokens.set(key, await installationToken(host, user.app, id, clock.now()));
    }
  };

  // One refresh at a time, and then every refreshMs, through the schedule
  // so it outlives a restart.
  schedule.on("refresh", async () => {
    for (const user of users.list()) {
      if (!isApp(user)) {
        continue;
      }

      await refreshApp(user).catch((failure: unknown) => {
        if (!(failure instanceof HostRefused)) {
          throw failure;
        }

        log("could not refresh a technical user's tokens", {
          name: user.name,
          error: failure.message,
        });
      });
    }

    schedule.at("refresh", clock.now() + refreshMs);
  });

  const refresh = (): void => {
    schedule.at("refresh", clock.now());
  };

  refresh();

  const tokenOf = (
    user: TechnicalUser,
    workspace: Session["workspace"],
  ): string | undefined => {
    if (!isApp(user)) {
      return user.token;
    }

    for (const account of accountsIn(workspace, user.host)) {
      const cached = tokens.get(keyOf(user.name, account));

      if (live(cached)) {
        return cached.token;
      }
    }

    return undefined;
  };

  const teamUsers = (): readonly TechnicalUser[] =>
    users.list().filter((user) => user.users.includes("team"));

  const installed = (user: TechnicalUser): readonly Cached[] =>
    [...tokens].flatMap(([key, cached]) =>
      key.startsWith(`${user.name} `) && live(cached) ? [cached] : [],
    );

  // A package can live outside the workspace's accounts, so an App falls
  // back to any of its installations.
  const teamToken = (
    user: TechnicalUser,
    workspace: Session["workspace"],
  ): string | undefined =>
    tokenOf(user, workspace) ?? installed(user).at(0)?.token;

  return {
    refresh,
    logins: (owner, { actsAs, workspace }, own) => {
      const user = actsAs === null ? undefined : users.get(actsAs.name);

      if (user?.users.includes(owner) !== true) {
        log("a Session can't act as this technical user", {
          name: actsAs?.name,
          owner,
        });

        return [];
      }

      const others = own.filter(({ host }) => host !== user.host);
      const token = tokenOf(user, workspace);

      if (token === undefined) {
        log("the App isn't installed where the Session works", {
          name: user.name,
        });

        refresh();

        return others;
      }

      return [{ host: user.host, token }, ...others];
    },
    team: ({ workspace }) =>
      teamUsers().flatMap((user) => {
        const token = teamToken(user, workspace);

        return token === undefined ? [] : [{ host: user.host, token }];
      }),
    teamBots: ({ actsAs, workspace }) => {
      if (actsAs === null) {
        return teamUsers().map((user) => ({
          host: user.host,
          login: botLogin(user),
          token: teamToken(user, workspace),
        }));
      }

      const user = users.get(actsAs.name);

      return user?.users.includes("team") === true
        ? [
            {
              host: user.host,
              login: botLogin(user),
              token: tokenOf(user, workspace),
            },
          ]
        : [];
    },
    teamReach: () =>
      teamUsers().flatMap((user): readonly TeamReach[] => {
        if (isApp(user)) {
          return installed(user).map(({ token }) => ({
            host: user.host,
            kind: "app",
            token,
          }));
        }

        return user.token === undefined
          ? []
          : [{ host: user.host, kind: "token", token: user.token }];
      }),
    identity: async (name) => {
      const user = users.get(name);
      const host = user && hosts.get(user.host);

      if (user === undefined || host === undefined) {
        return undefined;
      }

      const login = botLogin(user);
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
  host: HostConfig,
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
