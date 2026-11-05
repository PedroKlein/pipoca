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
  readonly handler: (input: ExtInput) => unknown;
}

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
      const run = handler as ExtRoute["handler"];

      declare({ method, path: joined(path), spec, handler: run });

      if (spec.team !== true) {
        return;
      }

      if (spec.auth !== "person") {
        throw new Error(`${path} answers the team, so it needs auth person`);
      }

      if (!o.team) {
        return;
      }

      // A tool is the person's half alone: one name, one route.
      const { tool: _tool, ...team } = spec;

      declare({
        method,
        path: joined("team", path),
        spec: team,
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
  };
}

function joined(...paths: readonly string[]): string {
  return paths
    .flatMap((path) => path.split("/"))
    .filter((part) => part !== "")
    .join("/");
}
