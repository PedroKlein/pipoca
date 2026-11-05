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
import { HostRefused } from "./github";
import type { Hosts } from "./hosts";
import type { PullWatch } from "./model";
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

// Watches the pull requests Sessions open and tells each Session its news
// (ADR 0051).
export function pullRequests(
  context: ServerContext<typeof gitHosts>,
  hosts: Hosts,
  accounts: (userId: string) => readonly Account[],
): void {
  const { routes, tools, log } = context;
  const watches = watchStore(context.store);
  const poller = startPoller(watches, hosts, accounts, context);

  const watch = (session: Session, url: string): Watch => {
    const userId = session.startedBy;

    if (userId === null || session.ownedBy === "team") {
      throw new BadRequest("only a Session a person started can watch");
    }

    const ref = pullRefOf(url.trim());

    if (ref === undefined) {
      throw new BadRequest(`${url} isn't a pull request's address`);
    }

    if (hosts.get(ref.host) === undefined) {
      throw new BadRequest(`${ref.host} isn't one of the git hosts`);
    }

    const added = watches.add(
      session.id,
      userId,
      url.trim(),
      ref,
      watches.preferences(userId).autoFix,
    );

    routes.topic("pull-requests");
    poller.soon(added.id);

    return added;
  };

  // A person's git accounts never serve team work (ADR 0066).
  tools.define({
    name: "git_hosts_watch",
    description:
      "Watch a pull request: Pipoca tells this Session when its checks fail, someone reviews it, it conflicts, or it merges. Pull requests opened with /pr are watched already.",
    params: urlParams,
    when: { owner: "person" },
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
    params: urlParams,
    when: { owner: "person" },
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
        .filter((each) => each.userId === caller.person.id)
        .map(({ view }): PullWatch => view),
  );

  const owned = (id: string, userId: string): Watch => {
    const found = watches.get(id);

    if (found?.userId !== userId) {
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

      const account = accounts(userId).find(
        ({ host: name }) => name === found.host,
      );

      if (host === undefined || account === undefined) {
        throw new BadRequest(`connect ${found.host} first`);
      }

      try {
        await mergePull(host, account.token, found);
      } catch (failure) {
        throw failure instanceof HostRefused
          ? new BadRequest(failure.message)
          : failure;
      }

      log("pull request merged", {
        url: found.url,
        owner: owners.of(userId),
      });

      await poller.poll(found.id);

      return { merged: found.url };
    },
  );
}
