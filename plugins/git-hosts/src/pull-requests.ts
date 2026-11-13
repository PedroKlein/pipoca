import {
  BadRequest,
  NotFound,
  owners,
  type ServerContext,
  ToolError,
  Type,
} from "@pipoca/plugins";
import type { Session } from "@pipoca/protocol";
import type { gitHosts } from "../plugin";
import type { TeamBot } from "./acting";
import { hostCall, HostRefused } from "./github";
import type { Hosts } from "./hosts";
import type { PullWatch, WatchedPull } from "./model";
import { type Account, startPoller } from "./poller";
import { mergePull, pullRefOf } from "./pulls";
import { type Watch, watchStore } from "./watch";

const watchBody = Type.Object({ url: Type.String() });
const autoFixBody = Type.Object({ on: Type.Boolean() });

const preferencesBody = Type.Object({
  autoFix: Type.Boolean(),
  reply: Type.Boolean(),
});

const urlParams = Type.Object({
  url: Type.String({
    description:
      "The pull request's address, such as https://github.com/owner/name/pull/12",
  }),
});

const noBot = (host: string): string =>
  `No team bot is marked for ${host}. An admin can mark a GitHub App or technical user for team work in Settings > Git hosts.`;

// Watches the pull requests Sessions open and tells each Session its news
// (ADR 0051).
export function pullRequests(
  context: ServerContext<typeof gitHosts>,
  hosts: Hosts,
  accounts: (userId: string) => readonly Account[],
  teamBots: (session: Session) => readonly TeamBot[],
): { readonly watch: (session: Session, url: string) => void } {
  const { routes, tools, sessions, log } = context;
  const watches = watchStore(context.store);

  // Team work polls and merges as the team's bot on the host, never with a
  // person's token (ADR 0066, ADR 0071).
  const accountOf = (watch: Watch): Account | string => {
    const session = sessions.get(watch.sessionId);

    if (watch.userId !== null) {
      return (
        accounts(watch.userId).find(({ host }) => host === watch.host) ??
        `Connect ${watch.host} first.`
      );
    }

    const bot =
      session && teamBots(session).find(({ host }) => host === watch.host);

    if (bot === undefined) {
      return noBot(watch.host);
    }

    return bot.token === undefined
      ? `${bot.login} isn't installed where ${watch.repository} lives.`
      : { host: bot.host, login: bot.login, token: bot.token };
  };

  const poller = startPoller(watches, hosts, accountOf, context);

  // A person's watch is theirs, and team work's is whoever steers its
  // Session's.
  const mayUse = (watch: Watch, person: string): boolean =>
    watch.userId === null
      ? sessions.steers(watch.sessionId, person)
      : watch.userId === person;

  const watch = (session: Session, url: string): Watch => {
    const team = session.ownedBy === "team";
    const userId = team ? null : session.startedBy;

    if (!team && userId === null) {
      throw new BadRequest("only a Session a person started can watch");
    }

    const ref = pullRefOf(url.trim());

    if (ref === undefined) {
      throw new BadRequest(`${url} isn't a pull request's address`);
    }

    if (hosts.get(ref.host) === undefined) {
      throw new BadRequest(`${ref.host} isn't one of the git hosts`);
    }

    if (team && !teamBots(session).some(({ host }) => host === ref.host)) {
      throw new BadRequest(noBot(ref.host));
    }

    const added = watches.add(
      session.id,
      userId,
      url.trim(),
      ref,
      userId === null || watches.preferences(userId).autoFix,
    );

    routes.topic("pull-requests");
    poller.soon(added.id);

    return added;
  };

  tools.define({
    name: "git_hosts_watch",
    description:
      "Watch a pull request: Pipoca tells this Session when its checks fail, someone reviews it, it conflicts, or it merges. Pull requests opened with /pr are watched already.",
    annotations: { destructive: false },
    params: urlParams,
    when: { owner: "any" },
    exposure: "direct",
    run: ({ url }, { session }) => {
      const added = watch(session, url);

      return added.autoFix
        ? `Watching ${added.url}. Its news will come here.`
        : `Watching ${added.url}. Auto-fix is off for it, so its news shows only on the Changes card until the user turns it on.`;
    },
  });

  tools.define({
    name: "git_hosts_unwatch",
    description: "Stop watching a pull request in this Session.",
    annotations: { destructive: false },
    params: urlParams,
    when: { owner: "any" },
    exposure: "direct",
    run: ({ url }, { session }) => {
      const found = watches
        .ofSession(session.id)
        .find((each) => each.url === url.trim());

      if (found === undefined) {
        throw new ToolError(`this Session doesn't watch ${url}`);
      }

      watches.remove(found.id);
      routes.topic("pull-requests");

      return `Stopped watching ${found.url}.`;
    },
  });

  // The Session part watches what /pr opened.
  routes.post(
    "pull-requests",
    { auth: "session", body: watchBody, status: 201 },
    ({ caller, body }) => watch(caller.session, body.url).view,
  );

  routes.get("preferences", { auth: "person" }, ({ caller }) =>
    watches.preferences(caller.person.id),
  );

  routes.post(
    "preferences",
    { auth: "person", body: preferencesBody, changes: ["preferences"] },
    ({ caller, body }) => {
      watches.prefer(caller.person.id, body);

      return watches.preferences(caller.person.id);
    },
  );

  routes.get(
    "pull-requests",
    { auth: "person", query: Type.Object({ session: Type.String() }) },
    ({ caller, query }) =>
      watches
        .ofSession(query.session)
        .filter((each) => mayUse(each, caller.person.id))
        .map(({ view }): PullWatch => view),
  );

  // What the caller's own Sessions watch, or on the team half what team
  // work watches, for the team hub.
  routes.get("watched", { auth: "person", team: true }, ({ caller }) =>
    watches
      .all()
      .filter(
        ({ sessionId }) => sessions.get(sessionId)?.ownedBy === caller.owner,
      )
      .map(({ view, repository }): WatchedPull => ({ ...view, repository })),
  );

  const owned = (id: string, userId: string): Watch => {
    const found = watches.get(id);

    if (found === undefined || !mayUse(found, userId)) {
      throw new NotFound(`no watched pull request ${id}`);
    }

    return found;
  };

  routes.post(
    "pull-requests/:id/auto-fix",
    { auth: "person", body: autoFixBody, changes: ["pull-requests"] },
    ({ caller, params, body }) => {
      const found = owned(params.id, caller.person.id);

      watches.update(found.id, { autoFix: body.on });

      return { ...found.view, autoFix: body.on };
    },
  );

  routes.post(
    "pull-requests/:id/merge",
    { auth: "person", changes: ["pull-requests"] },
    async ({ caller, params }) => {
      const userId = caller.person.id;
      const found = owned(params.id, userId);
      const host = hosts.get(found.host);
      const account = accountOf(found);

      if (host === undefined) {
        throw new BadRequest(`${found.host} isn't one of the git hosts`);
      }

      if (typeof account === "string") {
        throw new BadRequest(account);
      }

      try {
        await mergePull(
          hostCall(host, context.network, {
            owner: owners.fromSql(found.userId),
            action: "pull request merge",
          }),
          account.token,
          found,
        );
      } catch (failure) {
        throw failure instanceof HostRefused
          ? new BadRequest(failure.message)
          : failure;
      }

      log("pull request merged", {
        url: found.url,
        owner: owners.fromSql(found.userId),
        by: owners.of(userId),
      });

      await poller.poll(found.id);

      return { merged: found.url };
    },
  );

  return {
    watch: (session, url) => {
      watch(session, url);
    },
  };
}
