import { logins } from "@pipoca/logins/plugin";
import { defineServer, type Owner, owners, type Store, Type } from "@pipoca/plugins";
import { usage } from "../plugin";
import { auditedAction, auditLog, csv } from "./audit";

// One proxied model call of team work (ADR 0066).
interface Call {
  readonly at: string;
  readonly owner: Owner;
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

const budget = Type.Union([Type.Number({ exclusiveMinimum: 0 }), Type.Null()]);

const budgetsSet = Type.Object({ team: budget, person: budget });

const format = Type.Object({ format: Type.Optional(Type.Literal("csv")) });

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

// Records every call the proxy makes for team work, priced from the table
// admins keep in pipoca.json, so admins see all of it and each person their
// own and the team's totals (ADR 0066).
export const server = defineServer(
  usage,
  ({ clock, config, events, people, routes, sessions, store }) => {
    const calls = callStore(store);
    const audit = auditLog(store, clock);

    const audited = (event: Parameters<typeof auditedAction>[0]): void => {
      const entry = auditedAction(event);

      if (entry !== undefined) {
        audit.add(entry);
        routes.topic("audit");
      }
    };

    events.on("SessionCreated", audited);
    events.on("SessionArchived", audited);
    events.on("SessionUnarchived", audited);
    events.on("StopAsked", audited);
    events.on("SessionMoved", audited);
    events.on("AccessChanged", audited);

    const budgets = () => {
      const { team, person } = config.get().budgets;

      return {
        team: team > 0 ? team : null,
        person: person > 0 ? person : null,
      };
    };

    const warn = (
      person: string | null,
      limit: number,
      spent: number,
      cost: number,
    ): void => {
      for (const share of warnedShares) {
        const line = (limit * share) / 100;

        if (spent - cost < line && spent >= line) {
          events.emit(
            "budget_warned",
            { person, share, spent, limit },
            { to: person === null ? ["team"] : [`person:${person}`, "team"] },
          );
        }
      }
    };

    events.on(logins.events.model_called, ({ fields, to }) => {
      const price =
        config.get().prices[`${fields.provider}/${fields.model ?? ""}`];

      const call: Call = {
        at: new Date(clock.now()).toISOString(),
        owner: to.includes("team") ? "team" : (to[0] ?? "team"),
        person: fields.person,
        sessionId: fields.sessionId,
        provider: fields.provider,
        model: fields.model,
        input: fields.input,
        output: fields.output,
        cost:
          price === undefined
            ? null
            : (fields.input * price.input + fields.output * price.output) /
              1_000_000,
      };

      calls.add(call);
      routes.topic("totals");

      audit.add({
        actor: null,
        sessionId: call.sessionId,
        action: "used the team's key",
        detail: `${call.provider}/${call.model ?? ""}`,
      });

      routes.topic("audit");

      if (call.cost === null || call.cost === 0) {
        return;
      }

      const since = monthStart(clock.now());
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

    routes.put(
      "budgets",
      { auth: "admin", body: budgetsSet, changes: ["totals"] },
      ({ body }) => {
        config.set({
          budgets: { team: body.team ?? 0, person: body.person ?? 0 },
        });
      },
    );

    routes.get(
      "calls",
      { auth: "person", query: format },
      ({ caller: { person }, query }) => {
        const exported = query.format === "csv";

        const rows = calls.recent(
          person.admin ? undefined : person.id,
          exported ? undefined : shownCalls,
        );

        return exported ? csvResponse(csv(rows, callColumns), "usage") : rows;
      },
    );

    routes.get(
      "audit",
      { auth: "person", query: format },
      ({ caller: { person }, query }) => {
        const exported = query.format === "csv";

        const rows = audit.entries(
          person.admin ? undefined : `user:${person.id}`,
          exported ? undefined : shownCalls,
        );

        return exported ? csvResponse(csv(rows, auditColumns), "audit") : rows;
      },
    );

    // What people did to the team work the caller can see, for the hub.
    routes.get("activity", { auth: "person" }, ({ caller: { person } }) => {
      const actions = audit.actions(activityRead);

      const moved = new Set(
        actions
          .filter(({ action }) => action === "moved to the team")
          .map(({ sessionId }) => sessionId),
      );

      return actions
        .filter(
          ({ action, sessionId }) =>
            !(action === "started" && moved.has(sessionId)) &&
            sessions.sees(sessionId, person.id),
        )
        .slice(0, activityShown)
        .map(({ actor, ...action }) => ({
          ...action,
          name: people.get(actor?.slice("user:".length) ?? "")?.name ?? null,
        }));
    });

    routes.get("totals", { auth: "person" }, ({ caller: { person } }) => {
      const since = monthStart(clock.now());

      return {
        since: new Date(since).toISOString(),
        team: calls.totals(since),
        mine: calls.totals(since, person.id),
        budgets: budgets(),
      };
    });
  },
);

function csvResponse(body: string, name: string): Response {
  return new Response(body, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${name}.csv"`,
    },
  });
}

function monthStart(now: number): number {
  const at = new Date(now);

  return Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1);
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

const totalsOf =
  "select coalesce(sum(input), 0) as input, coalesce(sum(output), 0) as output, coalesce(sum(cost_micros), 0) / 1000000.0 as cost from usage_calls where at >= ?";

function callStore(store: Store): {
  readonly add: (call: Call) => void;
  readonly recent: (
    person: string | undefined,
    limit: number | undefined,
  ) => readonly Call[];
  readonly totals: (since: number, person?: string) => Totals;
} {
  return {
    add: (call) => {
      store.run(
        "insert into usage_calls (id, at, owner_user_id, person, session_id, provider, model, input, output, cost_micros) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        Bun.randomUUIDv7(),
        Date.parse(call.at),
        owners.toSql(call.owner),
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
      (person === undefined
        ? store.all<CallRow>(
            "select * from usage_calls order by id desc limit ?",
            limit,
          )
        : store.all<CallRow>(
            "select * from usage_calls where person = ? order by id desc limit ?",
            person,
            limit,
          )
      ).map(
        ({
          session_id: sessionId,
          at,
          cost_micros,
          owner_user_id,
          provider,
          model,
          input,
          output,
          person: asked,
        }) => ({
          at: new Date(at).toISOString(),
          owner: owners.fromSql(owner_user_id),
          person: asked,
          sessionId,
          provider,
          model,
          input,
          output,
          cost: cost_micros === null ? null : cost_micros / microsPerDollar,
        }),
      ),
    totals: (since, person) =>
      (person === undefined
        ? store.get<Totals>(totalsOf, since)
        : store.get<Totals>(`${totalsOf} and person = ?`, since, person)) ?? {
        input: 0,
        output: 0,
        cost: 0,
      },
  };
}
