import {
  type Caller,
  NotFound,
  type Params,
  type Routes,
  type RouteSpec,
  type ScopedRoutes,
  type Urls,
} from "@pipoca/plugins";
import type { Method, Owner } from "@pipoca/protocol";

export interface ExtInput {
  readonly caller: Caller;
  readonly params: Params;
  readonly body: unknown;
  readonly query: unknown;
  readonly raw: Request;
}

// A route a plugin defined with defineServer, for the kernel's route table.
export interface ExtRoute {
  readonly plugin: string;
  readonly method: Exclude<Method, "ANY">;
  readonly path: string;
  readonly spec: RouteSpec;
  readonly handler: (input: ExtInput) => unknown;
}

type Scoped = (input: ExtInput & { readonly owner: Owner }) => unknown;

export function pluginRoutes(
  plugin: string,
  o: {
    readonly team: boolean;
    readonly inTeamWork: () => boolean;
    readonly publish: (topic: string) => void;
  },
): { readonly routes: Routes; readonly declared: readonly ExtRoute[] } {
  const declared: ExtRoute[] = [];

  const declare = (route: Omit<ExtRoute, "plugin">): void => {
    if (
      declared.some(
        ({ method, path }) => method === route.method && path === route.path,
      )
    ) {
      throw new Error(`${route.method} ${route.path} is already a route`);
    }

    declared.push({ plugin, ...route });
  };

  const route =
    (method: ExtRoute["method"]) =>
    (path: string, spec: RouteSpec, handler: unknown): void => {
      declare({
        method,
        path: joined(path),
        spec,
        handler: handler as ExtRoute["handler"],
      });
    };

  const scoped =
    (base: string, method: ExtRoute["method"]) =>
    (path: string, spec: Omit<RouteSpec, "auth">, handler: unknown): void => {
      const run = handler as Scoped;
      const own = joined(base, path);

      declare({
        method,
        path: own,
        spec: { ...spec, auth: "person" },
        handler: (input) => run({ ...input, owner: ownerOf(input.caller) }),
      });

      if (!o.team) {
        return;
      }

      declare({
        method,
        path: joined("team", own),
        spec: { ...spec, auth: "person" },
        handler: (input) => {
          if (!o.inTeamWork()) {
            throw new NotFound("Not found.");
          }

          return run({ ...input, owner: "team" });
        },
      });
    };

  return {
    routes: {
      get: route("GET"),
      post: route("POST"),
      put: route("PUT"),
      patch: route("PATCH"),
      delete: route("DELETE"),
      scoped: (base, define) => {
        const routes: ScopedRoutes = {
          get: scoped(base, "GET"),
          post: scoped(base, "POST"),
          put: scoped(base, "PUT"),
          patch: scoped(base, "PATCH"),
          delete: scoped(base, "DELETE"),
        };

        define(routes);
      },
      topic: (name) => {
        o.publish(`${plugin}.${name}`);
      },
    },
    declared,
  };
}

export function pluginUrls(plugin: string, server: () => URL): Urls {
  const prefix = `/api/ext/${plugin}`;
  const named = (name: string): string => `${plugin}.${name}`;

  return {
    public: (path) => new URL(`${prefix}/${joined(path)}`, server()).href,
    cookie: {
      set: (response, name, value, maxAgeS) => {
        const cookie = new Bun.Cookie(named(name), value, {
          path: prefix,
          maxAge: maxAgeS,
          httpOnly: true,
          sameSite: "lax",
          secure: server().protocol === "https:",
        });

        response.headers.append("set-cookie", cookie.serialize());
      },
      get: (request, name) =>
        new Bun.CookieMap(request.headers.get("cookie") ?? "").get(
          named(name),
        ) ?? undefined,
    },
  };
}

function ownerOf(caller: Caller): Owner {
  if (caller.kind === "public") {
    throw new Error("a scoped route serves only people and Sessions");
  }

  return caller.owner;
}

function joined(...paths: readonly string[]): string {
  return paths
    .flatMap((path) => path.split("/"))
    .filter((part) => part !== "")
    .join("/");
}
