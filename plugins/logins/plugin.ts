import { Config, definePlugin, event, Type } from "@pipoca/plugins";

export const logins = definePlugin({
  id: "logins",
  title: "Logins",
  description:
    "Keeps each person's model provider and MCP server logins on the server, so their Sessions use them on every runner. Log in once with /login or /mcp login in any Session.",
  modelCredentials: true,
  config: Config.object({
    privateHosts: Config.strings({
      title:
        "MCP servers on private addresses that sign-ins from Settings may reach, as host or host:port",
      default: [],
    }),
  }),
  events: {
    model_called: event({
      title: "Team model call",
      description:
        "A team Session called a model through the server, with the team's key.",
      fields: Type.Object({
        sessionId: Type.String(),
        person: Type.Union([Type.String(), Type.Null()], {
          description: "Who started the Session, or null for a plugin",
        }),
        provider: Type.String(),
        model: Type.Union([Type.String(), Type.Null()]),
        input: Type.Number({ description: "Tokens in" }),
        output: Type.Number({ description: "Tokens out" }),
      }),
    }),
  },
  // A login is kept for the base, which is the team's (owner_user_id NULL),
  // a person's My defaults, or one of a person's Profiles (ADR 0063). Its
  // credential is sealed for its row.
  schema: `
create table logins_logins (
  id text primary key,
  kind text not null check (kind in ('model', 'mcp')),
  layer text not null check (layer in ('base', 'defaults', 'profile')),
  owner_user_id text references users (id) on delete cascade,
  profile_id text,
  name text not null,
  type text not null,
  credential text not null,
  updated_at integer not null,
  check ((layer = 'profile') = (profile_id is not null)),
  check ((layer = 'base') = (owner_user_id is null))
) strict;
create unique index logins_logins_key on logins_logins (kind, layer, coalesce(owner_user_id, ''), coalesce(profile_id, ''), name);
create index logins_logins_owner on logins_logins (owner_user_id);

create table logins_proxy_tokens (
  token_hash text primary key,
  session_id text not null references sessions (id) on delete cascade,
  created_at integer not null
) strict, without rowid;
create index logins_proxy_tokens_session on logins_proxy_tokens (session_id);
`,
});
