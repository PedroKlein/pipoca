import {
  Config,
  definePlugin,
  Secret,
  type Static,
  Type,
} from "@pipoca/plugins";

const emails = Type.Optional(Type.Array(Type.String()));

const provider = Type.Object({
  id: Type.String(),
  label: Type.Optional(Type.String()),
  issuer: Type.String({ minLength: 1 }),
  clientId: Type.String({ minLength: 1 }),
  // Only for providers that need one even with PKCE, such as Google.
  clientSecret: Type.Optional(Secret({ env: true })),
  groupsClaim: Type.Optional(Type.String()),
  accessGroup: Type.Optional(Type.String()),
  adminGroup: Type.Optional(Type.String()),
  allowedEmails: emails,
  allowedDomains: emails,
  adminEmails: emails,
});

export type ProviderItem = Static<typeof provider>;

export const oidc = definePlugin({
  id: "oidc",
  title: "Sign-in",
  description:
    "Signs people in through any OpenID Connect provider you add, and lets in the groups or emails you choose. Admins add providers in Settings.",
  defaultOn: "team",
  config: Config.object({
    providers: Config.collection({
      key: "id",
      item: provider,
      admin: true,
      title: "Providers",
    }),
  }),
  // A person may link one identity per subject of each issuer.
  schema: `
create table oidc_identities (
  issuer text not null,
  subject text not null,
  user_id text not null references users (id) on delete cascade,
  email text,
  created integer not null check (created in (0, 1)),
  invited integer not null check (invited in (0, 1)),
  linked_at integer not null,
  signed_in_at integer,
  primary key (issuer, subject)
) strict, without rowid;
create index oidc_identities_user on oidc_identities (user_id);
create index oidc_identities_signed_in on oidc_identities (issuer, signed_in_at);
`,
});
