import {
  BadRequest,
  NotFound,
  readBody,
  type RouteCaller,
  type ServerPluginContext,
  type ServerTool,
  Type,
} from "@pipoca/plugins";
import type { Session } from "@pipoca/protocol";
import { HostRefused } from "./github";
import type { HostStore } from "./hosts";
import type { PullWatch } from "./model";
import { startPoller } from "./poller";
import { mergePull, pullRefOf } from "./pulls";
import { type Watch, watchStore } from "./watch";

interface Account {
  readonly host: string;
  readonly login: string;
  readonly token: string;
}

const watchBody = Type.Object({ url: Type.String() });
const autoFixBody = Type.Object({ on: Type.Boolean() });

const preferencesBody = Type.Object({
  autoFix: Type.Boolean(),
  reply: Type.Boolean(),
});

// Routes a user or a Session reaches, under pull-requests and preferences.
export type PullRoutes = (
  request: Request,
  parts: readonly string[],
  caller: RouteCaller,
) => Promise<Response | undefined>;

// Watches the pull requests Sessions open and tells each Session its news
// (ADR 0051).
export function pullRequests(
  context: ServerPluginContext,
  hosts: HostStore,
  accounts: (userId: string) => readonly Account[],
): PullRoutes {
  const watches = watchStore(context.store);
  const poller = startPoller(watches, hosts, accounts, context);

  const watch = (session: Session, url: string): Watch => {
    const userId = session.startedBy;
    if (userId === null) {
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

    context.changes.publish("pull-requests");

    void poller.poll(added.id).catch((failure: unknown) => {
      context.log("first pull request poll failed", {
        url: added.url,
        error: String(failure),
      });
    });

    return added;
  };

  const sessionTool = (
    name: string,
    description: string,
    run: (session: Session, url: string) => string,
  ): ServerTool => {
    const answer = (session: Session, url: string) => {
      try {
        return { text: run(session, url), isError: false };
      } catch (failure) {
        return {
          text: failure instanceof Error ? failure.message : String(failure),
          isError: true,
        };
      }
    };

    return {
      name,
      description,
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description:
              "The pull request's address, such as https://github.com/owner/name/pull/12",
          },
        },
        required: ["url"],
        additionalProperties: false,
      },
      exposure: "direct",
      annotations: { readOnlyHint: false, destructiveHint: false },
      appliesTo: ({ startedBy }) => startedBy !== null,
      run: async (input, { session }) => {
        const { url } = (input ?? {}) as { url?: unknown };

        return Promise.resolve(
          answer(session, typeof url === "string" ? url : ""),
        );
      },
    };
  };

  context.tools.register(
    sessionTool(
      "git_hosts_watch",
      "Watch a pull request: Pipoca tells this Session when its checks fail, someone reviews it, it conflicts, or it merges. Pull requests opened with /pr are watched already.",
      (session, url) => {
        const added = watch(session, url);

        return added.autoFix
          ? `Watching ${added.url}. Its news will come here.`
          : `Watching ${added.url}. Auto-fix is off for it, so its news shows only on the Changes card until the user turns it on.`;
      },
    ),
  );

  context.tools.register(
    sessionTool(
      "git_hosts_unwatch",
      "Stop watching a pull request in this Session.",
      (session, url) => {
        const found = watches
          .ofSession(session.id)
          .find((each) => each.url === url.trim());

        if (found === undefined) {
          throw new Error(`this Session doesn't watch ${url}`);
        }

        watches.remove(found.id);
        context.changes.publish("pull-requests");

        return `Stopped watching ${found.url}.`;
      },
    ),
  );

  const owned = (id: string, userId: string): Watch => {
    const found = watches.get(id);
    if (found?.userId !== userId) {
      throw new NotFound(`no watched pull request ${id}`);
    }

    return found;
  };

  return async (request, [route, id, action], caller) => {
    if (caller.kind === "session") {
      if (
        route === "pull-requests" &&
        id === undefined &&
        request.method === "POST"
      ) {
        const { url } = await readBody(request, watchBody);

        return Response.json(watch(caller.session, url).view, { status: 201 });
      }

      return undefined;
    }

    const userId = caller.actor.slice("user:".length);

    if (route === "preferences") {
      if (request.method === "POST") {
        watches.prefer(userId, await readBody(request, preferencesBody));
      }

      return Response.json(watches.preferences(userId));
    }

    if (route !== "pull-requests") {
      return undefined;
    }

    if (id === undefined && request.method === "GET") {
      const sessionId = new URL(request.url).searchParams.get("session") ?? "";

      return Response.json(
        watches
          .ofSession(sessionId)
          .filter((each) => each.userId === userId)
          .map(({ view }): PullWatch => view),
      );
    }

    if (
      id !== undefined &&
      action === "auto-fix" &&
      request.method === "POST"
    ) {
      const found = owned(id, userId);
      const { on } = await readBody(request, autoFixBody);

      watches.update(found.id, { autoFix: on, pending: null });
      context.changes.publish("pull-requests");

      return Response.json({ ...found.view, autoFix: on });
    }

    if (id !== undefined && action === "merge" && request.method === "POST") {
      const found = owned(id, userId);
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

      context.log("pull request merged", { url: found.url, userId });
      await poller.poll(found.id);

      return Response.json({ merged: found.url });
    }

    return undefined;
  };
}
