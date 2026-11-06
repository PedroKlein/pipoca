import {
  type Caller,
  NotFound,
  type Params,
  type PersonCaller,
  type Routes,
  type RouteSpec,
  type Urls,
} from "@pipoca/plugins";
import type { Method } from "@pipoca/protocol";

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
  // A team route's personal half, whose team half is under team/.
  readonly teamTwin?: true;
  readonly handler: (input: ExtInput) => unknown;
}

export function pluginRoutes(
  plugin: string,
  o: {
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
      const run = handler as ExtRoute["handler"];

      if (spec.team === true && spec.auth !== "person") {
        throw new Error(`${path} answers the team, so it needs auth person`);
      }

      const twinned = spec.team === true;

      declare({
        method,
        path: joined(path),
        spec,
        ...(twinned && { teamTwin: true }),
        handler: run,
      });

      if (!twinned) {
        return;
      }

      const { tool: _tool, ...withoutTool } = spec;

      declare({
        method,
        path: joined("team", path),
        spec: withoutTool,
        handler: (input) => {
          if (!o.inTeamWork()) {
            throw new NotFound("Not found.");
          }

          const caller = input.caller as PersonCaller;

          return run({ ...input, caller: { ...caller, owner: "team" } });
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
      topic: (name) => {
        o.publish(`${plugin}.${name}`);
      },
    },
    declared,
  };
}

export function pluginUrls(plugin: string, server: () => URL): Urls {
  return {
    public: (path) =>
      new URL(`/api/ext/${plugin}/${joined(path)}`, server()).href,
    cookie: {
      set: (response, name, value, maxAgeS) => {
        response.headers.append(
          "set-cookie",
          new Bun.Cookie(name, value, {
            path: `/api/ext/${plugin}/`,
            httpOnly: true,
            sameSite: "lax",
            secure: server().protocol === "https:",
            maxAge: maxAgeS,
          }).serialize(),
        );
      },
      get: (request, name) =>
        new Bun.CookieMap(request.headers.get("cookie") ?? "").get(name) ??
        undefined,
    },
  };
}

function joined(...paths: readonly string[]): string {
  return paths
    .flatMap((path) => path.split("/"))
    .filter((part) => part !== "")
    .join("/");
}
