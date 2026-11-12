import { BadRequest, HttpError, NotFound, Type } from "@pipoca/plugins";
import { checkBody, isObject } from "@pipoca/plugins/host";
import {
  type Environment,
  type EnvironmentKey,
  type EnvironmentTemplate,
  type ListedTemplate,
  repositoryImport,
} from "@pipoca/protocol";
import { canManage, canSteer, type Viewer } from "@pipoca/people";
import type { Templates } from "@pipoca/environments";
import type { ApiDeps, Group } from "../deps";
import { checkFetchable } from "../private-address";
import { ok } from "../replies";
import type { Handlers, PersonCaller } from "../router";

// The owner of what the team owns, rather than one person (ADR 0064).
const teamOwner = "team";

export function environmentRoutes({
  environments,
  runners,
  network,
  log,
}: ApiDeps): Handlers<Group<"environments"> | Group<"joinKeys">> {
  const reached = (id: string, caller: PersonCaller, may: typeof canSteer) => {
    const environment = environments
      .all()
      .find(
        (each) =>
          each.id === id &&
          (!caller.team || each.ownerId === teamOwner) &&
          may(viewerOf(caller), { owner: each.ownerId }),
      );

    if (environment === undefined) {
      throw new NotFound("Not found.");
    }

    return environment;
  };

  return {
    "environments.list": ({ query, caller }) => {
      const scope = caller.team ? "team" : (query.scope ?? "mine");

      if (scope === "all" && !caller.admin) {
        throw new HttpError(
          403,
          "Only admins list everyone's Environments.",
          "admin_only",
        );
      }

      if (scope === "team") {
        return (
          environments
            .list(caller.id)
            .filter(({ ownerId }) => ownerId === teamOwner)
            // Anyone can start team work, so they see its folders and
            // models; only its variables stay with admins.
            .map((environment) =>
              caller.admin ? environment : { ...environment, variables: {} },
            )
        );
      }

      return environments
        .list(caller.id)
        .filter(({ ownerId }) => scope === "all" || ownerId === caller.id)
        .map((environment) =>
          environment.ownerId === caller.id
            ? environment
            : environmentOutline(environment),
        );
    },
    "environments.create": ({ body: { name, template, ...body }, caller }) => {
      const team = body.team === true || caller.team;

      if (team && !caller.admin) {
        throw new HttpError(
          403,
          "Only admins make team Environments.",
          "admin_only",
        );
      }

      const created = ok(
        environments.create(name, team ? teamOwner : caller.id, template),
      );

      const key = runners.newKey(created.provider);
      log("environment created", { environmentId: created.id });

      return { ...created, hasKey: true, key };
    },
    "environments.keys.create": ({ params: { id }, caller }) => {
      const environment = reached(id, caller, canSteer);

      const key: EnvironmentKey = {
        key: runners.newKey(environment.provider),
      };

      log("environment key replaced", { environmentId: id });

      return key;
    },
    "environments.update": ({ params: { id }, body, caller }) => {
      reached(id, caller, canSteer);

      const { name, ...update } = body;

      const updated = ok(
        environments.update(id, {
          ...update,
          ...(name !== undefined && { name: name.trim() }),
        }),
      );

      log("environment updated", { environmentId: id });

      return updated;
    },
    "environments.remove": ({ params: { id }, caller }) => {
      reached(id, caller, canManage);
      ok(environments.remove(id));
      log("environment deleted", { environmentId: id });

      return undefined;
    },
    "environments.relays": ({ params: { id }, caller }) => {
      const { provider } = reached(id, caller, canSteer);

      return {
        confirmed: environments
          .runners(provider)
          .flatMap(({ name }) =>
            (
              network?.confirmed({ environment: provider, runner: name }) ?? []
            ).map((to) => ({ runner: name, ...to })),
          ),
        recent: [...(network?.recent(provider) ?? [])],
      };
    },
    "joinKeys.create": ({ caller }) => {
      log("join key made", {});

      return { key: runners.newJoinKey(caller.id) };
    },
  };

  function viewerOf(caller: PersonCaller): Viewer {
    return { id: caller.id, admin: caller.admin };
  }
}

// Every Environment made from a template follows it, so only admins change
// templates (ADR 0049).
export function templateRoutes({
  templates,
  profiles,
  plugins,
  log,
}: ApiDeps): Handlers<Group<"environmentTemplates"> | Group<"repositories">> {
  const made = (): Templates => {
    if (templates === undefined) {
      throw new NotFound("Not found.");
    }

    return templates;
  };

  const listed = (template: EnvironmentTemplate): ListedTemplate => ({
    ...template,
    runnersFrom:
      plugins.startsRunners({ id: "", templateId: template.id }) ?? null,
  });

  return {
    "environmentTemplates.list": () => (templates?.list() ?? []).map(listed),
    "environmentTemplates.create": async ({ body }) => {
      const { source } = isObject(body) ? checkBody(body, sourced) : {};

      if (source === undefined) {
        const created = made().create(body);
        log("template created", { templateId: created.id });

        return listed(created);
      }

      if (source.path === undefined) {
        throw new BadRequest(
          "source.path must name a template the repository lists",
        );
      }

      const [imported] = await made().importListed(source.url, [source.path]);

      if (imported === undefined) {
        throw new NotFound("The repository lists no template there.");
      }

      log("template imported", { templateId: imported.id });

      return listed(imported);
    },
    "environmentTemplates.syncs.create": async ({ params: { id } }) => {
      const template = made()
        .list()
        .find((each) => each.id === id);

      const source = template?.source;

      if (!template || !source) {
        throw new NotFound("Not found.");
      }

      await made().sync(source.url);

      return listed(
        made()
          .list()
          .find((each) => each.id === id) ?? template,
      );
    },
    "environmentTemplates.update": ({ params: { id }, body }) => {
      const updated = made().update(id, body);
      log("template updated", { templateId: id });

      return listed(updated);
    },
    "environmentTemplates.remove": ({ params: { id } }) => {
      made().remove(id);
      log("template removed", { templateId: id });

      return undefined;
    },
    // Read once for both kinds, so a person picks Profiles and admins
    // templates from the same answer.
    "repositories.manifest": async ({ query: { url }, caller }) => {
      const clone = await checkFetchable(url, caller.id, plugins);

      const [listedProfiles, listedTemplates] = await Promise.all([
        profiles.listed(url, clone),
        templates?.listed(url, clone) ?? [],
      ]);

      return { profiles: listedProfiles, templates: listedTemplates };
    },
  };
}

// Imported from a folder a repository's pipoca.json lists (ADR 0063).
const sourced = Type.Partial(repositoryImport);

// What an admin sees of someone else's Environment: never their variable
// values, folders or models (ADR 0049).
function environmentOutline(environment: Environment): Environment {
  return { ...environment, variables: {}, folders: [], models: [] };
}
