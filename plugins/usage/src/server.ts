import {
  BadRequest,
  fieldsOf,
  isObject,
  NotFound,
  readJson,
  requireAdmin,
  type PluginEvent,
  type PluginStore,
  type RouteCaller,
  type ServerPlugin,
} from "@pipoca/plugins";
import { auditedAction, auditLog, csv } from "./audit";

// One proxied model call of team work (ADR 0066).
interface Call {
  readonly at: string;
  readonly owner: string;
  readonly person: string | null;
  readonly sessionId: string;
  readonly provider: string;
  readonly model: string | null;
  readonly input: number;
  readonly output: number;
  // Null for a model with no price in pipoca.json.
  readonly cost: number | null;
}

interface Totals {
  readonly input: number;
  readonly output: number;
  readonly cost: number;
}

// Dollars per million tokens, by "<provider>/<model>".
interface Price {
  readonly input: number;
  readonly output: number;
}

// Dollars a month, from "budgets" in pipoca.json: the team's whole spend and
// each person's share of it.
interface Budgets {
  readonly team: number | null;
  readonly person: number | null;
}

const shownCalls = 500;

const activityRead = 100;
const activityShown = 20;

const warnedShares = [80, 100] as const;

const callColumns = [
  "at",
  "owner",
  "person",
  "sessionId",
  "provider",
  "model",
  "input",
  "output",
  "cost",
] as const;

const auditColumns = ["at", "actor", "sessionId", "action", "detail"] as const;

// Calls and the audit are history, so they keep the ids of Sessions and
// people that are gone. A call's owner_user_id is NULL for the team's work.
// Cost is in millionths of a dollar.
const schema = `
create table usage_calls (
  id integer primary key,
  at integer not null,
  owner_user_id text,
  person text,
  session_id text not null,
  provider text not null,
  model text,
  input integer not null,
  output integer not null,
  cost_micros integer
) strict;
create index usage_calls_at on usage_calls (at);
create index usage_calls_person on usage_calls (person, at);

create table usage_audit (
  id integer primary key,
  at integer not null,
  actor text,
  session_id text not null,
  action text not null,
  detail text
) strict;
create index usage_audit_actor on usage_audit (actor, id);
`;

// Records every call the proxy makes for team work, priced from the table
// admins keep in pipoca.json, so admins see all of it and each person their
// own and the team's totals (ADR 0066).
export const usage: ServerPlugin = {
  name: "usage",
  schema,
  register: (context) => {
    const calls = callStore(context.store);
    const audit = auditLog(context.store);

    const record = (event: Parameters<typeof auditedAction>[0]) => {
      const entry = auditedAction(event);

      if (entry !== undefined) {
        audit.add(entry);
        context.changes.publish("audit");
      }
    };

    context.events.subscribe("SessionCreated", record);
    context.events.subscribe("SessionArchived", record);
    context.events.subscribe("SessionUnarchived", record);
    context.events.subscribe("StopAsked", record);
    context.events.subscribe("SessionMoved", record);
    context.events.subscribe("AccessChanged", record);

    const priceOf = (provider: string, model: string | null) => {
      const prices = objectAt(context.config.get(), "prices");
      const price = prices[`${provider}/${model ?? ""}`];

      return isPrice(price) ? price : undefined;
    };

    const budgets = (): Budgets => {
      const set = objectAt(context.config.get(), "budgets");

      return { team: dollars(set["team"]), person: dollars(set["person"]) };
    };

    const warn = (
      person: string | null,
      limit: number,
      spent: number,
      cost: number,
    ) => {
      for (const share of warnedShares) {
        const line = (limit * share) / 100;

        if (spent - cost < line && spent >= line) {
          context.events.publish({
            type: "usage.budget_warned",
            person,
            share,
            spent,
            limit,
          });
        }
      }
    };

    context.events.subscribe("logins.model_called", (event) => {
      const call = callOf(event, priceOf);

      if (call === undefined) {
        return;
      }

      calls.add(call);
      context.changes.publish("totals");

      audit.add({
        actor: null,
        sessionId: call.sessionId,
        action: "used the team's key",
        detail: `${call.provider}/${call.model ?? ""}`,
      });

      context.changes.publish("audit");

      if (call.cost === null || call.cost === 0) {
        return;
      }

      const since = monthStart(new Date());
      const { team, person } = budgets();

      if (team !== null) {
        warn(null, team, calls.totals(since).cost, call.cost);
      }

      if (person !== null && call.person !== null) {
        warn(
          call.person,
          person,
          calls.totals(since, call.person).cost,
          call.cost,
        );
      }
    });

    context.routes.handle(async (request, path, caller) => {
      if (caller.kind === "user" && request.method === "PUT") {
        if (path !== "budgets") {
          throw new NotFound(`no route ${path}`);
        }

        requireAdmin(caller, "Only admins set the team's budgets.");

        const set = budgetsOf(await readJson(request));
        const config = context.config.get();

        context.config.set({
          ...(isObject(config) ? config : {}),
          budgets: set,
        });

        context.changes.publish("totals");

        return new Response(null, { status: 204 });
      }

      if (caller.kind !== "user" || request.method !== "GET") {
        throw new NotFound(`no route ${path}`);
      }

      const exported =
        new URL(request.url).searchParams.get("format") === "csv";

      const limit = exported ? undefined : shownCalls;

      if (path === "calls") {
        const rows = calls.recent(
          caller.admin ? undefined : personOf(caller),
          limit,
        );

        return exported
          ? csvResponse(csv(rows, callColumns), "usage")
          : Response.json(rows);
      }

      if (path === "audit") {
        const rows = audit.entries(
          caller.admin ? undefined : caller.actor,
          limit,
        );

        return exported
          ? csvResponse(csv(rows, auditColumns), "audit")
          : Response.json(rows);
      }

      // What people did to the team work the caller can see, for the hub.
      if (path === "activity") {
        const person = personOf(caller);
        const actions = audit.actions(activityRead);

        const moved = new Set(
          actions
            .filter(({ action }) => action === "moved to the team")
            .map(({ sessionId }) => sessionId),
        );

        return Response.json(
          actions
            .filter(
              ({ action, sessionId }) =>
                !(action === "started" && moved.has(sessionId)) &&
                context.sessions.sees(sessionId, person),
            )
            .slice(0, activityShown),
        );
      }

      if (path === "totals") {
        const since = monthStart(new Date());

        return Response.json({
          since,
          team: calls.totals(since),
          mine: calls.totals(since, personOf(caller)),
          budgets: budgets(),
        });
      }

      throw new NotFound(`no route ${path}`);
    });
  },
};

function csvResponse(body: string, name: string): Response {
  return new Response(body, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${name}.csv"`,
    },
  });
}

function personOf(caller: RouteCaller & { readonly kind: "user" }): string {
  return caller.actor.slice("user:".length);
}

function monthStart(now: Date): string {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  ).toISOString();
}

function callOf(
  event: PluginEvent,
  priceOf: (provider: string, model: string | null) => Price | undefined,
): Call | undefined {
  const { sessionId, owner, person, provider, model, input, output } = event;

  if (
    typeof sessionId !== "string" ||
    typeof owner !== "string" ||
    typeof provider !== "string" ||
    typeof input !== "number" ||
    typeof output !== "number"
  ) {
    return undefined;
  }

  const named = typeof model === "string" ? model : null;
  const price = priceOf(provider, named);

  return {
    at: new Date().toISOString(),
    owner,
    person: typeof person === "string" ? person : null,
    sessionId,
    provider,
    model: named,
    input,
    output,
    cost:
      price === undefined
        ? null
        : (input * price.input + output * price.output) / 1_000_000,
  };
}

function budgetsOf(body: unknown): Budgets {
  const fields = fieldsOf(body);

  const amount = (key: keyof Budgets): number | null => {
    const value = fields[key];

    if (value === null || value === undefined) {
      return null;
    }

    if (typeof value !== "number" || !(value > 0)) {
      throw new BadRequest(`${key} must be dollars above zero, or null`);
    }

    return value;
  };

  return { team: amount("team"), person: amount("person") };
}

function dollars(value: unknown): number | null {
  return typeof value === "number" && value > 0 ? value : null;
}

function isPrice(value: unknown): value is Price {
  return (
    isObject(value) &&
    typeof value["input"] === "number" &&
    typeof value["output"] === "number"
  );
}

function objectAt(value: unknown, key: string): Record<string, unknown> {
  const inner = isObject(value) ? value[key] : undefined;

  return isObject(inner) ? inner : {};
}

const microsPerDollar = 1_000_000;

interface CallRow {
  readonly at: number;
  readonly owner_user_id: string | null;
  readonly person: string | null;
  readonly session_id: string;
  readonly provider: string;
  readonly model: string | null;
  readonly input: number;
  readonly output: number;
  readonly cost_micros: number | null;
}

function callStore(store: PluginStore): {
  readonly add: (call: Call) => void;
  readonly recent: (
    person: string | undefined,
    limit: number | undefined,
  ) => readonly Call[];
  readonly totals: (since: string, person?: string) => Totals;
} {
  return {
    add: (call) => {
      store.run(
        "insert into usage_calls (at, owner_user_id, person, session_id, provider, model, input, output, cost_micros) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        Date.parse(call.at),
        call.owner.startsWith("person:")
          ? call.owner.slice("person:".length)
          : null,
        call.person,
        call.sessionId,
        call.provider,
        call.model,
        call.input,
        call.output,
        call.cost === null ? null : Math.round(call.cost * microsPerDollar),
      );
    },
    recent: (person, limit = -1) =>
      (
        (person === undefined
          ? store.all(
              "select * from usage_calls order by id desc limit ?",
              limit,
            )
          : store.all(
              "select * from usage_calls where person = ? order by id desc limit ?",
              person,
              limit,
            )) as CallRow[]
      ).map(
        ({
          session_id: sessionId,
          at,
          cost_micros,
          owner_user_id,
          ...row
        }) => ({
          ...row,
          owner: owner_user_id === null ? "team" : `person:${owner_user_id}`,
          at: new Date(at).toISOString(),
          sessionId,
          cost: cost_micros === null ? null : cost_micros / microsPerDollar,
        }),
      ),
    totals: (since, person) => {
      const [row] = (
        person === undefined
          ? store.all(
              "select coalesce(sum(input), 0) as input, coalesce(sum(output), 0) as output, coalesce(sum(cost_micros), 0) / 1000000.0 as cost from usage_calls where at >= ?",
              Date.parse(since),
            )
          : store.all(
              "select coalesce(sum(input), 0) as input, coalesce(sum(output), 0) as output, coalesce(sum(cost_micros), 0) / 1000000.0 as cost from usage_calls where at >= ? and person = ?",
              Date.parse(since),
              person,
            )
      ) as Totals[];

      return row ?? { input: 0, output: 0, cost: 0 };
    },
  };
}
