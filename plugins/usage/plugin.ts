import { Config, definePlugin, event, Type } from "@pipoca/plugins";

const dollars = (title: string) =>
  Config.number({
    title,
    description: "Dollars a month, 0 for none",
    default: 0,
    min: 0,
  });

export const usage = definePlugin({
  id: "usage",
  title: "Usage",
  description:
    "Shows a Session's token use and cost in its header, and records what team work spends through the server's proxy.",
  config: Config.object({
    // Dollars per million tokens of a model, keyed by provider/model, which
    // a collection's name can't hold.
    prices: Type.Record(
      Type.String({ minLength: 1 }),
      Type.Object({
        input: Type.Number({ minimum: 0 }),
        output: Type.Number({ minimum: 0 }),
      }),
      { title: "Model prices", default: {} },
    ),
    // Budgets only warn (ADR 0066).
    budgets: Config.object({
      team: dollars("The team's monthly budget"),
      person: dollars("Each person's monthly cap of team work"),
    }),
  }),
  events: {
    budget_warned: event({
      title: "Budget warning",
      description:
        "Team work reached 80% or 100% of the team's monthly budget or of one person's monthly cap.",
      fields: Type.Object({
        person: Type.Union([Type.String(), Type.Null()], {
          description: "Whose cap it is, or null for the team's budget",
        }),
        share: Type.Number({ description: "80 or 100" }),
        spent: Type.Number({ description: "Dollars spent this month" }),
        limit: Type.Number({ description: "The budget or cap in dollars" }),
      }),
    }),
  },
  // Calls and the audit are history, so they keep the ids of Sessions and
  // people that are gone. A call's owner_user_id is NULL for the team's
  // work. Cost is in millionths of a dollar.
  schema: `
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
`,
});
