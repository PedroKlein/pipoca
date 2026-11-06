import { HttpError, NotFound } from "@pipoca/plugins";
import { teamMessagesRead, type TeamView } from "@pipoca/protocol";
import { laidOut } from "../../../hub";
import { newcomersOf } from "../../../newcomers";
import { teamOf } from "../../../team";
import type { ApiDeps, Group } from "../deps";
import type { Handlers } from "../router";

export function settingsRoutes({
  config,
  hub,
  team,
  newcomers,
  log,
}: ApiDeps): Handlers<
  Exclude<Group<"settings">, Group<"settings.baseProfile">>
> {
  return {
    "settings.config": () => {
      if (config === undefined) {
        throw new NotFound("Not found.");
      }

      return { root: config.root, files: config.list() };
    },
    "settings.config.file": ({ params: { name } }) => {
      const file = config?.read(name);

      if (file === undefined) {
        throw new NotFound("Not found.");
      }

      return file;
    },
    "settings.config.file.write": ({
      params: { name },
      body: { text, version },
    }) => {
      if (config === undefined) {
        throw new NotFound("Not found.");
      }

      const failure = config.write(name, text, version);

      if (failure !== undefined) {
        throw new HttpError(
          failure.changed ? 409 : 400,
          failure.reason,
          failure.changed ? "config_changed" : "invalid_config",
        );
      }

      log("config file edited", { name });

      return config.read(name);
    },
    "settings.hub": () => hub?.layout() ?? { pages: null },
    "settings.hub.update": ({ body }) => {
      const layout = laidOut(body);

      if (hub === undefined) {
        throw new NotFound("Not found.");
      }

      hub.lay(layout);
      log("hub laid out", { pages: layout.pages?.length ?? 0 });

      return layout;
    },
    "settings.team": () =>
      ({
        ...(team?.get() ?? { name: null }),
        messagesRead: team?.messagesRead() ?? teamMessagesRead,
      }) satisfies TeamView,
    "settings.team.update": ({ body }) => {
      const next = teamOf(body);

      if (team === undefined) {
        throw new NotFound("Not found.");
      }

      team.set(next);
      log("team named", { name: next.name });

      return next;
    },
    "settings.newcomers": () =>
      newcomers?.get() ?? { template: null, profiles: [], required: [] },
    "settings.newcomers.update": ({ body }) => {
      const next = newcomersOf(body);

      if (newcomers === undefined) {
        throw new NotFound("Not found.");
      }

      newcomers.set(next);

      log("newcomer setup changed", {
        template: next.template,
        profiles: next.profiles.length,
        required: next.required,
      });

      return next;
    },
  };
}
