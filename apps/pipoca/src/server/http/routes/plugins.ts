import { BadRequest, HttpError, NotFound } from "@pipoca/plugins";
import type { PluginHost } from "@pipoca/pluginhost";
import type { PluginInfo } from "@pipoca/protocol";
import type { ApiDeps, Group } from "../deps";
import { type Handlers, type PersonCaller, restOf } from "../router";

// Plugins run code inside the server, so only admins change them.
export function pluginRoutes({
  plugins,
  people,
  callers,
}: ApiDeps): Handlers<Group<"plugins"> | "ext"> {
  // A draft runs nothing until an admin turns it on, so an admin's
  // meta-session may write one though it never acts as an admin.
  const drafter = (caller: PersonCaller): void => {
    if (people.userById(caller.id)?.admin !== true) {
      throw new HttpError(
        403,
        "Only admins write and build plugins.",
        "admin_only",
      );
    }
  };

  return {
    "plugins.list": () => plugins.list(),
    "plugins.install": async ({ body: { url } }) =>
      changed(await plugins.install(url)),
    "plugins.update": async ({ params: { plugin }, body }) => {
      const { settings, enabled, update, digest, teamWork } = body;

      if (teamWork !== undefined) {
        return changed(plugins.setTeamWork(plugin, teamWork));
      }

      return changed(
        await pluginChange(plugins, plugin, {
          settings,
          enabled,
          update: update === true,
          ...(digest !== undefined && { digest }),
        }),
      );
    },
    "plugins.remove": async ({ params: { plugin } }) => {
      if (!changed(await plugins.remove(plugin))) {
        throw new NotFound("Not found.");
      }

      return undefined;
    },
    "plugins.files": async ({ params: { plugin } }) =>
      refused(plugins.files.list(plugin)),
    "plugins.file": async ({ params: { plugin, path } }) => {
      const file = restOf(path);

      return {
        path: file,
        content: await refused(plugins.files.read(plugin, file)),
      };
    },
    "plugins.file.write": async ({
      params: { plugin, path },
      body,
      caller,
    }) => {
      drafter(caller);

      return refused(plugins.files.write(plugin, restOf(path), body.content));
    },
    "plugins.builds.create": async ({ params: { plugin }, caller }) => {
      drafter(caller);

      return refused(plugins.files.build(plugin));
    },
    "plugins.data.remove": ({ params: { plugin } }) =>
      changed(plugins.resetData(plugin)),
    "plugins.part": ({ params: { plugin, file } }) => {
      const path = plugins.webPart(plugin, file);

      if (path === undefined) {
        throw new NotFound("Not found.");
      }

      // Named by content hash, so a browser can keep it.
      return new Response(Bun.file(path), {
        headers: {
          "content-type": "text/javascript; charset=utf-8",
          "cache-control": "private, max-age=31536000, immutable",
        },
      });
    },
    // A plugin's own API: its public routes, then the ones for people who
    // signed in (ADR 0015).
    ext: async ({ request, params: { plugin, path } }) => {
      const answered = await plugins.publicRoute(request, plugin, path);

      if (answered !== undefined) {
        return answered;
      }

      const person = callers.person(request);

      if (person === undefined) {
        throw new HttpError(401, "Sign in again.", "signed_out");
      }

      const routed = await plugins.route(request, plugin, path, {
        kind: "user",
        actor: person.actor,
        admin: person.admin,
      });

      if (routed === undefined) {
        throw new NotFound("Not found.");
      }

      return routed;
    },
  };
}

// A refusal is a string, and undefined a plugin that isn't there.
function changed<T>(result: T | string | undefined): T {
  if (typeof result === "string") {
    throw new BadRequest(result);
  }

  if (result === undefined) {
    throw new NotFound("Not found.");
  }

  return result;
}

async function pluginChange(
  plugins: PluginHost,
  name: string,
  change: {
    readonly settings: unknown;
    readonly enabled: boolean | undefined;
    readonly update: boolean;
    readonly digest?: string;
  },
): Promise<PluginInfo | string | undefined> {
  if (change.update) {
    return plugins.update(name);
  }

  return change.enabled === undefined
    ? plugins.saveSettings(name, change.settings)
    : plugins.turnOn(name, change.enabled, change.digest);
}

// What an in-place plugin's change can't do is the caller's to fix.
async function refused<T>(change: Promise<T>): Promise<T> {
  return change.catch((error: unknown) => {
    if (error instanceof NotFound) {
      throw error;
    }

    throw new BadRequest(
      error instanceof Error ? error.message : String(error),
    );
  });
}
