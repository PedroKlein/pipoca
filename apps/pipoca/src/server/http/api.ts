import { userIdOf } from "@pipoca/pluginhost";
import { InvalidProfile, ProfileTooBig } from "@pipoca/profiles";
import { InvalidRepository } from "@pipoca/repositories";
import { InvalidCredentials } from "@pipoca/people";
import { routes } from "@pipoca/protocol";
import type { ApiDeps } from "./deps";
import { extRoutes } from "./ext";
import { authRoutes } from "./routes/auth";
import { environmentRoutes, templateRoutes } from "./routes/environments";
import { meRoutes, peopleRoutes } from "./routes/people";
import { pluginRoutes } from "./routes/plugins";
import { profileRoutes } from "./routes/profiles";
import { runnerRoutes } from "./routes/runner";
import { serverRoutes } from "./routes/server";
import { sessionRoutes } from "./routes/sessions";
import { settingsRoutes } from "./routes/settings";
import {
  behalfOf,
  type Callers,
  createRouter,
  type Handlers,
  type Router,
} from "./router";

// The server's API: every route of the table with its handler.
export function createApi(deps: Omit<ApiDeps, "callers">): Router {
  const { people, signIn, runners, sessions } = deps;

  const callers: Callers = {
    person: (request) => {
      const behalf = behalfOf(request);
      const user = signIn.userOf(request);

      const actor =
        behalf?.actor ??
        (user === undefined ? undefined : (`user:${user.id}` as const));

      if (actor === undefined) {
        return undefined;
      }

      const id = userIdOf(actor);

      return {
        kind: "person",
        actor,
        id,
        admin:
          behalf?.mayAdmin !== false && people.userById(id)?.admin === true,
        team: behalf?.team === true,
      };
    },
    runner: (request) => runners.callerOf(request),
    // A Session that never reached a runner can still have a workspace
    // removal for any runner of its Environment. Runner names are unique
    // only within an Environment.
    hosts: (caller, sessionId) => {
      const session = sessions.get(sessionId);

      return (
        (caller.sessionId === null || caller.sessionId === sessionId) &&
        session?.provider === caller.environment &&
        (session.runner === null || session.runner === caller.runner)
      );
    },
  };

  const all = { ...deps, callers };

  const handlers: Handlers = {
    ...serverRoutes(all),
    ...authRoutes(all),
    ...meRoutes(all),
    ...pluginRoutes(all),
    ...environmentRoutes(all),
    ...templateRoutes(all),
    ...peopleRoutes(all),
    ...settingsRoutes(all),
    ...profileRoutes(all),
    ...sessionRoutes(all),
    ...runnerRoutes(all),
  };

  return createRouter(
    [
      ...Object.entries(routes).map(([key, spec]) => ({
        spec,
        handler: handlers[key as keyof Handlers],
      })),
      ...extRoutes(deps.plugins.extRoutes(), { people, sessions, callers }),
    ],
    {
      callers,
      publish: deps.changes.publish,
      refused: (error) =>
        error instanceof InvalidProfile ||
        error instanceof ProfileTooBig ||
        error instanceof InvalidCredentials ||
        error instanceof InvalidRepository,
      log: deps.log,
    },
  );
}
