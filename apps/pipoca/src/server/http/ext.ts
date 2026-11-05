import {
  type Caller,
  Forbidden,
  HttpError,
  NotFound,
  owners,
  type Person,
} from "@pipoca/plugins";
import type { ExtRoute } from "@pipoca/pluginhost";
import type { People } from "@pipoca/people";
import type { Auth, RouteSpec } from "@pipoca/protocol";
import type { Sessions } from "@pipoca/sessions";
import type { AnyCaller, Callers, Route } from "./router";

// Kept apart from the Session id that the runner's prefix names :id.
const param = "ext.";

// Each route a plugin defined, under /api/ext/<plugin> for people, admins,
// anyone and webhooks, and under the runner's prefix for its Session part.
export function extRoutes(
  declared: readonly ExtRoute[],
  deps: {
    readonly people: People;
    readonly sessions: Sessions;
    readonly callers: Callers;
  },
): Route[] {
  const personOf = (id: string, admin: boolean): Person | undefined => {
    const user = deps.people.userById(id);

    return user && { id, name: user.name, admin };
  };

  const callerOf = (
    caller: AnyCaller,
    request: Request,
    params: Readonly<Record<string, string>>,
  ): Caller => {
    if (!("kind" in caller)) {
      const session = deps.sessions.get(params["id"] ?? "");

      if (session === undefined) {
        throw new NotFound("Not found.");
      }

      const person =
        session.startedBy === null
          ? undefined
          : personOf(session.startedBy, false);

      return {
        kind: "session",
        session,
        owner: session.ownedBy,
        ...(person && { person }),
      };
    }

    if (caller.kind === "person") {
      const person = personOf(caller.id, caller.admin);

      if (person === undefined) {
        throw new HttpError(401, "Sign in again.", "signed_out");
      }

      return { kind: "person", person, owner: owners.of(person) };
    }

    const signedIn = deps.callers.person(request);
    const person = signedIn && personOf(signedIn.id, signedIn.admin);

    return { kind: "public", ...(person && { person }) };
  };

  return declared.flatMap((route) => {
    const { auth } = route.spec;
    const api = mounted(`/api/ext/${route.plugin}`, route.path);

    const runner = mounted(
      `/runner/sessions/:id/ext/${route.plugin}`,
      route.path,
    );

    const serve = (path: string, as: Auth): Route => ({
      spec: specOf(route, path, as),
      handler: (context) =>
        route.handler({
          caller: callerOf(context.caller, context.request, context.params),
          params: ownParams(context.params),
          body: context.body,
          query: context.query,
          raw: context.request,
        }),
      ...(typeof auth === "object" && {
        secret: (params) => auth.webhook.secret(ownParams(params)),
      }),
    });

    if (auth === "person") {
      return [
        serve(api, "person"),
        {
          spec: { method: route.method, path: runner, auth: "session" },
          handler: () => {
            throw new Forbidden("Only people call this.", "people_only");
          },
        },
      ];
    }

    if (auth === "session") {
      return [
        serve(runner, "session"),
        {
          spec: { method: route.method, path: api, auth: "public" },
          handler: () => {
            throw new Forbidden(
              "Only the plugin's Sessions call this.",
              "sessions_only",
            );
          },
        },
      ];
    }

    if (typeof auth === "object") {
      const { header, maxBytes } = auth.webhook;

      return [
        serve(api, {
          webhook: {
            ...(header !== undefined && { header }),
            ...(maxBytes !== undefined && { maxBytes }),
          },
        }),
      ];
    }

    return [serve(api, auth)];
  });
}

function specOf(route: ExtRoute, path: string, auth: Auth): RouteSpec {
  const { body, query, response, status, changes, long } = route.spec;

  return {
    method: route.method,
    path,
    auth,
    ...(body !== undefined && { body }),
    ...(query !== undefined && { query }),
    ...(response !== undefined && { response }),
    ...(status !== undefined && { status }),
    ...(changes !== undefined && {
      changes: changes.map((name) => `${route.plugin}.${name}`),
    }),
    ...(long !== undefined && { long }),
  };
}

function mounted(prefix: string, path: string): string {
  return [
    prefix,
    ...path
      .split("/")
      .filter((part) => part !== "")
      .map((part) =>
        part.startsWith(":") || part.startsWith("*")
          ? `${part.charAt(0)}${param}${part.slice(1)}`
          : part,
      ),
  ].join("/");
}

function ownParams(
  params: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(params).flatMap(([name, value]) =>
      name.startsWith(param) ? [[name.slice(param.length), value]] : [],
    ),
  );
}
