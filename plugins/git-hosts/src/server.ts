import { randomBytes } from "node:crypto";
import {
  BadRequest,
  HttpError,
  NotFound,
  type PluginStore,
  readBody,
  type ServerPlugin,
  Type,
  type User,
} from "@pipoca/plugins";
import type { RepositoryChoice } from "@pipoca/protocol";
import {
  authorizationUrl,
  HostRefused,
  loginOf,
  redeem,
  installationRepositoriesOf,
  repositoriesOf,
} from "./github";
import { hash, originOf, page, redirect, secure } from "./pages";
import { pullRequests } from "./pull-requests";
import { acting } from "./acting";
import { commitAsBody, commitAsStore } from "./commit-as";
import { technicalUserRoutes } from "./technical-user-routes";
import { teamOwner, technicalUsers } from "./technical-users";
import { eventOf, signedWith } from "./webhooks";
import { type HostSearch, repositoriesTool } from "./tool";
import {
  type HostConfig,
  hostChange,
  hostStore,
  newHost,
  viewOf,
} from "./hosts";
import type { Account, Connection, HostView } from "./model";

// GitHub sends at most 25 MB, but the events taken from a webhook are small.
const maxHookBody = 5 * 1024 * 1024;

// A browser has this long to come back from the host.
const attemptMs = 10 * 60_000;
const browserCookie = "pipoca-git-hosts";

interface Pending {
  readonly host: string;
  readonly userId: string;
  readonly browser: string;
  readonly expires: number;
}

const connection = Type.Object({ host: Type.String(), token: Type.String() });

// Each person connects their own account on each host, and the runner signs
// git and gh in with it in that person's Sessions (ADR 0043).
const schema = `
create table git_hosts_connections (
  user_id text not null references users (id) on delete cascade,
  host text not null,
  login text not null,
  token text not null,
  connected_at integer not null,
  primary key (user_id, host)
) strict, without rowid;

create table git_hosts_commit_as (
  user_id text primary key references users (id) on delete cascade,
  name text not null,
  email text not null
) strict, without rowid;

create table git_hosts_watches (
  id text primary key,
  session_id text not null references sessions (id) on delete cascade,
  user_id text not null references users (id) on delete cascade,
  url text not null,
  host text not null,
  repository text not null,
  number integer not null,
  auto_fix integer not null check (auto_fix in (0, 1)),
  briefed integer not null default 0 check (briefed in (0, 1)),
  seen text check (json_valid(seen)),
  pending text,
  view text check (json_valid(view)),
  unique (session_id, url)
) strict;
create index git_hosts_watches_user on git_hosts_watches (user_id);

create table git_hosts_preferences (
  user_id text primary key references users (id) on delete cascade,
  auto_fix integer not null check (auto_fix in (0, 1)),
  reply integer not null check (reply in (0, 1))
) strict, without rowid;
`;

export const gitHosts: ServerPlugin = {
  name: "git-hosts",
  schema,
  register: (context) => {
    const hosts = hostStore(context.config, context.secretRefs, context.log);

    const connections = connectionStore(context.store);
    const commitAs = commitAsStore(context.store);
    const pending = new Map<string, Pending>();

    const bots = technicalUsers(
      context.config,
      context.secretRefs,
      context.log,
    );

    const actingAs = acting(context, hosts, bots);

    context.auth.gitLogins((userId, session) => {
      const own = connections
        .accounts(userId)
        .filter(({ host }) => hosts.get(host) !== undefined)
        .map(({ host, token }) => ({ host, token }));

      if (session.actsAs !== null) {
        return actingAs.logins(userId, session, own);
      }

      return userId === teamOwner ? actingAs.team(session) : own;
    });

    const connect = async (
      userId: string,
      host: HostConfig,
      token: string,
    ): Promise<void> => {
      const login = await loginOf(host, token);
      connections.save(userId, host.host, login, token);

      context.log("host connected", {
        userId,
        host: host.host,
        login,
      });
    };

    // A host that can't be reached offers nothing, so the others still show.
    const search = async (
      userId: string,
      query: string,
      only?: string,
    ): Promise<readonly HostSearch[]> =>
      Promise.all(
        connections.accounts(userId).flatMap(({ host: name, login, token }) => {
          const host = hosts.get(name);

          return host === undefined || (only !== undefined && only !== name)
            ? []
            : [
                repositoriesOf(host, token, query).then(
                  (repositories): HostSearch => ({ host, login, repositories }),
                  (failure: unknown): HostSearch => {
                    if (!(failure instanceof HostRefused)) {
                      throw failure;
                    }

                    context.log("repository search failed", {
                      host: name,
                      error: failure.message,
                    });

                    return {
                      host,
                      login,
                      repositories: [],
                      failure: failure.message,
                    };
                  },
                ),
              ];
        }),
      );

    const repositories = async (
      userId: string,
      query: string,
    ): Promise<readonly RepositoryChoice[]> =>
      (await search(userId, query)).flatMap(({ host, repositories: found }) =>
        found.map(({ url, name }) => ({ url, name, group: host.label })),
      );

    // Team work reaches only what the team's bots reach (ADR 0060).
    const teamRepositories = async (
      query: string,
    ): Promise<readonly RepositoryChoice[]> =>
      (
        await Promise.all(
          actingAs.teamReach().flatMap(({ host: name, kind, token }) => {
            const host = hosts.get(name);

            if (host === undefined) {
              return [];
            }

            const listed =
              kind === "app"
                ? installationRepositoriesOf(host, token, query)
                : repositoriesOf(host, token, query);

            return [
              listed.then(
                (found) =>
                  found.map(({ url, name: repository }) => ({
                    url,
                    name: repository,
                    group: host.label,
                  })),
                (failure: unknown) => {
                  if (!(failure instanceof HostRefused)) {
                    throw failure;
                  }

                  context.log("team repository search failed", {
                    host: name,
                    error: failure.message,
                  });

                  return [];
                },
              ),
            ];
          }),
        )
      ).flat();

    context.tools.register(
      repositoriesTool({
        accounts: (userId) =>
          connections.accounts(userId).flatMap(({ host: name, login }) => {
            const host = hosts.get(name);

            return host === undefined
              ? []
              : [{ host: host.host, label: host.label, login }];
          }),
        search,
      }),
    );

    const account = (user: User): Account => ({
      admin: user.admin,
      hosts: hosts.list().map(({ host, label, oauth }) => ({
        host,
        label,
        oauth: oauth?.clientSecret !== undefined,
      })),
      connections: connections.of(user.id),
    });

    const start = (request: Request, user: User, name: string): Response => {
      const host = hosts.get(name);
      const oauth = host?.oauth;

      if (host === undefined || oauth?.clientSecret === undefined) {
        return page(`${name} has no sign-in set up.`, 404);
      }

      const now = Date.now();
      for (const [state, each] of pending) {
        if (each.expires < now) {
          pending.delete(state);
        }
      }

      const state = randomBytes(32).toString("base64url");
      const browser = randomBytes(32).toString("base64url");

      pending.set(state, {
        host: host.host,
        userId: user.id,
        browser: hash(browser),
        expires: now + attemptMs,
      });

      return new Response(null, {
        status: 302,
        headers: {
          location: authorizationUrl(
            host,
            oauth,
            `${originOf(request)}/api/ext/git-hosts/callback`,
            state,
          ),
          // Lax, since the host's redirect back is a cross-site navigation,
          // which leaves Strict cookies out.
          "set-cookie": new Bun.Cookie(browserCookie, browser, {
            path: "/api/ext/git-hosts/",
            httpOnly: true,
            sameSite: "lax",
            secure: secure(request),
            maxAge: attemptMs / 1000,
          }).serialize(),
        },
      });
    };

    const callback = async (request: Request): Promise<Response> => {
      const params = new URL(request.url).searchParams;
      const attempt = pending.get(params.get("state") ?? "");
      const host = attempt && hosts.get(attempt.host);

      const browser = new Bun.CookieMap(
        request.headers.get("cookie") ?? "",
      ).get(browserCookie);

      // The state must come back to the browser that left with it, so a
      // link can't connect someone else's account (RFC 6749, 10.12).
      if (
        attempt === undefined ||
        host?.oauth === undefined ||
        attempt.expires < Date.now() ||
        browser === null ||
        hash(browser) !== attempt.browser
      ) {
        return page("This sign-in has expired. Start it again.", 400);
      }

      pending.delete(params.get("state") ?? "");

      const error = params.get("error");
      if (error !== null) {
        return page(
          `${host.host} refused the sign-in: ${params.get("error_description") ?? error}`,
          403,
        );
      }

      try {
        const token = await redeem(
          host,
          host.oauth,
          `${originOf(request)}/api/ext/git-hosts/callback`,
          params.get("code") ?? "",
        );

        await connect(attempt.userId, host, token);
      } catch (failure) {
        if (!(failure instanceof HostRefused)) {
          throw failure;
        }

        context.log("sign-in failed", {
          host: host.host,
          error: failure.message,
        });

        return page(failure.message, 502);
      }

      return redirect("/#settings/accounts");
    };

    // Admins add, change and remove hosts.
    const manage = async (
      request: Request,
      path: readonly string[],
    ): Promise<Response> => {
      const [, name] = path;
      const counts = connections.counts();

      const view = (host: HostConfig): HostView =>
        viewOf(host, counts.get(host.host) ?? 0);

      if (name === undefined && request.method === "GET") {
        return Response.json(hosts.list().map(view));
      }

      if (name === undefined && request.method === "POST") {
        const created = hosts.create(await readBody(request, newHost));
        context.log("host added", { host: created.host });

        return Response.json(view(created), { status: 201 });
      }

      if (name !== undefined && request.method === "DELETE") {
        if (!hosts.remove(name)) {
          throw new NotFound(`no host ${name}`);
        }

        return Response.json({ removed: name });
      }

      if (name !== undefined && request.method === "POST") {
        const updated = hosts.update(name, await readBody(request, hostChange));

        if (updated === undefined) {
          throw new NotFound(`no host ${name}`);
        }

        return Response.json(view(updated));
      }

      throw new NotFound(`no route ${path.join("/")}`);
    };

    // An App's events, from the host (ADR 0060). Each goes to the people who
    // may use the App, as their routines' triggers.
    const hooked = async (
      request: Request,
      hook: string,
    ): Promise<Response> => {
      const app = bots
        .list()
        .find((user) => "app" in user && user.app.hook === hook);

      if (app === undefined || !("app" in app)) {
        return Response.json({ error: "not_found" }, { status: 404 });
      }

      const body = await request.text();

      if (body.length > maxHookBody) {
        return Response.json({ error: "too_large" }, { status: 413 });
      }

      if (
        app.app.webhookSecret === undefined ||
        !signedWith(
          app.app.webhookSecret,
          body,
          request.headers.get("x-hub-signature-256"),
        )
      ) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }

      let payload: unknown;

      try {
        payload = JSON.parse(body);
      } catch {
        return Response.json({ error: "bad_request" }, { status: 400 });
      }

      const event = eventOf(
        app.host,
        request.headers.get("x-github-event") ?? "",
        payload,
      );

      if (event !== undefined) {
        context.events.publish({
          ...event,
          technicalUser: app.name,
          userIds: app.users,
        });
      }

      return Response.json({ ok: true }, { status: 202 });
    };

    const technical = technicalUserRoutes(context, hosts, bots, () => {
      void actingAs.refresh();
    });

    context.auth.handlePublic(async (request, path) => {
      const [route, hook, extra] = path.split("/");

      if (
        route === "hooks" &&
        hook !== undefined &&
        extra === undefined &&
        request.method === "POST"
      ) {
        return hooked(request, hook);
      }

      if (request.method !== "GET") {
        return undefined;
      }

      switch (path) {
        case "callback":
          return callback(request);
        case "app-created":
          return technical.created(request);
        default:
          return undefined;
      }
    });

    const pulls = pullRequests(context, hosts, (userId) =>
      connections
        .accounts(userId)
        .filter(({ host }) => hosts.get(host) !== undefined),
    );

    context.routes.handle(async (request, path, caller) => {
      const parts = path.split("/");
      const answered = await pulls(request, parts, caller);

      if (answered !== undefined) {
        return answered;
      }

      if (caller.kind !== "user") {
        const { actsAs } = caller.session;

        if (parts[0] === "identity" && request.method === "GET") {
          const { startedBy } = caller.session;

          if (actsAs !== null) {
            return Response.json((await actingAs.identity(actsAs)) ?? null);
          }

          return Response.json(
            startedBy === null ? null : commitAs.of(startedBy),
          );
        }

        throw new NotFound(`no route ${path}`);
      }

      const user = context.auth.userOf(request);
      if (user === undefined) {
        throw new HttpError(401, "Sign in again.", "signed_out");
      }

      const [route, name] = parts;

      if (route === "hosts" || route === "technical-users") {
        if (!user.admin) {
          throw new HttpError(
            403,
            "Only admins manage git hosts.",
            "admin_only",
          );
        }

        return route === "hosts"
          ? await manage(request, parts)
          : await technical.manage(request, parts, user.id);
      }

      if (route === "commit-as") {
        if (request.method === "POST") {
          commitAs.choose(user.id, await readBody(request, commitAsBody));
        }

        return Response.json(commitAs.of(user.id));
      }

      if (route === "account" && request.method === "GET") {
        return Response.json(account(user));
      }

      if (route === "repositories" && request.method === "GET") {
        const { searchParams } = new URL(request.url);
        const query = searchParams.get("q")?.trim() ?? "";

        return Response.json(
          searchParams.has("team")
            ? await teamRepositories(query)
            : await repositories(user.id, query),
        );
      }

      if (route === "sign-in" && name !== undefined) {
        return start(request, user, name);
      }

      if (route === "connect" && request.method === "POST") {
        const { host, token } = await readBody(request, connection);
        const listed = hosts.get(host);

        if (listed === undefined) {
          throw new BadRequest("that host isn't listed");
        }

        if (token.trim() === "") {
          throw new BadRequest("paste a personal access token");
        }

        await connect(user.id, listed, token.trim()).catch(
          (failure: unknown) => {
            throw failure instanceof HostRefused
              ? new BadRequest(failure.message)
              : failure;
          },
        );

        return Response.json(account(user));
      }

      if (
        route === "connections" &&
        name !== undefined &&
        request.method === "DELETE"
      ) {
        const host = decodeURIComponent(name);
        connections.remove(user.id, host);
        context.log("host disconnected", { userId: user.id, host });

        return Response.json(account(user));
      }

      throw new NotFound(`no route ${path}`);
    });
  },
};

interface Signed {
  readonly host: string;
  readonly login: string;
  readonly token: string;
}

interface ConnectionStore {
  readonly of: (userId: string) => readonly Connection[];
  readonly accounts: (userId: string) => readonly Signed[];
  readonly save: (
    userId: string,
    host: string,
    login: string,
    token: string,
  ) => void;
  readonly remove: (userId: string, host: string) => void;
  // How many people connected on each host.
  readonly counts: () => ReadonlyMap<string, number>;
}

// A connection is state people create as they go, so it lives in SQLite,
// with its token sealed for its user and host (ADR 0039).
function connectionStore(store: PluginStore): ConnectionStore {
  const rows = (
    userId: string,
  ): readonly {
    host: string;
    login: string;
    token: string;
    connected_at: number;
  }[] =>
    store.all(
      `select host, login, token, connected_at from git_hosts_connections where user_id = ? order by host`,
      userId,
    ) as { host: string; login: string; token: string; connected_at: number }[];

  return {
    of: (userId) =>
      rows(userId).map((row) => ({
        host: row.host,
        login: row.login,
        connectedAt: new Date(row.connected_at).toISOString(),
      })),
    // A token sealed under another server key can't be opened, and its
    // Sessions go without it, as if it weren't connected.
    accounts: (userId) =>
      rows(userId).flatMap(({ host, login, token }) => {
        try {
          return [
            { host, login, token: store.open(token, `${userId} ${host}`) },
          ];
        } catch {
          return [];
        }
      }),
    save: (userId, host, login, token) => {
      store.run(
        `insert into git_hosts_connections (user_id, host, login, token, connected_at) values (?, ?, ?, ?, ?) on conflict (user_id, host) do update set login = excluded.login, token = excluded.token, connected_at = excluded.connected_at`,
        userId,
        host,
        login,
        store.seal(token, `${userId} ${host}`),
        Date.now(),
      );
    },
    remove: (userId, host) => {
      store.run(
        `delete from git_hosts_connections where user_id = ? and host = ?`,
        userId,
        host,
      );
    },
    counts: () =>
      new Map(
        (
          store.all(
            `select host, count(*) as people from git_hosts_connections group by host`,
          ) as { host: string; people: number }[]
        ).map(({ host, people }) => [host, people]),
      ),
  };
}
