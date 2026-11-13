import { randomBytes } from "node:crypto";
import {
  BadRequest,
  defineServer,
  NotFound,
  owners,
  type Person,
  type Secrets,
  type Store,
  Type,
  Unreachable,
} from "@pipoca/plugins";
import type {
  GitLogin,
  Owner,
  RepositoryChoice,
  Session,
} from "@pipoca/protocol";
import { gitHosts } from "../plugin";
import { acting } from "./acting";
import { hostActions } from "./actions";
import { appEvents } from "./app-events";
import { commitAsBody, commitAsStore } from "./commit-as";
import {
  authorizationUrl,
  emailsOf,
  hostCall,
  HostRefused,
  installationRepositoriesOf,
  loginOf,
  redeem,
  repositoriesOf,
} from "./github";
import {
  type HostConfig,
  hostChange,
  hosts as hostList,
  newHost,
  viewOf,
} from "./hosts";
import type {
  Account,
  CommitIdentities,
  Connection,
  HostEmails,
  HostView,
  Reach,
} from "./model";
import { backTo, page, redirect, then } from "./pages";
import { pullRequests } from "./pull-requests";
import { questionReplies } from "./questions";
import { setupRoutes } from "./setup";
import { technicalUserRoutes } from "./technical-user-routes";
import { isApp } from "./technical-users";
import { type HostSearch, repositoriesTool } from "./tool";

// GitHub sends at most 25 MB, but the events taken from a webhook are small.
const maxHookBytes = 5 * 1024 * 1024;

// A browser has this long to come back from the host.
const attemptMs = 10 * 60_000;

interface Pending {
  readonly host: string;
  readonly userId: string;
  readonly browser: string;
  readonly expires: number;
  readonly back: string;
}

const connection = Type.Object({ host: Type.String(), token: Type.String() });

const callbackQuery = Type.Object({
  state: Type.Optional(Type.String()),
  code: Type.Optional(Type.String()),
  error: Type.Optional(Type.String()),
  error_description: Type.Optional(Type.String()),
});

export const server = defineServer(gitHosts, (context) => {
  const { routes, config, urls, clock, log } = context;
  const hosts = hostList(config.collection("hosts"));
  const bots = config.collection("technicalUsers");
  const connections = connectionStore(context.store, context.secrets, clock);
  const commitAs = commitAsStore(context.store);
  const pending = new Map<string, Pending>();
  const actingAs = acting(context, hosts, bots);
  const callback = (): string => urls.public("callback");

  // The person's connections on the hosts still listed.
  const signed = (userId: string): readonly Signed[] =>
    connections
      .accounts(userId)
      .filter(({ host }) => hosts.get(host) !== undefined);

  const heard = appEvents(
    context,
    hosts,
    bots,
    actingAs.installations,
    questionReplies(context, hosts, actingAs, signed),
  );

  // Who the Session's git signs in as on each host, which is also who the
  // actions it proposes write as.
  const loginsOf = (
    owner: Owner,
    session: Pick<Session, "actsAs" | "proposes" | "workspace">,
  ): readonly GitLogin[] => {
    const person = owners.personId(owner);

    const own: readonly GitLogin[] =
      person === undefined
        ? []
        : signed(person).map(({ host, token }) => ({ host, token }));

    if (session.actsAs !== null) {
      return actingAs.logins(owner, session, own);
    }

    return owner === "team" ? actingAs.team(session) : own;
  };

  context.provide.gitCredentials((owner, session) => {
    const logins = loginsOf(owner, session);

    return session.proposes ? actingAs.readOnly(logins) : logins;
  });

  const connect = async (
    userId: string,
    host: HostConfig,
    token: string,
  ): Promise<void> => {
    const login = await loginOf(
      hostCall(host, context.network, {
        owner: owners.of(userId),
        action: "sign-in check",
      }),
      token,
    );

    connections.save(userId, host.host, login, token);
    log("host connected", { userId, host: host.host, login });
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
              repositoriesOf(
                hostCall(host, context.network, {
                  owner: owners.of(userId),
                  action: "repo picker search",
                }),
                token,
                query,
              ).then(
                (repositories): HostSearch => ({ host, login, repositories }),
                (failure: unknown): HostSearch => {
                  if (!(
                    failure instanceof HostRefused ||
                    failure instanceof Unreachable
                  )) {
                    throw failure;
                  }

                  log("repository search failed", {
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

          const call = hostCall(host, context.network, {
            owner: "team",
            action: "team repo picker search",
          });

          const listed =
            kind === "app"
              ? installationRepositoriesOf(call, token, query)
              : repositoriesOf(call, token, query);

          return [
            listed.then(
              (found) =>
                found.map(({ url, name: repository }) => ({
                  url,
                  name: repository,
                  group: host.label,
                })),
              (failure: unknown) => {
                if (!(
                  failure instanceof HostRefused ||
                  failure instanceof Unreachable
                )) {
                  throw failure;
                }

                log("team repository search failed", {
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

  context.tools.define(
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

  // A person's calls go only through their own Environments, the team's
  // only through team ones (ADR 0080).
  const reachOf = (host: string, ownerId: string): Reach => ({
    private: context.network.privateHost(`https://${host}/`) !== undefined,
    through: context.environments
      .list()
      .filter(
        ({ ownerId: owner, reaches }) =>
          owner === ownerId &&
          reaches.some((each) => each.reached && each.host === host),
      )
      .map(({ name, online }) => ({ name, online })),
  });

  const account = (person: Person): Account => ({
    admin: person.admin,
    hosts: hosts.list().map(({ host, label, oauth }) => ({
      host,
      label,
      oauth: oauth?.clientSecret !== undefined,
      reach: reachOf(host, person.id),
    })),
    connections: connections.of(person.id),
  });

  routes.get("account", { auth: "person" }, ({ caller }) =>
    account(caller.person),
  );

  routes.get(
    "repositories",
    { auth: "person", team: true, query: Type.Object({ q: Type.String() }) },
    async ({ caller, query }): Promise<readonly RepositoryChoice[]> => {
      const typed = query.q.trim();

      if (caller.owner === "team") {
        return teamRepositories(typed);
      }

      return (await search(caller.person.id, typed)).flatMap(
        ({ host, repositories: found }) =>
          found.map(({ url, name }) => ({ url, name, group: host.label })),
      );
    },
  );

  routes.post(
    "connect",
    { auth: "person", body: connection, changes: ["account"] },
    async ({ caller, body }) => {
      const listed = hosts.get(body.host);

      if (listed === undefined) {
        throw new BadRequest("that host isn't listed");
      }

      if (body.token.trim() === "") {
        throw new BadRequest("paste a personal access token");
      }

      await connect(caller.person.id, listed, body.token.trim()).catch(
        (failure: unknown) => {
          throw failure instanceof HostRefused
            ? new BadRequest(failure.message)
            : failure;
        },
      );

      return account(caller.person);
    },
  );

  routes.delete(
    "connections/:host",
    { auth: "person", changes: ["account"] },
    ({ caller, params }) => {
      connections.remove(caller.person.id, params.host);
      log("host disconnected", { userId: caller.person.id, host: params.host });

      return account(caller.person);
    },
  );

  routes.get("commit-as", { auth: "person" }, ({ caller }): CommitIdentities =>
    commitAs.all(caller.person.id),
  );

  routes.post(
    "commit-as",
    { auth: "person", body: commitAsBody, changes: ["commit-as"] },
    ({ caller, body }): CommitIdentities => {
      const { host, ...identity } = body;
      commitAs.choose(caller.person.id, host, identity);

      return commitAs.all(caller.person.id);
    },
  );

  // What the person can commit as on a host they connected.
  routes.get(
    "emails/:host",
    { auth: "person" },
    async ({ caller, params }): Promise<HostEmails> => {
      const host = hosts.get(params.host);

      const signedIn = connections
        .accounts(caller.person.id)
        .find((each) => each.host === params.host);

      if (host === undefined || signedIn === undefined) {
        throw new NotFound(`connect ${params.host} first`);
      }

      return emailsOf(
        hostCall(host, context.network, {
          owner: caller.owner,
          action: "commit emails",
        }),
        signedIn.token,
      ).catch((failure: unknown) => {
        throw failure instanceof HostRefused
          ? new BadRequest(failure.message)
          : failure;
      });
    },
  );

  // Who a Session commits as: the technical user it acts as (ADR 0060), or
  // the name and email its person chose for the repository's host.
  routes.get(
    "identity",
    {
      auth: "session",
      query: Type.Object({ host: Type.Optional(Type.String()) }),
    },
    async ({ caller, query }) => {
      const { actsAs, startedBy } = caller.session;

      if (actsAs !== null) {
        return (await actingAs.identity(actsAs.name)) ?? null;
      }

      return startedBy === null
        ? null
        : commitAs.of(startedBy, query.host?.toLowerCase());
    },
  );

  // Admins add, change and remove hosts.
  const view = (host: HostConfig): HostView =>
    viewOf(
      host,
      connections.counts().get(host.host) ?? 0,
      reachOf(host.host, "team"),
    );

  routes.get("hosts", { auth: "admin" }, () => hosts.list().map(view));

  routes.post(
    "hosts",
    {
      auth: "admin",
      body: newHost,
      status: 201,
      changes: ["hosts", "account"],
    },
    ({ body }) => {
      const created = hosts.create(body);
      log("host added", { host: created.host });

      return view(created);
    },
  );

  routes.post(
    "hosts/:host",
    { auth: "admin", body: hostChange, changes: ["hosts", "account"] },
    ({ params, body }) => view(hosts.update(params.host, body)),
  );

  routes.delete(
    "hosts/:host",
    { auth: "admin", changes: ["hosts", "account"] },
    ({ params }) => {
      hosts.remove(params.host);
      log("host removed", { host: params.host });

      return { removed: params.host };
    },
  );

  // The person's browser goes to the host's sign-in, and comes back to the
  // callback with a code.
  routes.get(
    "sign-in/:host",
    { auth: "person", query: Type.Object({ then }) },
    ({ caller, params, query }) => {
      const host = hosts.get(params.host);
      const oauth = host?.oauth;

      if (host === undefined || oauth?.clientSecret === undefined) {
        return page(`${params.host} has no sign-in set up.`, 404);
      }

      const now = clock.now();

      for (const [state, each] of pending) {
        if (each.expires < now) {
          pending.delete(state);
        }
      }

      const state = randomBytes(32).toString("base64url");

      const response = new Response(null, {
        status: 302,
        headers: {
          location: authorizationUrl(host, oauth, callback(), state),
        },
      });

      pending.set(state, {
        host: host.host,
        userId: caller.person.id,
        browser: urls.browser.mark(response, attemptMs),
        expires: now + attemptMs,
        back: backTo(query.then, "/#settings/accounts"),
      });

      return response;
    },
  );

  routes.get(
    "callback",
    { auth: "public", query: callbackQuery },
    async ({ caller, query, raw }) => {
      const state = query.state ?? "";
      const attempt = pending.get(state);
      const host = attempt && hosts.get(attempt.host);

      // The state must come back to the browser that left with it, so a
      // link can't connect someone else's account (RFC 6749, 10.12). The
      // host's redirect is cross-site, so the session cookie may stay
      // behind, but a browser signed in as someone else is refused.
      if (
        attempt === undefined ||
        host?.oauth === undefined ||
        attempt.expires < clock.now() ||
        !urls.browser.is(raw, attempt.browser) ||
        (caller.person !== undefined && caller.person.id !== attempt.userId)
      ) {
        return page("This sign-in has expired. Start it again.", 400);
      }

      pending.delete(state);

      if (query.error !== undefined) {
        return page(
          `${host.host} refused the sign-in: ${query.error_description ?? query.error}`,
          403,
        );
      }

      try {
        const token = await redeem(
          hostCall(host, context.network, {
            owner: owners.of(attempt.userId),
            action: "OAuth sign-in",
          }),
          host.oauth,
          callback(),
          query.code ?? "",
        );

        await connect(attempt.userId, host, token);
      } catch (failure) {
        if (!(
          failure instanceof HostRefused || failure instanceof Unreachable
        )) {
          throw failure;
        }

        log("sign-in failed", { host: host.host, error: failure.message });

        return page(failure.message, 502);
      }

      routes.topic("account");

      return redirect(attempt.back);
    },
  );

  // An App's events, from the host (ADR 0060). Each goes to the people who
  // may use the App, as their routines' triggers.
  const appOf = (hook: string) =>
    bots.list().find(({ app }) => app?.hook === hook);

  routes.post(
    "hooks/:hook",
    {
      auth: {
        webhook: {
          secret: ({ hook = "" }) => appOf(hook)?.app?.webhookSecret,
          maxBytes: maxHookBytes,
        },
      },
      status: 202,
    },
    async ({ params, raw }) => {
      const app = appOf(params.hook);

      if (app === undefined || !isApp(app)) {
        throw new NotFound(`no App sends ${params.hook}`);
      }

      let payload: unknown;

      try {
        payload = await raw.json();
      } catch {
        throw new BadRequest("the body isn't JSON");
      }

      heard(app, raw.headers.get("x-github-event") ?? "", payload);

      return { ok: true };
    },
  );

  technicalUserRoutes(context, hosts, bots, actingAs.refresh);

  setupRoutes(context, hosts, (userId) =>
    connections.of(userId).map(({ host }) => host),
  );

  const watching = pullRequests(context, hosts, signed, actingAs.teamBots);

  hostActions(context, hosts, loginsOf, watching.watch);
});

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

const table = "git_hosts_connections";

// A connection is state people create as they go, so it lives in SQLite,
// with its token sealed for its user and host (ADR 0039).
function connectionStore(
  store: Store,
  secrets: Secrets,
  clock: { readonly now: () => number },
): ConnectionStore {
  const rows = (userId: string) =>
    store.all<{
      host: string;
      login: string;
      token: string;
      connected_at: number;
    }>(
      `select host, login, token, connected_at from ${table} where user_id = ? order by host`,
      userId,
    );

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
            {
              host,
              login,
              token: secrets.open(table, `${userId} ${host}`, token),
            },
          ];
        } catch {
          return [];
        }
      }),
    save: (userId, host, login, token) => {
      store.run(
        `insert into ${table} (user_id, host, login, token, connected_at) values (?, ?, ?, ?, ?) on conflict (user_id, host) do update set login = excluded.login, token = excluded.token, connected_at = excluded.connected_at`,
        userId,
        host,
        login,
        secrets.seal(table, `${userId} ${host}`, token),
        clock.now(),
      );
    },
    remove: (userId, host) => {
      store.run(
        `delete from ${table} where user_id = ? and host = ?`,
        userId,
        host,
      );
    },
    counts: () =>
      new Map(
        store
          .all<{ host: string; people: number }>(
            `select host, count(*) as people from ${table} group by host`,
          )
          .map(({ host, people }) => [host, people]),
      ),
  };
}
