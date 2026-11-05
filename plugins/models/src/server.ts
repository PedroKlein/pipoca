import {
  BadRequest,
  HttpError,
  isObject,
  NotFound,
  type OfferedModels,
  type PluginStore,
  readBody,
  requireAdmin,
  type ServerPlugin,
  Type,
} from "@pipoca/plugins";
import { aliasesOf, gatewayProvider } from "./gateway";
import {
  type AliasConfig,
  aliasProblem,
  type EnvironmentModels,
  type Health,
  healthFrom,
  mergeHealth,
  modelRef,
  type SessionConfig,
  storedAliases,
} from "./model";

const aliasConfig = Type.Object({
  models: Type.Record(Type.String(), Type.Array(Type.String())),
  providers: Type.Optional(
    Type.Record(
      Type.String(),
      Type.Object({
        resetSchedule: Type.Optional(Type.String()),
        capStatusCodes: Type.Optional(Type.Array(Type.Integer())),
      }),
    ),
  ),
  defaultAlias: Type.Optional(Type.String()),
});

// Null turns an Environment's aliases off.
const aliasesChange = Type.Object({
  aliases: Type.Union([aliasConfig, Type.Null()]),
});

const hiddenChange = Type.Object({ hidden: Type.Array(Type.String()) });

// Below the server's 30 second idle timeout.
const waitMs = 20_000;

// Benched models and providers are keyed by a provider, or a provider/id.
const schema = `
create table models_environments (
  environment_id text primary key references environments (id) on delete cascade,
  aliases text check (json_valid(aliases))
) strict;

create table models_health (
  environment_id text not null references environments (id) on delete cascade,
  target text not null,
  until integer not null,
  reason text not null,
  quota_spent_micros integer,
  quota_cap_micros integer,
  quota_currency text,
  primary key (environment_id, target),
  check ((quota_spent_micros is null) = (quota_currency is null))
) strict, without rowid;
`;

// A runner's report; healthFrom keeps the entries it understands.
const healthReport = Type.Object({
  unhealthyUntil: Type.Record(Type.String(), Type.Unknown()),
});

export const models: ServerPlugin = {
  name: "models",
  schema,
  register: (context) => {
    const store = modelsStore(context.store);
    const versions = changes(context.signal);

    // An Environment without aliases of its own takes its template's
    // (ADR 0063).
    const templateAliases = (templateId: string | null): AliasConfig | null => {
      const aliases = context.environments
        .templates()
        .find(({ id }) => id === templateId)?.aliases;

      if (!aliases) {
        return null;
      }

      const config = storedAliases(aliases);

      const problem =
        typeof config.models === "object"
          ? aliasProblem(config)
          : "aliases need models";

      if (problem !== undefined) {
        context.log("template aliases unreadable", { templateId, problem });

        return null;
      }

      return config;
    };

    // The template is looked up only when it can matter, since listing
    // Environments asks for this offer.
    const effective = (
      environmentId: string,
      templateId: () => string | null,
    ): EnvironmentModels => {
      const saved = store.get(environmentId);

      return saved.aliases === null &&
        context.environments.templates().some(({ aliases }) => aliases)
        ? { ...saved, aliases: templateAliases(templateId()) }
        : saved;
    };

    // Admins keep models nobody here should use out of the pickers, under
    // `hidden` in the plugin's key of pipoca.json.
    const settings = (): Record<string, unknown> => {
      const value = context.config.get();

      return isObject(value) ? value : {};
    };

    const hidden = (): readonly string[] => {
      const { hidden: list } = settings();

      return Array.isArray(list)
        ? list.filter((each): each is string => typeof each === "string")
        : [];
    };

    context.models.offer(({ id, templateId }) => ({
      ...offered(effective(id, () => templateId).aliases),
      hidden: hidden(),
    }));

    context.routes.handle(async (request, path, caller) => {
      const method = request.method;

      if (caller.kind === "session") {
        const { environmentId } = caller.session;

        if (method === "GET" && path === "config") {
          const after = new URL(request.url).searchParams.get("after");
          if (after !== null) {
            // A Session polls again at once after any answer, and backs off
            // only after an error.
            if (context.signal.aborted) {
              throw new HttpError(503, "the server is stopping", "stopping");
            }

            await versions.changed(
              environmentId,
              Number(after),
              request.signal,
            );
          }

          const config = {
            version: versions.of(environmentId),
            ...effective(
              environmentId,
              () =>
                context.environments
                  .list()
                  .find(({ id }) => id === environmentId)?.templateId ?? null,
            ),
          } satisfies SessionConfig;

          return Response.json(config);
        }

        if (method === "POST" && path === "health") {
          const reported = healthFrom(await readBody(request, healthReport));
          if (reported === undefined) {
            throw new BadRequest(
              "model health report not understood",
              "invalid_health",
            );
          }

          const current = store.get(environmentId).health;
          const health = mergeHealth(current, reported, new Date());
          if (JSON.stringify(health) !== JSON.stringify(current)) {
            store.setHealth(environmentId, health);
            versions.bump(environmentId);

            context.log("model health changed", {
              environmentId,
              unhealthy: Object.keys(health.unhealthyUntil),
              session: caller.session.id,
            });
          }

          return new Response(null, { status: 204 });
        }

        throw new NotFound(`no route ${path}`);
      }

      if (path === "hidden") {
        if (method === "GET") {
          return Response.json({
            hidden: hidden(),
            mayChange: caller.admin,
          });
        }

        if (method === "POST") {
          requireAdmin(caller, "only admins hide models");

          const { hidden: next } = await readBody(request, hiddenChange);
          const invalid = next.find((each) => modelRef(each) === undefined);

          if (invalid !== undefined) {
            throw new BadRequest(`${invalid} must be provider/id`);
          }

          const { hidden: _, ...rest } = settings();

          context.config.set(
            next.length === 0 ? rest : { ...rest, hidden: [...new Set(next)] },
          );

          context.changes.publish("hidden");
          context.log("hidden models changed", { count: next.length });

          return Response.json({ hidden: hidden(), mayChange: true });
        }
      }

      const [resource, environmentId] = path.split("/");
      if (resource !== "environments") {
        throw new NotFound(`no route ${path}`);
      }

      if (method === "GET" && environmentId === undefined) {
        return Response.json(store.all());
      }

      if (method === "POST" && environmentId !== undefined) {
        requireAdmin(caller, "only admins change model aliases");

        const { aliases } = await readBody(request, aliasesChange);
        const problem = aliases === null ? undefined : aliasProblem(aliases);
        if (problem !== undefined) {
          throw new BadRequest(problem);
        }

        store.setAliases(environmentId, aliases);
        versions.bump(environmentId);
        context.log("aliases changed", { environmentId });

        return Response.json(store.get(environmentId));
      }

      throw new NotFound(`no route ${path}`);
    });
  },
};

function offered(aliases: AliasConfig | null): OfferedModels {
  if (aliases === null) {
    return { models: [] };
  }

  const refs = aliasesOf(aliases).map((id) => ({
    provider: gatewayProvider,
    id,
  }));

  const fallback = refs.find(({ id }) => id === aliases.defaultAlias);

  return { models: refs, ...(fallback && { default: fallback }) };
}

interface ModelsStore {
  readonly all: () => readonly EnvironmentModels[];
  readonly get: (environmentId: string) => EnvironmentModels;
  readonly setAliases: (
    environmentId: string,
    aliases: AliasConfig | null,
  ) => void;
  readonly setHealth: (environmentId: string, health: Health) => void;
}

interface HealthRow {
  readonly target: string;
  readonly until: number;
  readonly reason: string;
  readonly quota_spent_micros: number | null;
  readonly quota_cap_micros: number | null;
  readonly quota_currency: string | null;
}

// Money is kept in millionths of the currency, as whole numbers.
const microsPerUnit = 1_000_000;

function micros(amount: number | undefined): number | null {
  return amount === undefined ? null : Math.round(amount * microsPerUnit);
}

function modelsStore(store: PluginStore): ModelsStore {
  const savedAliases = (environmentId: string): AliasConfig | null => {
    const [row] = store.all(
      "select aliases from models_environments where environment_id = ?",
      environmentId,
    ) as { aliases: string | null }[];

    return row === undefined || row.aliases === null
      ? null
      : storedAliases(JSON.parse(row.aliases));
  };

  const healthOf = (environmentId: string): Health => ({
    version: 1,
    unhealthyUntil: Object.fromEntries(
      (
        store.all(
          "select target, until, reason, quota_spent_micros, quota_cap_micros, quota_currency from models_health where environment_id = ? order by target",
          environmentId,
        ) as HealthRow[]
      ).map((row) => [
        row.target,
        {
          until: new Date(row.until).toISOString(),
          reason: row.reason,
          ...(row.quota_spent_micros !== null &&
            row.quota_currency !== null && {
              quota: {
                spent: row.quota_spent_micros / microsPerUnit,
                cap: (row.quota_cap_micros ?? 0) / microsPerUnit,
                currency: row.quota_currency,
              },
            }),
        },
      ]),
    ),
  });

  const get = (environmentId: string): EnvironmentModels => ({
    environmentId,
    aliases: savedAliases(environmentId),
    health: healthOf(environmentId),
  });

  return {
    all: () =>
      (
        store.all(
          "select environment_id from models_environments union select environment_id from models_health",
        ) as { environment_id: string }[]
      ).map(({ environment_id }) => get(environment_id)),
    get,
    setAliases: (environmentId, aliases) => {
      store.run(
        `insert into models_environments (environment_id, aliases) values (?, ?)
         on conflict (environment_id) do update set aliases = excluded.aliases`,
        environmentId,
        aliases === null ? null : JSON.stringify(aliases),
      );
    },
    setHealth: (environmentId, health) => {
      store.transaction(() => {
        store.run(
          "delete from models_health where environment_id = ?",
          environmentId,
        );

        for (const [target, unhealthy] of Object.entries(
          health.unhealthyUntil,
        )) {
          store.run(
            "insert into models_health (environment_id, target, until, reason, quota_spent_micros, quota_cap_micros, quota_currency) values (?, ?, ?, ?, ?, ?, ?)",
            environmentId,
            target,
            Date.parse(unhealthy.until),
            unhealthy.reason,
            micros(unhealthy.quota?.spent),
            micros(unhealthy.quota?.cap),
            unhealthy.quota?.currency ?? null,
          );
        }
      });
    },
  };
}

// A version per Environment that Sessions wait on. It starts from the clock,
// so a Session that saw a version before a restart never sees it again.
function changes(signal: AbortSignal): {
  readonly of: (environmentId: string) => number;
  readonly bump: (environmentId: string) => void;
  readonly changed: (
    environmentId: string,
    seen: number,
    request: AbortSignal,
  ) => Promise<void>;
} {
  const start = Date.now();
  const versions = new Map<string, number>();
  const waiting = new Map<string, Set<() => void>>();

  const of = (environmentId: string): number =>
    versions.get(environmentId) ?? start;

  return {
    of,
    bump: (environmentId) => {
      versions.set(environmentId, of(environmentId) + 1);

      for (const wake of waiting.get(environmentId) ?? []) {
        wake();
      }

      waiting.delete(environmentId);
    },
    changed: async (environmentId, seen, request) => {
      if (of(environmentId) !== seen || request.aborted) {
        return;
      }

      await new Promise<void>((resolve) => {
        const wake = (): void => {
          clearTimeout(timer);
          request.removeEventListener("abort", wake);
          signal.removeEventListener("abort", wake);
          waiting.get(environmentId)?.delete(wake);
          resolve();
        };

        const timer = setTimeout(wake, waitMs);
        const set = waiting.get(environmentId) ?? new Set();
        set.add(wake);
        waiting.set(environmentId, set);

        request.addEventListener("abort", wake, { once: true });
        signal.addEventListener("abort", wake, { once: true });
      });
    },
  };
}
