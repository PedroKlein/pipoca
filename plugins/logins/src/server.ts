import type {
  AuthType,
  Credential,
  CredentialStore,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  BadRequest,
  defineServer,
  HttpError,
  type McpLoginState,
  NotFound,
  type PersonCaller,
  type SessionCaller,
  Type,
} from "@pipoca/plugins";
import { type ModelInfo, modelInfoOf } from "@pipoca/protocol";
import { logins } from "../plugin";
import { callbacks } from "./callback";
import { connections, modelSignIn } from "./connect";
import { baseOwner, type LoginKind, loginKind, profileOwner } from "./kinds";
import { locks } from "./locks";
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
  type LoginLayer,
  mcpStateOf,
  type Stored,
} from "./model";
import {
  forward,
  proxyTokens,
  tokenOf,
  type Upstream,
  upstreams,
} from "./proxy";
import { publicFetch } from "./private-address";

const text = Type.String({ minLength: 1 });

const layer = Type.Optional(Type.String());

const savedLogin = Type.Object({
  provider: text,
  credential: Type.Unknown(),
  layer,
});

const modelConnect = Type.Object({
  provider: text,
  type: Type.Union([Type.Literal("oauth"), Type.Literal("api_key")]),
  layer,
});

const mcpConnect = Type.Object({ server: text, layer });

const promptAnswer = Type.Object({ prompt: text, answer: text });

const layerQuery = Type.Object({ layer: Type.Optional(Type.String()) });

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
// read and write them through it on every runner (ADR 0045). Team Sessions
// reach the team's API keys only through the server's proxy (ADR 0066).
export const server = defineServer(logins, (ctx) => {
  const {
    clock,
    environments,
    events,
    log,
    profiles,
    provide,
    routes,
    secrets,
    sessions,
    store,
    timer,
    urls,
  } = ctx;

  const leases = locks(timer, holdMs, waitMs);

  const changed = (): void => {
    routes.topic("logins");
  };

  const deps = { store, secrets, clock, log, changed };

  const models = loginKind(deps, leases, {
    name: "credentials",
    kind: "model",
    valid: credentialOf,
    typeOf: ({ type }) => type,
  });

  // Pi keeps one state per MCP server, with its client registration and
  // tokens, keyed by the server's name and address.
  const mcp = loginKind(deps, leases, {
    name: "mcp",
    kind: "mcp",
    valid: mcpStateOf,
    typeOf: () => "oauth",
  });

  // Pi's own providers and models, for the models a person's logins reach
  // and the providers Settings can sign them in to. Providers that
  // packages add come from the server's listing of its base Profile and
  // the runners' lists, and take /login in a Session.
  let catalog: readonly ModelInfo[] = [];
  let connectable: readonly Connectable[] = [];
  let proxied: ReadonlyMap<string, Upstream> = new Map();

  void ModelRuntime.create({ modelsPath: null, allowModelNetwork: false })
    .then((runtime) => {
      catalog = runtime.getModels().map(modelInfoOf);

      proxied = upstreams(runtime.getModels());

      connectable = runtime.getProviders().flatMap(({ id, name, auth }) => {
        const offered = [
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

        return offered.length === 0 ? [] : [{ id, name, methods: offered }];
      });
    })
    .catch((error: unknown) => {
      log("models not listed", { error: String(error) });
    });

  // The team's API keys on the base, which team Sessions reach only through
  // the proxy.
  const teamProviders = (): readonly string[] =>
    [...proxied.keys()].filter(
      (provider) => models.get(baseOwner, provider)?.type === "api_key",
    );

  // The team's API keys on the base the proxy can't carry, which go to team
  // Sessions' runners.
  const runnerKeys = (): readonly Stored[] =>
    models
      .list(baseOwner)
      .filter(({ key, type }) => type === "api_key" && !proxied.has(key));

  // Team work never uses a person's logins, so a team Environment offers the
  // models the team's keys reach through the proxy (ADR 0066).
  provide.models((environment, userId) => {
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

  const signIns = connections(changed, log, timer);
  const returns = callbacks(urls);
  const tokens = proxyTokens(store, clock);

  // Providers a package adds: the server default Profile's, which the server
  // lists itself, and those on the runners of the Environments a person
  // sees. The server can't run their sign-in, so their key is pasted.
  const extensionProviders = ({
    person,
  }: PersonCaller): readonly Connectable[] => {
    const known = new Set(connectable.map(({ id }) => id));

    const names = new Map(
      profiles.baseProviders().map(({ id, name }) => [id, name]),
    );

    const reported = environments
      .list()
      .filter(
        ({ ownerId }) =>
          person.admin || ownerId === person.id || ownerId === "team",
      )
      .flatMap(({ models: offered }) =>
        offered.map(({ provider }) => provider),
      );

    const added = new Set(
      [...names.keys(), ...reported].filter((provider) => !known.has(provider)),
    );

    return [...added].sort().map((id) => ({
      id,
      name: names.get(id) ?? id,
      methods: [{ type: "api_key", label: "Paste a key" }],
      paste: true,
    }));
  };

  const servers = (personId: string) =>
    signableServers(profiles.mcpServers(personId));

  const account = ({ person }: PersonCaller): Account => ({
    admin: person.admin,
    logins: models.mine(person.id).map(({ key, type, updatedAt, owner }) => ({
      provider: key,
      type: type as Credential["type"],
      updatedAt,
      layer: layerOf(person.id, owner),
    })),
    mcp: mcp.mine(person.id).map(({ key, updatedAt, owner }) => ({
      server: key,
      updatedAt,
      layer: layerOf(person.id, owner),
    })),
    servers: servers(person.id).map(({ key, name, url }) => ({
      key,
      name,
      url,
    })),
    ...withConnection(signIns.current(person.id)),
  });

  // Only admins put a login on the base, and only an API key: a
  // subscription stays its person's (ADR 0063).
  const ownerFor = (
    { person }: PersonCaller,
    wanted: string | undefined,
    apiKey: boolean,
  ): string => {
    const owner = ownerOf(person.id, wanted);

    if (owner === baseOwner && !(person.admin && apiKey)) {
      throw new HttpError(
        403,
        "only admins put a login on the server base, and only an API key",
        "admin_only",
      );
    }

    return owner;
  };

  // A Session's layers, nearest first: its Profile's, the ones that builds
  // on, the person's My defaults and the base. Team work never uses a
  // person's logins (ADR 0066), and reads only what the routes hand it.
  const ownersOf = ({ session }: SessionCaller): readonly string[] => {
    const { profileId, startedBy: person } = session;

    return [
      ...(person === null
        ? []
        : [
            ...[profileId, ...profiles.buildsOn(profileId)].map((id) =>
              profileOwner(person, id),
            ),
            person,
          ]),
      baseOwner,
    ];
  };

  const personal = (caller: SessionCaller): readonly string[] => {
    if (caller.session.ownedBy === "team") {
      throw new HttpError(403, "team work keeps no logins", "team_work");
    }

    return ownersOf(caller);
  };

  for (const kind of [models, mcp] as LoginKind<unknown>[]) {
    // The base's keys the proxy can't carry, such as an extension
    // provider's, are all a team Session reads.
    const teamHanded = (): readonly string[] =>
      kind === (models as LoginKind<unknown>)
        ? runnerKeys().map(({ key }) => key)
        : [];

    routes.get(kind.name, { auth: "session" }, ({ caller }) =>
      caller.session.ownedBy === "team"
        ? teamHanded().map((key) => ({ key, type: "api_key" }))
        : [...kind.nearest(ownersOf(caller))].map(([key, { type }]) => ({
            key,
            type,
          })),
    );

    routes.get(`${kind.name}/values`, { auth: "session" }, ({ caller }) => {
      if (caller.session.ownedBy === "team") {
        return Object.fromEntries(
          teamHanded().flatMap((key) => {
            const value = kind.get(baseOwner, key);

            return value === undefined ? [] : [[key, value]];
          }),
        );
      }

      return Object.fromEntries(
        [...kind.nearest(ownersOf(caller))].flatMap(([key, { owner }]) => {
          const value = kind.get(owner, key);

          return value === undefined ? [] : [[key, value]];
        }),
      );
    });

    routes.post(
      `${kind.name}/:key/lock`,
      { auth: "session", long: true },
      async ({ caller, params }) => kind.lease(personal(caller), params.key),
    );

    routes.post(
      `${kind.name}/:key/release`,
      { auth: "session", body: leaseRelease },
      ({ caller, params, body }) => {
        kind.release(personal(caller), params.key, body);

        return { ok: true };
      },
    );

    routes.delete(
      `${kind.name}/:key`,
      { auth: "person", query: layerQuery },
      async ({ caller, params, query }) => {
        await kind.write(
          ownerFor(caller, query.layer, kind === models),
          params.key,
          null,
        );

        return account(caller);
      },
    );
  }

  // A team Session's providers and its token for the proxy.
  routes.get("proxy", { auth: "session" }, ({ caller }) => {
    if (caller.session.ownedBy !== "team") {
      return { providers: [] };
    }

    return {
      providers: teamProviders().map((provider) => ({
        provider,
        baseUrl: urls.public(`proxy/${provider}`),
      })),
      token: tokens.issue(caller.session.id),
    };
  });

  routes.get("account", { auth: "person" }, ({ caller }) => account(caller));

  routes.post(
    "save",
    { auth: "person", body: savedLogin },
    async ({ caller, body }) => {
      const credential = models.validated(body.credential);

      await models.write(
        ownerFor(caller, body.layer, credential.type === "api_key"),
        body.provider,
        credential,
      );

      return account(caller);
    },
  );

  routes.get("providers", { auth: "person" }, ({ caller }) => [
    ...connectable,
    ...extensionProviders(caller),
  ]);

  routes.post(
    "connect",
    { auth: "person", body: modelConnect },
    ({ caller, body: { provider, type, layer: wanted } }) => {
      const offered = connectable.find(({ id }) => id === provider);

      if (offered?.methods.some((method) => method.type === type) !== true) {
        throw new BadRequest(`${provider} takes no such login`);
      }

      signIns.start(
        caller.person.id,
        { key: provider, name: offered.name },
        modelSignIn(
          credentialsOf(models, ownerFor(caller, wanted, type === "api_key")),
          provider,
          type satisfies AuthType,
        ),
      );

      return account(caller);
    },
  );

  routes.post(
    "connect-mcp",
    { auth: "person", body: mcpConnect },
    ({ caller, body: { server: wanted, layer: on } }) => {
      const found = servers(caller.person.id).find(({ key }) => key === wanted);

      if (found === undefined) {
        throw new BadRequest(`no MCP server ${wanted} to sign in to`);
      }

      const owner = ownerFor(caller, on, false);
      const response = Response.json(account(caller));
      const browser = returns.mark(response);

      signIns.start(
        caller.person.id,
        { key: found.key, name: found.name },
        mcpSignIn(
          found,
          mcpStateOfOwner(mcp, owner, found.key),
          urls.public("callback"),
          returns.wait(browser),
          publicFetch(ctx.config.get().privateHosts, ctx.network, caller.owner),
        ),
      );

      return response;
    },
  );

  routes.post(
    "connection/answer",
    { auth: "person", body: promptAnswer },
    ({ caller, body: { prompt, answer } }) => {
      if (!signIns.answer(caller.person.id, prompt, answer)) {
        throw new HttpError(
          409,
          "the sign-in isn't waiting for that answer",
          "not_asked",
        );
      }

      return account(caller);
    },
  );

  routes.delete("connection", { auth: "person" }, ({ caller }) => {
    signIns.dismiss(caller.person.id);

    return account(caller);
  });

  // Which of the team's keys team work reaches only through the proxy, so
  // their runners never hold them (ADR 0066).
  routes.get("keys", { auth: "admin" }, () =>
    models.list(baseOwner).map(({ key: provider, type }) => ({
      provider,
      proxied: type === "api_key" && proxied.has(provider),
    })),
  );

  // Where an MCP server's sign-in page sends the browser back.
  routes.get("callback", { auth: "public" }, ({ raw }) => returns.handle(raw));

  // A team Session's model call, with its token in place of the key
  // (ADR 0066). The Session's runner can't send Pipoca's own token here,
  // since Pi puts the token where the provider takes its key.
  const proxy = async ({
    raw,
    params: { provider, rest },
  }: {
    readonly raw: Request;
    readonly params: { readonly provider: string; readonly rest: string };
  }): Promise<Response> => {
    const upstream = proxied.get(provider);
    if (upstream === undefined) {
      throw new NotFound(`no proxy for ${provider}`);
    }

    const token = tokenOf(raw, upstream.header);

    const session =
      token === undefined
        ? undefined
        : sessions.get(tokens.sessionOf(token) ?? "");

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
      raw,
      upstream,
      rest,
      key.key,
      ({ model, input, output }) => {
        events.emit(
          "model_called",
          {
            sessionId: session.id,
            person: session.startedBy,
            provider,
            model,
            input,
            output,
          },
          { to: [session.ownedBy] },
        );
      },
      async (url, init) =>
        ctx.network.fetch(url, init, { owner: "team", action: "model call" }),
    );

    log("model call proxied", {
      sessionId: session.id,
      provider,
      status: answer.status,
    });

    return answer;
  };

  const proxyPath = "proxy/:provider/*rest";
  const proxyRoute = { auth: "public", long: true } as const;

  routes.get(proxyPath, proxyRoute, proxy);
  routes.post(proxyPath, proxyRoute, proxy);
  routes.put(proxyPath, proxyRoute, proxy);
  routes.patch(proxyPath, proxyRoute, proxy);
  routes.delete(proxyPath, proxyRoute, proxy);
});

function withConnection(
  connection: Account["connection"],
): Pick<Account, "connection"> {
  return connection === undefined ? {} : { connection };
}

// The owner's model logins as Pi reads and writes them while it signs them
// in on the server.
function credentialsOf(
  models: LoginKind<Credential>,
  owner: string,
): CredentialStore {
  return {
    read: async (providerId) => Promise.resolve(models.get(owner, providerId)),
    list: async () =>
      Promise.resolve(
        models.list(owner).map(({ key, type }) => ({
          providerId: key,
          type: type as Credential["type"],
        })),
      ),
    modify: async (providerId, fn) => models.modify(owner, providerId, fn),
    delete: async (providerId) => {
      await models.write(owner, providerId, null);
    },
  };
}

// One MCP server's sign-in state in the owner's logins, as Pi's MCP sign-in
// reads and writes it.
function mcpStateOfOwner(
  mcp: LoginKind<McpLoginState>,
  owner: string,
  key: string,
): McpOAuthStateStore {
  return {
    load: () => mcp.get(owner, key) as McpOAuthState | undefined,
    save: async (state) => {
      await mcp.write(owner, key, state as unknown as McpLoginState);
    },
  };
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
