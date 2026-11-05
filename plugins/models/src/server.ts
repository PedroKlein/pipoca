import { randomUUID } from "node:crypto";
import {
  BadRequest,
  type Caller,
  defineServer,
  Forbidden,
  HttpError,
  type OfferedModels,
  type ServerContext,
  type Store,
  Type,
} from "@pipoca/plugins";
import type { Session } from "@pipoca/protocol";
import { models } from "../plugin";
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

const configQuery = Type.Object({ after: Type.Optional(Type.Number()) });

// A runner's report; healthFrom keeps the entries it understands.
const healthReport = Type.Object({
  unhealthyUntil: Type.Record(Type.String(), Type.Unknown()),
});

// Below the server's 30 second idle timeout.
const waitMs = 20_000;

export const server = defineServer(models, (context) => {
  const { routes, environments, config, clock, log } = context;
  const store = modelsStore(context.store);
  const versions = changes(context);

  // An Environment without aliases of its own takes its template's
  // (ADR 0063).
  const templateAliases = (templateId: string | null): AliasConfig | null => {
    const aliases = environments
      .templates()
      .find(({ id }) => id === templateId)?.aliases;

    if (!aliases) {
      return null;
    }

    const stored = storedAliases(aliases);

    const problem =
      typeof stored.models === "object"
        ? aliasProblem(stored)
        : "aliases need models";

    if (problem !== undefined) {
      log("template aliases unreadable", { templateId, problem });

      return null;
    }

    return stored;
  };

  // The template is looked up only when it can matter, since listing
  // Environments asks for this offer.
  const effective = (
    environmentId: string,
    templateId: () => string | null,
  ): EnvironmentModels => {
    const saved = store.get(environmentId);

    return saved.aliases === null &&
      environments.templates().some(({ aliases }) => aliases)
      ? { ...saved, aliases: templateAliases(templateId()) }
      : saved;
  };

  // Admins keep models nobody here should use out of the pickers.
  const hidden = (): readonly string[] => config.get().hidden;

  context.provide.models(({ id, templateId }) => ({
    ...offered(effective(id, () => templateId).aliases),
    hidden: hidden(),
  }));

  routes.get(
    "config",
    { auth: "session", query: configQuery, long: true },
    async ({ caller, query, raw }) => {
      const { environmentId } = sessionOf(caller);

      // A Session polls again at once after any answer, and backs off only
      // after an error.
      if (query.after !== undefined) {
        if (context.signal.aborted) {
          throw new HttpError(503, "the server is stopping", "stopping");
        }

        await versions.changed(environmentId, query.after, raw.signal);
      }

      return {
        version: versions.of(environmentId),
        ...effective(
          environmentId,
          () =>
            environments.list().find(({ id }) => id === environmentId)
              ?.templateId ?? null,
        ),
      } satisfies SessionConfig;
    },
  );

  routes.post(
    "health",
    { auth: "session", body: healthReport },
    ({ caller, body }) => {
      const session = sessionOf(caller);
      const reported = healthFrom(body);
      if (reported === undefined) {
        throw new BadRequest(
          "model health report not understood",
          "invalid_health",
        );
      }

      const { environmentId } = session;
      const current = store.get(environmentId).health;
      const health = mergeHealth(current, reported, new Date(clock.now()));

      if (JSON.stringify(health) !== JSON.stringify(current)) {
        store.setHealth(environmentId, health);
        versions.bump(environmentId);

        log("model health changed", {
          environmentId,
          unhealthy: Object.keys(health.unhealthyUntil),
          session: session.id,
        });
      }

      return new Response(null, { status: 204 });
    },
  );

  routes.get("hidden", { auth: "person" }, ({ caller }) => ({
    hidden: hidden(),
    mayChange: caller.kind === "person" && caller.person.admin,
  }));

  routes.post(
    "hidden",
    { auth: "admin", body: hiddenChange, changes: ["hidden"] },
    ({ body }) => {
      const invalid = body.hidden.find((each) => modelRef(each) === undefined);

      if (invalid !== undefined) {
        throw new BadRequest(`${invalid} must be provider/id`);
      }

      config.set({ hidden: [...new Set(body.hidden)] });
      log("hidden models changed", { count: body.hidden.length });

      return { hidden: hidden(), mayChange: true };
    },
  );

  routes.get("environments", { auth: "person" }, () => store.all());

  routes.post(
    "environments/:id",
    { auth: "admin", body: aliasesChange },
    ({ params, body: { aliases } }) => {
      const environmentId = params["id"] ?? "";
      const problem = aliases === null ? undefined : aliasProblem(aliases);

      if (problem !== undefined) {
        throw new BadRequest(problem);
      }

      store.setAliases(environmentId, aliases);
      versions.bump(environmentId);
      log("aliases changed", { environmentId });

      return store.get(environmentId);
    },
  );
});

// The Session a session route's caller is, which the router guarantees.
function sessionOf(caller: Caller): Session {
  if (caller.kind !== "session") {
    throw new Forbidden("Only the plugin's Sessions call this.");
  }

  return caller.session;
}

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

function modelsStore(store: Store): ModelsStore {
  const savedAliases = (environmentId: string): AliasConfig | null => {
    const row = store.get<{ aliases: string | null }>(
      "select aliases from models_environments where environment_id = ?",
      environmentId,
    );

    return row === undefined || row.aliases === null
      ? null
      : storedAliases(JSON.parse(row.aliases));
  };

  const healthOf = (environmentId: string): Health => ({
    version: 1,
    unhealthyUntil: Object.fromEntries(
      store
        .all<HealthRow>(
          "select target, until, reason, quota_spent_micros, quota_cap_micros, quota_currency from models_health where environment_id = ? order by target",
          environmentId,
        )
        .map((row) => [
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
      store
        .all<{ environment_id: string }>(
          "select environment_id from models_environments union select environment_id from models_health",
        )
        .map(({ environment_id }) => get(environment_id)),
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
// so a Session that saw a version before a restart never sees it again. A
// wait ends after waitMs on the schedule.
function changes({
  clock,
  schedule,
  signal,
}: Pick<ServerContext, "clock" | "schedule" | "signal">): {
  readonly of: (environmentId: string) => number;
  readonly bump: (environmentId: string) => void;
  readonly changed: (
    environmentId: string,
    seen: number,
    request: AbortSignal,
  ) => Promise<void>;
} {
  const start = clock.now();
  const versions = new Map<string, number>();
  const waiting = new Map<string, Set<() => void>>();
  const timeouts = new Map<string, () => void>();

  schedule.on("wake:", (_payload, key) => {
    timeouts.get(key)?.();
  });

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
        const key = `wake:${randomUUID()}`;

        const wake = (): void => {
          schedule.cancel(key);
          timeouts.delete(key);
          request.removeEventListener("abort", wake);
          signal.removeEventListener("abort", wake);
          waiting.get(environmentId)?.delete(wake);
          resolve();
        };

        schedule.at(key, clock.now() + waitMs);
        timeouts.set(key, wake);

        const set = waiting.get(environmentId) ?? new Set();
        set.add(wake);
        waiting.set(environmentId, set);

        request.addEventListener("abort", wake, { once: true });
        signal.addEventListener("abort", wake, { once: true });
      });
    },
  };
}
