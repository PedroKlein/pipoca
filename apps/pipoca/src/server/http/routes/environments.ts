import { HttpError, NotFound } from "@pipoca/plugins";
import type {
  Environment,
  EnvironmentKey,
  ListedTemplate,
} from "@pipoca/protocol";
import { canManage, canSteer, type Viewer } from "@pipoca/people";
import type { Templates } from "@pipoca/environments";
import type { ApiDeps, Group } from "../deps";
import { ok } from "../replies";
import type { Handlers, PersonCaller } from "../router";

// The owner of what the team owns, rather than one person (ADR 0064).
const teamOwner = "team";

export function environmentRoutes({
  environments,
  runners,
  log,
}: ApiDeps): Handlers<Group<"environments"> | Group<"joinKeys">> {
  const reached = (id: string, caller: PersonCaller, may: typeof canSteer) => {
    const environment = environments
      .all()
      .find(
        (each) =>
          each.id === id && may(viewerOf(caller), { owner: each.ownerId }),
      );

    if (environment === undefined) {
      throw new NotFound("Not found.");
    }

    return environment;
  };

  return {
    "environments.list": ({ query, caller }) => {
      const everyone = caller.admin && query.people === "all";

      if (query.owner === teamOwner) {
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
        .filter(({ ownerId }) => everyone || ownerId === caller.id)
        .map((environment) =>
          environment.ownerId === caller.id
            ? environment
            : environmentOutline(environment),
        );
    },
    "environments.create": ({ body: { name, template, team }, caller }) => {
      if (team === true && !caller.admin) {
        throw new HttpError(
          403,
          "Only admins make team Environments.",
          "admin_only",
        );
      }

      const created = ok(
        environments.create(
          name,
          team === true ? teamOwner : caller.id,
          template,
        ),
      );

      const key = runners.newKey(created.provider);
      log("environment created", { environmentId: created.id });

      return { environment: { ...created, hasKey: true }, key };
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
  plugins,
  log,
}: ApiDeps): Handlers<Group<"templates">> {
  const made = (): Templates => {
    if (templates === undefined) {
      throw new NotFound("Not found.");
    }

    return templates;
  };

  return {
    "templates.list": () =>
      (templates?.list() ?? []).map((template): ListedTemplate => ({
        ...template,
        runnersFrom:
          plugins.startsRunners({ id: "", templateId: template.id }) ?? null,
      })),
    "templates.create": ({ body }) => {
      const created = made().create(body);
      log("template created", { templateId: created.id });

      return created;
    },
    "templates.listed": async ({ body: { url } }) => ({
      templates: await made().listed(url),
    }),
    "templates.import": async ({ body: { url, paths } }) => {
      const imported = await made().importListed(url, paths);

      log("templates imported", {
        templateIds: imported.map(({ id }) => id),
      });

      return { templates: imported };
    },
    "templates.syncs.create": async ({ params: { id } }) => {
      const template = made()
        .list()
        .find((each) => each.id === id);

      const source = template?.source;

      if (!template || !source) {
        throw new NotFound("Not found.");
      }

      await made().sync(source.url);

      return (
        made()
          .list()
          .find((each) => each.id === id) ?? template
      );
    },
    "templates.update": ({ params: { id }, body }) => {
      const updated = made().update(id, body);
      log("template updated", { templateId: id });

      return updated;
    },
    "templates.remove": ({ params: { id } }) => {
      made().remove(id);
      log("template removed", { templateId: id });

      return undefined;
    },
  };
}

// What an admin sees of someone else's Environment: never their variable
// values, folders or models (ADR 0049).
function environmentOutline(environment: Environment): Environment {
  return { ...environment, variables: {}, folders: [], models: [] };
}
