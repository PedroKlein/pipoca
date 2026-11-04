import {
  isObject,
  NotFound,
  type PluginEvent,
  type PluginStore,
  type RouteCaller,
  type ServerPlugin,
} from "@pipoca/plugins";

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

const shownCalls = 500;

// Records every call the proxy makes for team work, priced from the table
// admins keep in pipoca.json, so admins see all of it and each person their
// own and the team's totals (ADR 0066).
export const usage: ServerPlugin = {
  name: "usage",
  register: (context) => {
    const calls = callStore(context.store);

    const priceOf = (provider: string, model: string | null) => {
      const prices = objectAt(context.config.get(), "prices");
      const price = prices[`${provider}/${model ?? ""}`];

      return isPrice(price) ? price : undefined;
    };

    context.events.subscribe("logins.model_called", (event) => {
      const call = callOf(event, priceOf);

      if (call !== undefined) {
        calls.add(call);
      }
    });

    context.routes.handle((request, path, caller) => {
      if (caller.kind !== "user" || request.method !== "GET") {
        throw new NotFound(`no route ${path}`);
      }

      if (path === "calls") {
        return Response.json(
          calls.recent(caller.admin ? undefined : personOf(caller)),
        );
      }

      if (path === "totals") {
        const since = monthStart(new Date());

        return Response.json({
          since,
          team: calls.totals(since),
          mine: calls.totals(since, personOf(caller)),
        });
      }

      throw new NotFound(`no route ${path}`);
    });
  },
};

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
  readonly recent: (person?: string) => readonly Call[];
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
    recent: (person) =>
      (
        (person === undefined
          ? store.all(
              "select * from usage_calls order by id desc limit ?",
              shownCalls,
            )
          : store.all(
              "select * from usage_calls where person = ? order by id desc limit ?",
              person,
              shownCalls,
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
