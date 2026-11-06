import { Config, definePlugin } from "@pipoca/plugins";

export const models = definePlugin({
  id: "models",
  title: "Models",
  description:
    "Model aliases per Environment, with fallbacks when a model fails.",
  config: Config.object({
    hidden: Config.strings({
      title: "Models kept out of the model pickers, as provider/id",
      default: [],
    }),
  }),
  // Benched models and providers are keyed by a provider, or a provider/id.
  schema: `
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
`,
});
