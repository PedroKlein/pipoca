import type {
  AuthType,
  Credential,
  CredentialStore,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  BadRequest,
  HttpError,
  type McpLoginState,
  NotFound,
  type PluginStore,
  type SqlValue,
  readBody,
  requireAdmin,
  type RouteCaller,
  type ServerPlugin,
  type ServerPluginContext,
  Type,
} from "@pipoca/plugins";
import type { ModelRef } from "@pipoca/protocol";
import { callbacks, callbackUrl } from "./callback";
import { connections, modelSignIn } from "./connect";
import {
  forward,
  proxyTokens,
  tokenOf,
  type Upstream,
  upstreams,
} from "./proxy";
import { type Locks, locks } from "./locks";
import {
  type McpOAuthState,
  type McpOAuthStateStore,
  mcpSignIn,
  signableServers,
} from "./mcp";
import {
  type Account,
  type Connectable,
  credentialOf,
  type Lease,
  type LoginLayer,
  mcpStateOf,
  type Stored,
} from "./model";

const text = Type.String({ minLength: 1 });

const layer = Type.Optional(Type.String());

const savedLogin = Type.Object({
  provider: text,
  credential: Type.Unknown(),
  layer,
});

const modelConnect = Type.Object({
  provider: text,
  type: Type.String(),
  layer,
});

const mcpConnect = Type.Object({ server: text, layer });

// The rows of the server's base are kept under this, which no user id is.
const baseOwner = "*base";
const promptAnswer = Type.Object({ prompt: text, answer: text });

// A value of null removes the login, and none keeps it.
const leaseRelease = Type.Object({
  lease: Type.String(),
  value: Type.Optional(Type.Unknown()),
});

// Long enough for a token refresh, short enough that a runner that went away
// doesn't keep everyone else out for long.
const holdMs = 60_000;
// Under the server's idle timeout, so a waiting runner hears back and asks
// again instead of having its request cut.
const waitMs = 20_000;

// Each person's model and MCP logins live on the server, and their Sessions
// read and write them through it on every runner (ADR 0045).
// A login is kept for the base, a person's My defaults, or a person's
// Profile, so Sessions on that Profile use it.
const schema = `
create table logins_logins (
  id integer primary key,
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
`;

export const logins: ServerPlugin = {
  name: "logins",
  schema: schema,
  register: (context) => {
    const leases = locks(holdMs, waitMs);

    const models = loginKind(context, leases, {
      name: "credentials",
      kind: "model",
      valid: credentialOf,
      typeOf: ({ type }) => type,
    });

    // Pi keeps one state per MCP server, with its client registration and
    // tokens, keyed by the server's name and address.
    const mcp = loginKind(context, leases, {
      name: "mcp",
      kind: "mcp",
      valid: mcpStateOf,
      typeOf: () => "oauth",
    });

    // Pi's own providers and models, for the models a person's logins reach
    // and the providers Settings can sign them in to. Providers that
    // extensions add are already in the runners' lists, and take /login in a
    // Session.
    let catalog: readonly ModelRef[] = [];
    let connectable: readonly Connectable[] = [];
    let proxied: ReadonlyMap<string, Upstream> = new Map();

    void ModelRuntime.create({ modelsPath: null, allowModelNetwork: false })
      .then((runtime) => {
        catalog = runtime
          .getModels()
          .map(({ provider, id }) => ({ provider, id }));

        proxied = upstreams(runtime.getModels());

        connectable = runtime.getProviders().flatMap(({ id, name, auth }) => {
          const methods = [
            ...(auth.oauth
              ? [
                  {
                    type: "oauth" as const,
                    label: auth.oauth.loginLabel ?? auth.oauth.name,
                  },
                ]
              : []),
            ...(auth.apiKey?.login
              ? [{ type: "api_key" as const, label: "API key" }]
              : []),
          ];

          return methods.length === 0 ? [] : [{ id, name, methods }];
        });
      })
      .catch((error: unknown) => {
        context.log("models not listed", { error: String(error) });
      });

    // Team work never uses a person's logins, so a team Environment offers
    // the models the team's keys reach through the proxy (ADR 0066).
    context.models.offer((environment, userId) => {
      if (environment.ownerId === "team") {
        const providers = new Set(teamProviders());

        return {
          models: catalog.filter(({ provider }) => providers.has(provider)),
        };
      }

      if (userId === undefined) {
        return { models: [] };
      }

      const providers = new Set(models.mine(userId).map(({ key }) => key));

      return {
        models: catalog.filter(({ provider }) => providers.has(provider)),
      };
    });

    const signIns = connections(() => {
      context.changes.publish("logins");
    }, context.log);

    const returns = callbacks();

    const tokens = proxyTokens(context.store);

    // The team's API keys on the base, which team Sessions reach only
    // through the proxy.
    const teamProviders = (): readonly string[] =>
      [...proxied.keys()].filter(
        (provider) => models.get(baseOwner, provider)?.type === "api_key",
      );

    // The team's API keys on the base the proxy can't carry, which go to
    // team Sessions' runners.
    const runnerKeys = (): readonly Stored[] =>
      models
        .list(baseOwner)
        .filter(({ key, type }) => type === "api_key" && !proxied.has(key));

    // Providers an extension adds on the runners. The server can't run their
    // sign-in, so an admin pastes their key.
    const extensionProviders = (): readonly Connectable[] => {
      const known = new Set(connectable.map(({ id }) => id));

      const added = new Set(
        context.environments
          .list()
          .flatMap(({ models: offered }) =>
            offered.map(({ provider }) => provider),
          )
          .filter((provider) => !known.has(provider)),
      );

      return [...added].sort().map((id) => ({
        id,
        name: id,
        methods: [{ type: "api_key", label: "Paste a key" }],
        paste: true,
      }));
    };

    // A team Session's model call, with its token in place of the key
    // (ADR 0066).
    const proxy = async (
      request: Request,
      provider: string,
      rest: string,
    ): Promise<Response> => {
      const upstream = proxied.get(provider);
      if (upstream === undefined) {
        throw new NotFound(`no proxy for ${provider}`);
      }

      const token = tokenOf(request, upstream.header);

      const session =
        token === undefined
          ? undefined
          : context.sessions.get(tokens.sessionOf(token) ?? "");

      if (session?.ownedBy !== "team" || session.archivedAt !== null) {
        throw new HttpError(401, "not a team Session's token", "unauthorized");
      }

      const key = models.get(baseOwner, provider);
      if (key?.type !== "api_key" || key.key === undefined) {
        throw new HttpError(
          403,
          `the team has no API key for ${provider}`,
          "no_team_key",
        );
      }

      const answer = await forward(
        request,
        upstream,
        rest,
        key.key,
        ({ model, input, output }) => {
          context.events.publish({
            type: "logins.model_called",
            sessionId: session.id,
            owner: session.ownedBy,
            person: session.startedBy,
            provider,
            model,
            input,
            output,
          });
        },
      );

      context.log("model call proxied", {
        sessionId: session.id,
        provider,
        status: answer.status,
      });

      return answer;
    };

    context.auth.handlePublic(async (request, path) => {
      if (request.method === "GET" && path === "callback") {
        return returns.handle(request);
      }

      const [first, provider = "", ...rest] = path.split("/");

      return first === "proxy"
        ? await proxy(request, provider, rest.join("/"))
        : undefined;
    });

    const servers = () => signableServers(context.profiles.mcpServers());

    const account = (userId: string, admin: boolean): Account => ({
      admin,
      logins: models.mine(userId).map(({ key, type, updatedAt, owner }) => ({
        provider: key,
        type: type as Credential["type"],
        updatedAt,
        layer: layerOf(userId, owner),
      })),
      mcp: mcp.mine(userId).map(({ key, updatedAt, owner }) => ({
        server: key,
        updatedAt,
        layer: layerOf(userId, owner),
      })),
      servers: servers().map(({ key, name, url }) => ({
        key,
        name,
        url,
      })),
      ...withConnection(signIns.current(userId)),
    });

    context.routes.handle(async (request, path, caller) => {
      const userId = userOf(caller);
      const [route = "", key = "", action] = path.split("/");
      const kind = [models, mcp].find(({ name }) => name === route);

      if (caller.kind === "session" && route === "proxy") {
        const team = caller.session.ownedBy === "team";
        const origin = new URL(request.url).origin;

        return Response.json({
          providers: team
            ? teamProviders().map((provider) => ({
                provider,
                baseUrl: `${origin}/api/plugins/logins/proxy/${provider}`,
              }))
            : [],
          ...(team && { token: tokens.issue(caller.session.id) }),
        });
      }

      if (caller.kind === "session") {
        if (kind === undefined) {
          throw new NotFound(`no route ${path}`);
        }

        // Team work never uses a person's logins (ADR 0066). It reads the
        // base's keys the proxy can't carry, such as an extension
        // provider's, and saves none.
        if (caller.session.ownedBy === "team") {
          if (key !== "") {
            throw new HttpError(403, "team work keeps no logins", "team_work");
          }

          const handed = kind === models ? runnerKeys() : [];

          return Response.json(
            new URL(request.url).searchParams.has("values")
              ? Object.fromEntries(
                  handed.flatMap(({ key: provider }) => {
                    const value = models.get(baseOwner, provider);

                    return value === undefined ? [] : [[provider, value]];
                  }),
                )
              : handed.map(({ key: provider, type }) => ({
                  key: provider,
                  type,
                })),
          );
        }

        const { profileId } = caller.session;

        const owners = [
          ...[profileId, ...context.profiles.buildsOn(profileId)].map((id) =>
            profileOwner(userId, id),
          ),
          userId,
          baseOwner,
        ];

        return await kind.sessionRoute(request, owners, key, action);
      }

      // Only admins put a login on the base, and only an API key: a
      // subscription stays its person's (ADR 0063).
      const ownerFor = (
        wanted: string | undefined,
        apiKey: boolean,
      ): string => {
        const owner = ownerOf(userId, wanted);

        if (owner === baseOwner && !(caller.admin && apiKey)) {
          throw new HttpError(
            403,
            "only admins put a login on the server base, and only an API key",
            "admin_only",
          );
        }

        return owner;
      };

      // Which of the team's keys team work reaches only through the proxy,
      // so their runners never hold them (ADR 0066).
      if (route === "team-keys" && request.method === "GET") {
        requireAdmin(caller, "Only admins see the team's keys.");

        return Response.json(
          models.list(baseOwner).map(({ key: provider, type }) => ({
            provider,
            proxied: type === "api_key" && proxied.has(provider),
          })),
        );
      }

      if (route === "account" && request.method === "GET") {
        return Response.json(account(userId, caller.admin));
      }

      if (route === "save" && request.method === "POST") {
        const body = await readBody(request, savedLogin);
        const credential = models.validated(body.credential);

        const saved = await models.write(
          ownerFor(body.layer, credential.type === "api_key"),
          body.provider,
          credential,
        );

        if (!saved) {
          throw busy();
        }

        return Response.json(account(userId, caller.admin));
      }

      if (route === "providers" && request.method === "GET") {
        return Response.json(
          caller.admin
            ? [...connectable, ...extensionProviders()]
            : connectable,
        );
      }

      if (route === "connect" && request.method === "POST") {
        const {
          provider,
          type,
          layer: wanted,
        } = await readBody(request, modelConnect);

        const offered = connectable.find(({ id }) => id === provider);

        if (offered?.methods.some((method) => method.type === type) !== true) {
          throw new BadRequest(`${provider} takes no such login`);
        }

        signIns.start(
          userId,
          { key: provider, name: offered.name },
          modelSignIn(
            credentialsOf(models, ownerFor(wanted, type === "api_key")),
            provider,
            type as AuthType,
          ),
        );

        return Response.json(account(userId, caller.admin));
      }

      if (route === "connect-mcp" && request.method === "POST") {
        const { server: wanted, layer: on } = await readBody(
          request,
          mcpConnect,
        );

        const server = servers().find(({ key: each }) => each === wanted);

        if (server === undefined) {
          throw new BadRequest(`no MCP server ${wanted} to sign in to`);
        }

        const owner = ownerFor(on, false);

        const browser = returns.browser(request);

        signIns.start(
          userId,
          { key: server.key, name: server.name },
          mcpSignIn(
            server,
            mcpStateOfUser(mcp, owner, server.key),
            callbackUrl(request),
            returns.wait(browser.id),
          ),
        );

        return Response.json(account(userId, caller.admin), {
          headers: { "set-cookie": browser.cookie },
        });
      }

      if (
        route === "connection" &&
        key === "answer" &&
        request.method === "POST"
      ) {
        const { prompt, answer } = await readBody(request, promptAnswer);
        const answered = signIns.answer(userId, prompt, answer);

        if (!answered) {
          throw new HttpError(
            409,
            "the sign-in isn't waiting for that answer",
            "not_asked",
          );
        }

        return Response.json(account(userId, caller.admin));
      }

      if (route === "connection" && request.method === "DELETE") {
        signIns.dismiss(userId);

        return Response.json(account(userId, caller.admin));
      }

      if (kind !== undefined && key !== "" && request.method === "DELETE") {
        const wanted = new URL(request.url).searchParams.get("layer");

        const removed = await kind.write(
          ownerFor(wanted ?? undefined, kind === models),
          decodeURIComponent(key),
          null,
        );

        if (!removed) {
          throw busy();
        }

        return Response.json(account(userId, caller.admin));
      }

      throw new NotFound(`no route ${path}`);
    });
  },
};

function withConnection(
  connection: Account["connection"],
): Pick<Account, "connection"> {
  return connection === undefined ? {} : { connection };
}

// The person's model logins as Pi reads and writes them while it signs them
// in on the server.
function credentialsOf(
  models: LoginKind<Credential>,
  userId: string,
): CredentialStore {
  return {
    read: async (providerId) => Promise.resolve(models.get(userId, providerId)),
    list: async () =>
      Promise.resolve(
        models.list(userId).map(({ key, type }) => ({
          providerId: key,
          type: type as Credential["type"],
        })),
      ),
    modify: async (providerId, fn) => models.modify(userId, providerId, fn),
    delete: async (providerId) => {
      await models.modify(userId, providerId, async () =>
        Promise.resolve(null),
      );
    },
  };
}

// One MCP server's sign-in state in the person's logins, as Pi's MCP sign-in
// reads and writes it.
function mcpStateOfUser(
  mcp: LoginKind<McpLoginState>,
  userId: string,
  key: string,
): McpOAuthStateStore {
  return {
    load: () => mcp.get(userId, key) as McpOAuthState | undefined,
    save: async (state) => {
      await mcp.modify(userId, key, async () =>
        Promise.resolve(state as unknown as McpLoginState),
      );
    },
  };
}

// Rows are kept per owner: the base, the person for their My defaults, or
// the person and one of their Profiles.
function profileOwner(userId: string, profileId: string): string {
  return `${userId}:${profileId}`;
}

function ownerOf(userId: string, wanted: string | undefined): string {
  if (wanted === undefined || wanted === "defaults") {
    return userId;
  }

  if (wanted === "base") {
    return baseOwner;
  }

  const profileId = /^profile:([a-z0-9][a-z0-9._-]{0,63})$/.exec(wanted)?.[1];

  if (profileId === undefined) {
    throw new BadRequest(`no login layer ${wanted}`);
  }

  return profileOwner(userId, profileId);
}

function layerOf(userId: string, owner: string): LoginLayer {
  if (owner === baseOwner) {
    return "base";
  }

  return owner === userId
    ? "defaults"
    : `profile:${owner.slice(userId.length + 1)}`;
}

// Another Session of the person's holds the login, so the caller asks again.
function busy(): HttpError {
  return new HttpError(409, "another Session is changing this login", "busy");
}

// A Session uses the logins of the person who started it, or who started the
// Session that started it, as git hosts do (ADR 0043).
function userOf(caller: RouteCaller): string {
  return caller.kind === "session"
    ? (caller.session.startedBy ?? caller.session.ownerId)
    : caller.actor.slice("user:".length);
}

interface KindSpec<T> {
  // The first part of the Session routes.
  readonly name: string;
  readonly kind: "model" | "mcp";
  readonly valid: (value: unknown) => T;
  readonly typeOf: (value: T) => string;
}

interface LoginKind<T> {
  readonly name: string;
  readonly list: (owner: string) => readonly Stored[];
  // The person's logins on every layer: the base, their My defaults and
  // their Profiles'.
  readonly mine: (userId: string) => readonly Owned[];
  readonly get: (userId: string, key: string) => T | undefined;
  readonly validated: (value: unknown) => T;
  // Reads and writes the login under its lease. fn returns the new login,
  // null to remove it, or undefined to keep it. Throws LoginBusy when the
  // lease stays taken.
  readonly modify: (
    userId: string,
    key: string,
    fn: (current: T | undefined) => Promise<T | null | undefined>,
  ) => Promise<T | undefined>;
  // Takes the key's lease to write, or says false when it stays busy. Null
  // removes the login.
  readonly write: (
    userId: string,
    key: string,
    value: T | null,
  ) => Promise<boolean>;
  // What a Session asks for: every login's key, every value, or a lease on
  // one to read, refresh and write back. Owners are its layers, nearest
  // first, ending with the person's My defaults and the base.
  readonly sessionRoute: (
    request: Request,
    owners: readonly string[],
    key: string | undefined,
    action: string | undefined,
  ) => Promise<Response>;
}

interface Owned extends Stored {
  readonly owner: string;
}

function loginKind<T>(
  context: Pick<ServerPluginContext, "store" | "changes" | "log">,
  leases: Locks,
  spec: KindSpec<T>,
): LoginKind<T> {
  const rows = sealedRows(context.store, spec);

  const leaseKey = (userId: string, key: string): string =>
    `${spec.name}\u0000${userId}\u0000${key}`;

  const validated = (value: unknown): T => {
    try {
      return spec.valid(value);
    } catch (error) {
      throw new BadRequest(
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  const store = (userId: string, key: string, value: T | null): void => {
    const known = rows.get(userId, key) !== undefined;

    if (value === null) {
      rows.remove(userId, key);
    } else {
      rows.save(userId, key, value);
    }

    if (value === null || !known) {
      context.log(value === null ? "login removed" : "login saved", {
        kind: spec.name,
        userId,
        key,
      });
    }

    context.changes.publish("logins");
  };

  // A Session reads the nearest layer's login, and writes back to it, or to
  // the person's My defaults for one it reads from the base or doesn't have.
  const placed = (
    owners: readonly string[],
    key: string,
  ): { readonly from: string | undefined; readonly to: string } => {
    const from = owners.find((owner) => rows.get(owner, key) !== undefined);
    const mine = owners.at(-2) ?? "";

    return { from, to: from === undefined || from === baseOwner ? mine : from };
  };

  const lease = async (
    owners: readonly string[],
    key: string,
  ): Promise<Response> => {
    const { from, to } = placed(owners, key);

    const given = await leases.acquire(leaseKey(to, key));
    if (given === undefined) {
      throw busy();
    }

    const body: Lease<T> = {
      lease: given,
      value: (from === undefined ? undefined : rows.get(from, key)) ?? null,
    };

    return Response.json(body);
  };

  const release = async (
    request: Request,
    owners: readonly string[],
    key: string,
  ): Promise<Response> => {
    const { lease: given, value } = await readBody(request, leaseRelease);

    const next =
      value === undefined || value === null ? value : validated(value);

    const { to } = placed(owners, key);

    // A lapsed lease may have let another runner write since, so its write
    // would undo theirs.
    const held = leaseKey(to, key);
    if (next !== undefined && !leases.holds(held, given)) {
      throw new HttpError(
        409,
        "the lease lapsed, so this write could undo another",
        "lease_lapsed",
      );
    }

    if (next !== undefined) {
      store(to, key, next);
    }

    leases.release(held, given);

    return Response.json({ ok: true });
  };

  const modify: LoginKind<T>["modify"] = async (userId, key, fn) => {
    const held = leaseKey(userId, key);
    const given = await leases.acquire(held);
    if (given === undefined) {
      throw new LoginBusy();
    }

    try {
      const current = rows.get(userId, key);
      const next = await fn(current);

      if (next !== undefined) {
        store(userId, key, next);
      }

      return next === undefined ? current : (next ?? undefined);
    } finally {
      leases.release(held, given);
    }
  };

  return {
    name: spec.name,
    list: rows.list,
    mine: rows.mine,
    get: rows.get,
    validated,
    modify,
    write: async (userId, key, value) => {
      try {
        await modify(userId, key, async () => Promise.resolve(value));

        return true;
      } catch (error) {
        if (error instanceof LoginBusy) {
          return false;
        }

        throw error;
      }
    },
    sessionRoute: async (request, owners, rawKey, action) => {
      if (rawKey === undefined || rawKey === "") {
        const nearest = new Map<string, { owner: string; type: string }>();

        for (const owner of owners) {
          for (const { key, type } of rows.list(owner)) {
            if (!nearest.has(key)) {
              nearest.set(key, { owner, type });
            }
          }
        }

        return Response.json(
          new URL(request.url).searchParams.has("values")
            ? Object.fromEntries(
                [...nearest].flatMap(([key, { owner }]) => {
                  const value = rows.get(owner, key);

                  return value === undefined ? [] : [[key, value]];
                }),
              )
            : [...nearest].map(([key, { type }]) => ({ key, type })),
        );
      }

      const key = decodeURIComponent(rawKey);

      if (action === "lock" && request.method === "POST") {
        return lease(owners, key);
      }

      if (action === "release" && request.method === "POST") {
        return release(request, owners, key);
      }

      throw new NotFound(`no route ${spec.name}/${rawKey}`);
    },
  };
}

interface SealedRows<T> {
  readonly list: (userId: string) => readonly Stored[];
  readonly mine: (userId: string) => readonly Owned[];
  readonly get: (userId: string, key: string) => T | undefined;
  readonly save: (userId: string, key: string, value: T) => void;
  readonly remove: (userId: string, key: string) => void;
}

interface LoginRow {
  readonly layer: "base" | "defaults" | "profile";
  readonly owner_user_id: string | null;
  readonly profile_id: string | null;
  readonly key: string;
  readonly type: string;
  readonly updated_at: number;
}

// The owner the routes name a row by: the base, a person, or a person and
// one of their Profiles.
function rowOwner(row: LoginRow): string {
  if (row.layer === "base") {
    return baseOwner;
  }

  return row.profile_id === null
    ? (row.owner_user_id ?? "")
    : profileOwner(row.owner_user_id ?? "", row.profile_id);
}

function ownerColumns(
  owner: string,
): readonly [LoginRow["layer"], string | null, string | null] {
  if (owner === baseOwner) {
    return ["base", null, null];
  }

  const [userId = "", profileId] = owner.split(/:(.*)/);

  return profileId === undefined
    ? ["defaults", userId, null]
    : ["profile", userId, profileId];
}

const ownerMatch =
  "layer = ? and owner_user_id is ? and profile_id is ? and name = ?";

// A login is state people create as they go, so it lives in SQLite, sealed
// for its user and key (ADR 0039).
function sealedRows<T>(
  store: PluginStore,
  { kind, valid, typeOf }: KindSpec<T>,
): SealedRows<T> {
  const sealedFor = (userId: string, key: string): string => `${userId} ${key}`;

  const rows = (where: string, ...params: SqlValue[]): readonly LoginRow[] =>
    store.all(
      `select layer, owner_user_id, profile_id, name as key, type, updated_at from logins_logins where kind = ? and (${where}) order by name, case layer when 'base' then 0 when 'defaults' then 1 else 2 end, profile_id`,
      kind,
      ...params,
    ) as LoginRow[];

  return {
    list: (userId) =>
      rows(
        "layer = ? and owner_user_id is ? and profile_id is ?",
        ...ownerColumns(userId),
      ).map(({ key, type, updated_at }) => ({
        key,
        type,
        updatedAt: new Date(updated_at).toISOString(),
      })),
    mine: (userId) =>
      rows("layer = 'base' or owner_user_id = ?", userId).map((row) => ({
        owner: rowOwner(row),
        key: row.key,
        type: row.type,
        updatedAt: new Date(row.updated_at).toISOString(),
      })),
    // A login sealed under another server key can't be opened, and reads as
    // logged out.
    get: (userId, key) => {
      const [row] = store.all(
        `select credential from logins_logins where kind = ? and ${ownerMatch}`,
        kind,
        ...ownerColumns(userId),
        key,
      ) as { credential: string }[];

      if (row === undefined) {
        return undefined;
      }

      try {
        return valid(
          JSON.parse(store.open(row.credential, sealedFor(userId, key))),
        );
      } catch {
        return undefined;
      }
    },
    save: (userId, key, value) => {
      store.run(
        `insert into logins_logins (kind, layer, owner_user_id, profile_id, name, type, credential, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)
         on conflict (kind, layer, coalesce(owner_user_id, ''), coalesce(profile_id, ''), name) do update set type = excluded.type, credential = excluded.credential, updated_at = excluded.updated_at`,
        kind,
        ...ownerColumns(userId),
        key,
        typeOf(value),
        store.seal(JSON.stringify(value), sealedFor(userId, key)),
        Date.now(),
      );
    },
    remove: (userId, key) => {
      store.run(
        `delete from logins_logins where kind = ? and ${ownerMatch}`,
        kind,
        ...ownerColumns(userId),
        key,
      );
    },
  };
}

class LoginBusy extends Error {
  constructor() {
    super("another runner holds this login");
  }
}
