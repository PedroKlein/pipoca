import {
  isObject,
  NotFound,
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

// Records every call the proxy makes for team work, priced from the table
// admins keep in pipoca.json, so admins see all of it and each person their
// own and the team's totals (ADR 0066).
export const usage: ServerPlugin = {
  name: "usage",
  register: (context) => {
    const calls = callStore(context.store);
    const audit = auditLog(context.store);

    const record = (event: Parameters<typeof auditedAction>[0]) => {
      const entry = auditedAction(event);

      if (entry !== undefined) {
        audit.add(entry);
      }
    };

    context.events.subscribe("SessionCreated", record);
    context.events.subscribe("SessionArchived", record);
    context.events.subscribe("SessionUnarchived", record);
    context.events.subscribe("StopAsked", record);

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

    context.routes.handle((request, path, caller) => {
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

interface CallRow {
  readonly at: string;
  readonly owner: string;
  readonly person: string | null;
  readonly session_id: string;
  readonly provider: string;
  readonly model: string | null;
  readonly input: number;
  readonly output: number;
  readonly cost: number | null;
}

function callStore(store: PluginStore): {
  readonly add: (call: Call) => void;
  readonly recent: (
    person: string | undefined,
    limit: number | undefined,
  ) => readonly Call[];
  readonly totals: (since: string, person?: string) => Totals;
} {
  store.exec(
    "create table if not exists usage_calls (id integer primary key, at text not null, owner text not null, person text, session_id text not null, provider text not null, model text, input integer not null, output integer not null, cost real)",
  );

  return {
    add: (call) => {
      store.run(
        "insert into usage_calls (at, owner, person, session_id, provider, model, input, output, cost) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        call.at,
        call.owner,
        call.person,
        call.sessionId,
        call.provider,
        call.model,
        call.input,
        call.output,
        call.cost,
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
      ).map(({ session_id: sessionId, ...row }) => ({ ...row, sessionId })),
    totals: (since, person) => {
      const [row] = (
        person === undefined
          ? store.all(
              "select coalesce(sum(input), 0) as input, coalesce(sum(output), 0) as output, coalesce(sum(cost), 0) as cost from usage_calls where at >= ?",
              since,
            )
          : store.all(
              "select coalesce(sum(input), 0) as input, coalesce(sum(output), 0) as output, coalesce(sum(cost), 0) as cost from usage_calls where at >= ? and person = ?",
              since,
              person,
            )
      ) as Totals[];

      return row ?? { input: 0, output: 0, cost: 0 };
    },
  };
}
