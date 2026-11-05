import {
  appSignIn,
  browserCommand,
  configFileWrite,
  createEnvironment,
  createFork,
  createSession,
  credentials,
  type Environment,
  environmentUpdate,
  type EnvironmentKey,
  firstUser,
  hubLayout,
  inviteRequest,
  type JoinInfo,
  joinRequest,
  type ListedTemplate,
  type Log,
  mcpTokenRequest,
  moveToTeam,
  newcomersChange,
  personUpdate,
  pinnedPages,
  pluginFileWrite,
  type PluginInfo,
  pluginInstall,
  pluginUpdate,
  protocolVersion,
  repositoryImport,
  repositoryListing,
  restartRequest,
  type Session,
  sessionAccess,
  type SessionEvent,
  setupChange,
  teamMessage,
  type Teammate,
  teamMessagesRead,
  teamNameChange,
  type TeamView,
  versionHeader,
} from "@pipoca/protocol";
import { VERSION as piVersion } from "@earendil-works/pi-coding-agent";
import {
  BadRequest,
  isHttpError,
  NotFound,
  readBody,
  Type,
} from "@pipoca/plugins";
import {
  type OnBehalf,
  type PluginHost,
  type UserActor,
  userIdOf,
} from "@pipoca/pluginhost";
import { InvalidProfile, ProfileTooBig, type Profiles } from "@pipoca/profiles";
import { InvalidRepository } from "@pipoca/repositories";
import type { Result, Sessions } from "@pipoca/sessions";
import { version as serverVersion } from "../package.json";
import {
  type AccessToken,
  canManage,
  canSee,
  canSteer,
  type Credentials,
  InvalidCredentials,
  type People,
  type SignIn,
  type User,
  type Viewer,
} from "@pipoca/people";
import type {
  Environments,
  RunnerCredentials,
  Templates,
} from "@pipoca/environments";
import { type Changes, changedBy } from "./changes";
import { mcpHandler } from "./mcp";
import { type AgentRoute, agentRoutes } from "./agent-routes";
import { profileRoutes } from "./profile-routes";
import { errorReply, notFound, rejected, reply, thrown } from "./replies";
import { lineAfter } from "./requests";
import { presences } from "./presence";
import { sseResponse } from "./sse";
import type { ConfigFiles } from "./config";
import { type Hub, laidOut } from "./hub";
import { type NewcomerSetup, newcomersOf } from "./newcomers";
import { type Team, teamOf } from "./team";

type Route = (
  request: Request,
  params: readonly string[],
) => Response | Promise<Response>;

type RouteTable = readonly (readonly [string, RegExp, Route])[];

// Requests a toolset tool makes as a user (ADR 0035). They never come from
// the network, so they carry no sign-in cookie.
const onBehalf = new WeakMap<Request, OnBehalf>();

export function onBehalfOf(caller: OnBehalf, request: Request): Request {
  onBehalf.set(request, caller);

  return request;
}

// The client's address, as serve saw it. Requests made inside the server,
// and handlers called without serve, have none.
const addresses = new WeakMap<Request, string>();

export function fromAddress(address: string, request: Request): Request {
  addresses.set(request, address);

  return request;
}

export type BrowserRoute = (
  request: Request,
  params: readonly string[],
  actor: UserActor,
  admin: boolean,
) => Response | Promise<Response>;

// Tells one run of the server from the next, so a page waiting out a restart
// knows when the new one answers.
const started = new Date().toISOString();

export interface ServerRestart {
  // Sessions on the server's own runner that are mid-turn.
  readonly busy: () => number;
  readonly now: () => void;
}

// Who calls the server: people signed in, and runners with their tokens.
export interface Auth {
  readonly people: People;
  readonly signIn: SignIn;
  readonly runners: RunnerCredentials;
}

export function createHandler(
  auth: Auth,
  sessions: Sessions,
  environments: Environments,
  profiles: Profiles,
  plugins: PluginHost,
  changes: Changes,
  checkStore: () => void,
  log: Log,
  restart?: ServerRestart,
  templates?: Templates,
  config?: ConfigFiles,
  hub?: Hub,
  newcomers?: NewcomerSetup,
  teamName?: Team,
): (request: Request) => Promise<Response> {
  const present = presences();

  const agent = (route: AgentRoute): Route => {
    return async (request, params) => {
      const unsupported = unsupportedVersion(request);
      if (unsupported) {
        return unsupported;
      }

      const caller = auth.runners.callerOf(request);
      if (caller === undefined) {
        return errorReply(
          401,
          "unknown_token",
          "The server doesn't know this token.",
        );
      }

      const sessionId = params[0];

      if (sessionId === undefined) {
        return caller.sessionId === null
          ? await route(request, params, caller)
          : notFound();
      }

      const session = sessions.get(sessionId);

      // A Session that never reached a runner can still have a workspace
      // removal for any runner of its Environment.
      // Runner names are unique only within an Environment.
      if (
        (caller.sessionId !== null && caller.sessionId !== sessionId) ||
        session?.provider !== caller.environment ||
        (session.runner !== null && session.runner !== caller.runner)
      ) {
        return notFound();
      }

      return await route(request, params, caller);
    };
  };

  const signedIn = (route: BrowserRoute): Route => {
    return async (request, params) => {
      const user = auth.signIn.userOf(request);
      const behalf = onBehalf.get(request);

      const actor =
        behalf?.actor ??
        (user === undefined ? undefined : (`user:${user.id}` as const));

      if (actor === undefined) {
        return errorReply(401, "signed_out", "Sign in again.");
      }

      const admin =
        behalf?.mayAdmin !== false &&
        auth.people.userById(userIdOf(actor))?.admin === true;

      const response = await route(request, params, actor, admin);
      const topic = changedBy(request, response);
      if (topic !== undefined) {
        changes.publish(topic);
      }

      return response;
    };
  };

  // Plugins run code inside the server, so only admins change them.
  const admin =
    (route: BrowserRoute): BrowserRoute =>
    async (request, params, actor, isAdmin) =>
      isAdmin
        ? await route(request, params, actor, isAdmin)
        : errorReply(
            403,
            "admin_only",
            "Only admins change plugins and restart the server.",
          );

  // A draft runs nothing until an admin turns it on, so an admin's
  // meta-session may write one though it never acts as an admin.
  const adminDraft =
    (route: BrowserRoute): BrowserRoute =>
    async (request, params, actor, isAdmin) =>
      auth.people.userById(userIdOf(actor))?.admin === true
        ? await route(request, params, actor, isAdmin)
        : errorReply(403, "admin_only", "Only admins write and build plugins.");

  // Every Environment made from a template follows it, so only admins
  // change templates (ADR 0049).
  const templateChange =
    (
      route: (
        request: Request,
        params: readonly string[],
        made: Templates,
      ) => Response | Promise<Response>,
    ): BrowserRoute =>
    async (request, params, _actor, isAdmin) => {
      if (!isAdmin) {
        return errorReply(
          403,
          "admin_only",
          "Only admins change Environment templates.",
        );
      }

      return templates === undefined
        ? notFound()
        : await route(request, params, templates);
    };

  // A person reaches only their own Sessions and the team's they may see.
  // An admin also reaches everyone's outline, and stops, archives or deletes
  // them (ADR 0049).
  const own =
    (route: BrowserRoute): BrowserRoute =>
    async (request, params, actor, isAdmin) =>
      canSee(viewerOf(actor), sessions.owned(params[0] ?? ""))
        ? await route(request, params, actor, isAdmin)
        : notFound();

  const steer =
    (route: BrowserRoute): BrowserRoute =>
    async (request, params, actor, isAdmin) => {
      const owned = sessions.owned(params[0] ?? "");
      const viewer = viewerOf(actor, isAdmin);

      if (canManage(viewer, owned)) {
        return await route(request, params, actor, isAdmin);
      }

      return canSee(viewer, owned) ? rejected("view_only") : notFound();
    };

  const sessionAction =
    (
      message: string,
      act: (id: string, actor: UserActor) => Result<unknown>,
    ): BrowserRoute =>
    (_request, [id = ""], actor) => {
      const result = act(id, actor);
      if (result.ok) {
        log(message, { sessionId: id });
      }

      return reply(result, 200);
    };

  const environmentFor = (runner: string, ownerId: string): string => {
    const created = environments.createForRunner(runner, ownerId);
    log("environment created", { environmentId: created.id, runner });

    return created.provider;
  };

  const publicRoutes: RouteTable = [
    [
      "GET",
      /^\/healthz$/,
      () => {
        try {
          checkStore();
        } catch (error) {
          log("database unavailable", { error: String(error) });

          return Response.json({ status: "unavailable" }, { status: 503 });
        }

        return Response.json({
          status: "ok",
          version: serverVersion,
          pi: piVersion,
          started,
        });
      },
    ],
    ...authRoutes(auth, plugins, log, changes),
    [
      "ANY",
      /^\/api\/plugins\/([^/]+)\/(.*)$/,
      async (request, [name = "", path = ""]) =>
        (await plugins.publicRoute(request, name, path)) ??
        signedIn(
          async (_request, _params, actor, isAdmin) =>
            (await plugins.route(request, name, path, {
              kind: "user",
              actor,
              admin: isAdmin,
            })) ?? notFound(),
        )(request, [name, path]),
    ],
    [
      "ANY",
      /^\/api\/mcp$/,
      mcpHandler(auth.people, plugins, serverVersion, log),
    ],
    [
      "POST",
      /^\/agent\/join$/,
      async (request) => {
        const unsupported = unsupportedVersion(request);
        if (unsupported) {
          return unsupported;
        }

        const [scheme, key] = (
          request.headers.get("authorization") ?? ""
        ).split(" ");

        const { name } = await readBody(request, joinRequest);

        const joined =
          scheme === "Bearer" && key !== undefined
            ? auth.runners.join(key, name, {
                create: environmentFor,
                online: (environment, runner) =>
                  environments.online(environment, runner),
              })
            : undefined;

        if (joined === undefined) {
          log("runner refused", { runner: name });

          return errorReply(
            401,
            "unknown_key",
            "The server doesn't know this join key.",
          );
        }

        if (joined === "online") {
          log("runner refused", { runner: name, reason: "online" });

          return errorReply(
            409,
            "runner_online",
            `a runner named ${name} is online here`,
          );
        }

        log("runner joined", { runner: name, environment: joined.environment });

        return Response.json(joined);
      },
    ],
  ];

  const browserRoutes: readonly (readonly [string, RegExp, BrowserRoute])[] = [
    ["GET", /^\/api\/changes$/, () => changes.stream()],
    ["GET", /^\/api\/plugins$/, () => Response.json(plugins.list())],
    [
      "POST",
      /^\/api\/plugins$/,
      admin(async (request) => {
        const { url } = await readBody(request, pluginInstall);
        const installed = await plugins.install(url);

        if (typeof installed === "string") {
          throw new BadRequest(installed);
        }

        return Response.json(installed, { status: 201 });
      }),
    ],
    [
      "GET",
      /^\/api\/plugin-files\/([^/]+)$/,
      async (request, [name = ""]) => {
        const path = new URL(request.url).searchParams.get("path");

        return Response.json(
          path === null
            ? await refused(plugins.files.list(name))
            : { path, content: await refused(plugins.files.read(name, path)) },
        );
      },
    ],
    [
      "PUT",
      /^\/api\/plugin-files\/([^/]+)$/,
      adminDraft(async (request, [name = ""]) => {
        const { path, content } = await readBody(request, pluginFileWrite);

        return Response.json(
          await refused(plugins.files.write(name, path, content)),
        );
      }),
    ],
    [
      "POST",
      /^\/api\/plugin-builds\/([^/]+)$/,
      adminDraft(async (_request, [name = ""]) =>
        Response.json(await refused(plugins.files.build(name))),
      ),
    ],
    [
      "POST",
      /^\/api\/plugin-resets\/([^/]+)$/,
      admin((_request, [name = ""]) => {
        const reset = plugins.resetData(name);

        if (typeof reset === "string") {
          throw new BadRequest(reset);
        }

        return reset === undefined ? notFound() : Response.json(reset);
      }),
    ],
    [
      "DELETE",
      /^\/api\/plugins\/([^/]+)$/,
      admin(async (_request, [name = ""]) => {
        const removed = await plugins.remove(name);

        if (typeof removed === "string") {
          throw new BadRequest(removed);
        }

        return removed ? new Response(null, { status: 204 }) : notFound();
      }),
    ],
    [
      "POST",
      /^\/api\/restart$/,
      admin(async (request) => {
        if (restart === undefined) {
          throw new BadRequest(
            "nothing starts this server again when it stops, so restart it yourself",
          );
        }

        const { force } = await readBody(request, restartRequest);
        const busy = restart.busy();

        // Sessions on the server's own runner stop with it mid-turn
        // (ADR 0022), so the user decides.
        if (busy > 0 && force !== true) {
          return errorReply(
            409,
            "busy",
            "Sessions are mid-turn on the server's own runner.",
            { sessions: busy },
          );
        }

        log("server restarting", { interrupted: busy });

        // After the answer is on its way.
        setTimeout(restart.now, 100);

        return new Response(null, { status: 202 });
      }),
    ],
    [
      "GET",
      /^\/api\/plugin-parts\/([^/]+)\/([^/]+)$/,
      (_request, [name = "", file = ""]) => {
        const path = plugins.webPart(name, file);

        // Named by content hash, so a browser can keep it.
        return path === undefined
          ? notFound()
          : new Response(Bun.file(path), {
              headers: {
                "content-type": "text/javascript; charset=utf-8",
                "cache-control": "private, max-age=31536000, immutable",
              },
            });
      },
    ],
    [
      "GET",
      /^\/api\/setup$/,
      (_request, _params, actor) =>
        Response.json(auth.people.setup(userIdOf(actor))),
    ],
    [
      "POST",
      /^\/api\/setup$/,
      async (request, _params, actor) => {
        const change = await readBody(request, setupChange);

        if ("finished" in change) {
          auth.people.finishSetup(userIdOf(actor));
        } else {
          auth.people.dismissSetupStep(userIdOf(actor), change.dismiss);
        }

        return new Response(null, { status: 204 });
      },
    ],
    [
      "GET",
      /^\/api\/pinned-pages$/,
      (_request, _params, actor) =>
        Response.json({ pages: auth.people.pinnedPages(userIdOf(actor)) }),
    ],
    [
      "PUT",
      /^\/api\/pinned-pages$/,
      async (request, _params, actor) => {
        const { pages } = await readBody(request, pinnedPages);

        auth.people.pinPages(userIdOf(actor), pages);

        return new Response(null, { status: 204 });
      },
    ],
    [
      "GET",
      /^\/api\/mcp-tokens$/,
      (_request, _params, actor) =>
        Response.json(auth.people.accessTokens(userIdOf(actor)).map(tokenView)),
    ],
    [
      "POST",
      /^\/api\/mcp-tokens$/,
      async (request, _params, actor) => {
        const { name } = await readBody(request, mcpTokenRequest);

        const { token, secret } = auth.people.newAccessToken(
          userIdOf(actor),
          name,
        );

        log("mcp token created", { tokenId: token.id });

        return Response.json(
          { token: tokenView(token), secret },
          { status: 201 },
        );
      },
    ],
    [
      "DELETE",
      /^\/api\/mcp-tokens\/([^/]+)$/,
      (_request, [id = ""], actor) => {
        if (!auth.people.revokeAccessToken(userIdOf(actor), id)) {
          return notFound();
        }

        log("mcp token revoked", { tokenId: id });

        return new Response(null, { status: 204 });
      },
    ],
    [
      "PATCH",
      /^\/api\/plugins\/([^/]+)$/,
      admin(async (request, [name = ""]) => {
        const { settings, enabled, update, digest, teamWork } = await readBody(
          request,
          pluginUpdate,
        );

        if (teamWork !== undefined) {
          const switched = plugins.setTeamWork(name, teamWork);

          if (typeof switched === "string") {
            throw new BadRequest(switched);
          }

          return switched === undefined ? notFound() : Response.json(switched);
        }

        const saved = await pluginChange(plugins, name, {
          settings,
          enabled,
          update: update === true,
          ...(digest !== undefined && { digest }),
        });

        if (typeof saved === "string") {
          throw new BadRequest(saved);
        }

        return saved === undefined ? notFound() : Response.json(saved);
      }),
    ],
    [
      "GET",
      /^\/api\/environments$/,
      (request, _params, actor, isAdmin) => {
        const person = userIdOf(actor);
        const everyone = isAdmin && peopleAll(request);

        if (new URL(request.url).searchParams.get("owner") === teamOwner) {
          return Response.json(
            environments
              .list(person)
              .filter(({ ownerId }) => ownerId === teamOwner)
              // Anyone can start team work, so they see its folders and
              // models; only its variables stay with admins.
              .map((environment) =>
                isAdmin ? environment : { ...environment, variables: {} },
              ),
          );
        }

        return Response.json(
          environments
            .list(person)
            .filter(({ ownerId }) => everyone || ownerId === person)
            .map((environment) =>
              environment.ownerId === person
                ? environment
                : environmentOutline(environment),
            ),
        );
      },
    ],
    [
      "POST",
      /^\/api\/environments$/,
      async (request, _params, actor, isAdmin) => {
        const { name, template, team } = await readBody(
          request,
          createEnvironment,
        );

        if (team === true && !isAdmin) {
          return errorReply(
            403,
            "admin_only",
            "Only admins make team Environments.",
          );
        }

        const created = environments.create(
          name,
          team === true ? teamOwner : userIdOf(actor),
          template,
        );

        if (!created.ok) {
          return reply(created, 201);
        }

        const key = auth.runners.newKey(created.value.provider);
        log("environment created", { environmentId: created.value.id });

        return Response.json(
          { environment: { ...created.value, hasKey: true }, key },
          { status: 201 },
        );
      },
    ],
    [
      "POST",
      /^\/api\/join-key$/,
      (_request, _params, actor) => {
        log("join key made", {});

        return Response.json(
          { key: auth.runners.newJoinKey(userIdOf(actor)) },
          { status: 201 },
        );
      },
    ],
    [
      "POST",
      /^\/api\/environments\/([^/]+)\/key$/,
      (_request, [id = ""], actor, isAdmin) => {
        const environment = environments
          .list()
          .find(
            (each) =>
              each.id === id &&
              canSteer(viewerOf(actor, isAdmin), ownedEnvironment(each)),
          );

        if (!environment) {
          return notFound();
        }

        const key: EnvironmentKey = {
          key: auth.runners.newKey(environment.provider),
        };

        log("environment key replaced", { environmentId: id });

        return Response.json(key);
      },
    ],
    [
      "PATCH",
      /^\/api\/environments\/([^/]+)$/,
      async (request, [id = ""], actor, isAdmin) => {
        if (
          !environments
            .all()
            .some(
              (each) =>
                each.id === id &&
                canSteer(viewerOf(actor, isAdmin), ownedEnvironment(each)),
            )
        ) {
          return notFound();
        }

        const { name, ...update } = await readBody(request, environmentUpdate);

        const updated = environments.update(id, {
          ...update,
          ...(name !== undefined && { name: name.trim() }),
        });

        if (updated.ok) {
          log("environment updated", { environmentId: id });
        }

        return reply(updated, 200);
      },
    ],
    [
      "DELETE",
      /^\/api\/environments\/([^/]+)$/,
      (_request, [id = ""], actor, isAdmin) => {
        if (
          !environments
            .all()
            .some(
              (each) =>
                each.id === id &&
                canManage(viewerOf(actor, isAdmin), ownedEnvironment(each)),
            )
        ) {
          return notFound();
        }

        const deleted = environments.remove(id);
        if (deleted.ok) {
          log("environment deleted", { environmentId: id });
        }

        return reply(deleted, 204);
      },
    ],
    [
      "GET",
      /^\/api\/people$/,
      (_request, _params, _actor, isAdmin) =>
        isAdmin
          ? Response.json(auth.people.people())
          : errorReply(403, "admin_only", "Only admins list everyone."),
    ],
    [
      "GET",
      /^\/api\/teammates$/,
      () =>
        Response.json(
          auth.people.users().map(({ id, name }): Teammate => ({ id, name })),
        ),
    ],
    [
      "GET",
      /^\/api\/invites$/,
      (_request, _params, _actor, isAdmin) =>
        isAdmin
          ? Response.json(auth.people.invites())
          : errorReply(403, "admin_only", "Only admins invite people."),
    ],
    [
      "POST",
      /^\/api\/invites$/,
      async (request, _params, actor, isAdmin) => {
        if (!isAdmin) {
          return errorReply(403, "admin_only", "Only admins invite people.");
        }

        const {
          emails = [],
          admin: asAdmin = false,
          days = 7,
        } = await readBody(request, inviteRequest);

        const by = userIdOf(actor);
        const made = auth.people.invite(by, emails, asAdmin, days);
        const name = auth.people.userById(by)?.name ?? "An admin";

        for (const invite of made) {
          if (invite.email !== null) {
            plugins.publish({
              type: "PersonInvited",
              email: invite.email,
              link: `${originOf(request)}/#join/${invite.token}`,
              invitedBy: { id: by, name },
              admin: invite.admin,
              expiresAt: invite.expiresAt,
            });
          }
        }

        log("people invited", {
          invites: made.length,
          link: made.some((invite) => invite.email === null),
          admin: asAdmin,
        });

        return Response.json(made, { status: 201 });
      },
    ],
    [
      "DELETE",
      /^\/api\/invites\/([^/]+)$/,
      (_request, [id = ""], _actor, isAdmin) => {
        if (!isAdmin) {
          return errorReply(403, "admin_only", "Only admins invite people.");
        }

        return auth.people.revokeInvite(id)
          ? new Response(null, { status: 204 })
          : notFound();
      },
    ],
    [
      "GET",
      /^\/api\/config$/,
      (_request, _params, _actor, isAdmin) => {
        if (!isAdmin) {
          return errorReply(403, "admin_only", "Only admins edit the config.");
        }

        return config === undefined
          ? notFound()
          : Response.json({ root: config.root, files: config.list() });
      },
    ],
    [
      "GET",
      /^\/api\/config\/file$/,
      (request, _params, _actor, isAdmin) => {
        if (!isAdmin) {
          return errorReply(403, "admin_only", "Only admins edit the config.");
        }

        const name = new URL(request.url).searchParams.get("name") ?? "";
        const file = config?.read(name);

        return file === undefined ? notFound() : Response.json(file);
      },
    ],
    [
      "PUT",
      /^\/api\/config\/file$/,
      async (request, _params, _actor, isAdmin) => {
        if (!isAdmin) {
          return errorReply(403, "admin_only", "Only admins edit the config.");
        }

        if (config === undefined) {
          return notFound();
        }

        const { name, text, version } = await readBody(
          request,
          configFileWrite,
        );

        const failure = config.write(name, text, version);

        if (failure !== undefined) {
          return errorReply(
            failure.changed ? 409 : 400,
            failure.changed ? "config_changed" : "invalid_config",
            failure.reason,
          );
        }

        log("config file edited", { name });

        return Response.json(config.read(name));
      },
    ],
    [
      "PATCH",
      /^\/api\/people\/([^/]+)$/,
      async (request, [id = ""], _actor, isAdmin) => {
        if (!isAdmin) {
          return errorReply(403, "admin_only", "Only admins change roles.");
        }

        const { admin: makeAdmin } = await readBody(request, personUpdate);

        const changed = auth.people.changeRole(id, makeAdmin);

        if (changed === "not_found") {
          return notFound();
        }

        if (changed === "last_admin") {
          return errorReply(
            409,
            "last_admin",
            "The server needs an admin: make someone else an admin first.",
          );
        }

        log("role changed", { userId: id, admin: makeAdmin });

        return Response.json(changed);
      },
    ],
    ...profileRoutes(profiles, log),
    [
      "GET",
      /^\/api\/hub$/,
      () => Response.json(hub?.layout() ?? { pages: null }),
    ],
    [
      "PUT",
      /^\/api\/hub$/,
      async (request, _params, _actor, isAdmin) => {
        if (!isAdmin) {
          return errorReply(403, "admin_only", "Only admins lay out the hub.");
        }

        const layout = laidOut(await readBody(request, hubLayout));

        if (hub === undefined) {
          return notFound();
        }

        hub.lay(layout);
        log("hub laid out", { pages: layout.pages?.length ?? 0 });
        changes.publish("hub");

        return Response.json(layout);
      },
    ],
    [
      "GET",
      /^\/api\/team$/,
      () =>
        Response.json({
          ...(teamName?.get() ?? { name: null }),
          messagesRead: teamName?.messagesRead() ?? teamMessagesRead,
        } satisfies TeamView),
    ],
    [
      "PUT",
      /^\/api\/team$/,
      async (request, _params, _actor, isAdmin) => {
        if (!isAdmin) {
          return errorReply(403, "admin_only", "Only admins name the team.");
        }

        const next = teamOf(await readBody(request, teamNameChange));

        if (teamName === undefined) {
          return notFound();
        }

        teamName.set(next);
        log("team named", { name: next.name });
        changes.publish("team");

        return Response.json(next);
      },
    ],
    [
      "GET",
      /^\/api\/newcomers$/,
      () =>
        Response.json(
          newcomers?.get() ?? { template: null, profiles: [], required: [] },
        ),
    ],
    [
      "PUT",
      /^\/api\/newcomers$/,
      async (request, _params, _actor, isAdmin) => {
        if (!isAdmin) {
          return errorReply(
            403,
            "admin_only",
            "Only admins choose what new people get.",
          );
        }

        const next = newcomersOf(await readBody(request, newcomersChange));

        if (newcomers === undefined) {
          return notFound();
        }

        newcomers.set(next);

        log("newcomer setup changed", {
          template: next.template,
          profiles: next.profiles.length,
          required: next.required,
        });

        changes.publish("newcomers");

        return Response.json(next);
      },
    ],
    [
      "GET",
      /^\/api\/templates$/,
      () =>
        Response.json(
          (templates?.list() ?? []).map((template): ListedTemplate => ({
            ...template,
            runnersFrom:
              plugins.startsRunners({ id: "", templateId: template.id }) ??
              null,
          })),
        ),
    ],
    [
      "POST",
      /^\/api\/templates$/,
      templateChange(async (request, _params, made) => {
        const created = made.create(await readBody(request, Type.Unknown()));
        log("template created", { templateId: created.id });

        return Response.json(created, { status: 201 });
      }),
    ],
    [
      "POST",
      /^\/api\/templates\/listed$/,
      templateChange(async (request, _params, made) => {
        const { url } = await readBody(request, repositoryListing);

        return Response.json({ templates: await made.listed(url) });
      }),
    ],
    [
      "POST",
      /^\/api\/templates\/import$/,
      templateChange(async (request, _params, made) => {
        const { url, paths } = await readBody(request, repositoryImport);
        const imported = await made.importListed(url, paths);

        log("templates imported", {
          templateIds: imported.map(({ id }) => id),
        });

        return Response.json({ templates: imported }, { status: 201 });
      }),
    ],
    [
      "POST",
      /^\/api\/templates\/([^/]+)\/sync$/,
      templateChange(async (_request, [id = ""], made) => {
        const template = made.list().find((each) => each.id === id);
        const source = template?.source;
        if (!template || !source) {
          return notFound();
        }

        await made.sync(source.url);

        return Response.json(
          made.list().find((each) => each.id === id) ?? template,
        );
      }),
    ],
    [
      "PATCH",
      /^\/api\/templates\/([^/]+)$/,
      templateChange(async (request, [id = ""], made) => {
        const updated = made.update(
          id,
          await readBody(request, Type.Unknown()),
        );

        log("template updated", { templateId: id });

        return Response.json(updated);
      }),
    ],
    [
      "DELETE",
      /^\/api\/templates\/([^/]+)$/,
      templateChange((_request, [id = ""], made) => {
        made.remove(id);
        log("template removed", { templateId: id });

        return new Response(null, { status: 204 });
      }),
    ],
    [
      "GET",
      /^\/api\/sessions$/,
      (request, _params, actor, isAdmin) => {
        const query = new URL(request.url).searchParams;

        const archived = query.get("archived") === "true";

        if (query.get("owner") === "team") {
          return Response.json(
            sessions.list({
              archived,
              team: true,
              ...(!isAdmin && { person: userIdOf(actor) }),
            }),
          );
        }

        const all = sessions.list({
          archived,
          ...(!(isAdmin && peopleAll(request)) && {
            person: userIdOf(actor),
          }),
        });

        // An owned Session shows only inside its plugin, unless that plugin
        // is off (ADR 0028). owner=all is for search and notices.
        return Response.json(
          query.get("owner") === "all"
            ? all
            : all.filter(
                (session) =>
                  session.owner === null ||
                  !plugins.names.includes(session.owner.plugin),
              ),
        );
      },
    ],
    [
      "POST",
      /^\/api\/sessions\/([^/]+)\/fork$/,
      own(async (request, [id = ""], actor) => {
        const { personal, ...fork } = await readBody(request, createFork);

        const forked = sessions.fork(id, {
          ...fork,
          ...(personal === true && { personal }),
          actor,
        });

        if (forked.ok) {
          log("session forked", {
            sessionId: forked.value.id,
            from: id,
            environmentId: forked.value.environmentId,
            fromMessage: forked.value.editorText !== undefined,
          });
        }

        return reply(forked, 201);
      }),
    ],
    [
      "POST",
      /^\/api\/sessions\/([^/]+)\/move$/,
      own(async (request, [id = ""], actor) => {
        const { summary, ...move } = await readBody(request, moveToTeam);

        const moved = sessions.move(id, {
          ...move,
          summary: summary.trim(),
          actor,
        });

        if (moved.ok) {
          log("session moved to the team", {
            sessionId: moved.value.id,
            from: id,
            environmentId: moved.value.environmentId,
          });
        }

        return reply(moved, 201);
      }),
    ],
    [
      "POST",
      /^\/api\/sessions$/,
      async (request, _params, actor) => {
        const created = sessions.start({
          ...(await readBody(request, createSession)),
          actor,
        });

        if (created.ok) {
          log("session created", {
            sessionId: created.value.id,
            environmentId: created.value.environmentId,
            provider: created.value.provider,
          });
        }

        return reply(created, 201);
      },
    ],
    [
      "GET",
      /^\/api\/sessions\/([^/]+)$/,
      (_request, [id = ""], actor, isAdmin) => {
        const session = sessions.get(id);
        const sees = canSee(viewerOf(actor), sessions.owned(id));
        if (session === undefined || !(sees || isAdmin)) {
          return notFound();
        }

        return Response.json(sees ? session : sessionOutline(session));
      },
    ],
    [
      "GET",
      /^\/api\/sessions\/([^/]+)\/events$/,
      own((request, [id = ""]) => {
        let send: (event: SessionEvent) => void = () => undefined;

        const watch = sessions.watch(
          id,
          (event) => {
            send(event);
          },
          lineAfter(request.headers.get("last-event-id")),
        );

        if (!watch.ok) {
          return reply(watch, 200);
        }

        return sseResponse((s) => {
          send = (event) => {
            s(event, event.type === "entry" ? String(event.line) : undefined);
          };

          watch.value.replay.forEach(send);

          return watch.value.stop;
        });
      }),
    ],
    [
      "POST",
      /^\/api\/sessions\/([^/]+)\/archive$/,
      steer(
        sessionAction("session archived", (id, actor) =>
          sessions.archive(id, actor),
        ),
      ),
    ],
    [
      "POST",
      /^\/api\/sessions\/([^/]+)\/unarchive$/,
      steer(
        sessionAction("session unarchived", (id, actor) =>
          sessions.unarchive(id, actor),
        ),
      ),
    ],
    [
      "POST",
      /^\/api\/sessions\/([^/]+)\/remove-workspace$/,
      steer(
        sessionAction("workspace removal forced", (id) =>
          sessions.forceRemoval(id),
        ),
      ),
    ],
    [
      "POST",
      /^\/api\/sessions\/([^/]+)\/say$/,
      steer(async (request, [id = ""], actor) => {
        const { text, ...message } = await readBody(request, teamMessage);

        return reply(
          sessions.say(id, { ...message, text: text.trim(), actor }),
          201,
        );
      }),
    ],
    [
      "GET",
      /^\/api\/sessions\/([^/]+)\/presence$/,
      own((_request, [id = ""], actor) =>
        sseResponse((send) =>
          present.join(id, userIdOf(actor), (people) => {
            send(people);
          }),
        ),
      ),
    ],
    [
      "POST",
      /^\/api\/sessions\/([^/]+)\/presence$/,
      steer((_request, [id = ""], actor) => {
        present.typing(id, userIdOf(actor));

        return new Response(null, { status: 204 });
      }),
    ],
    [
      "PUT",
      /^\/api\/sessions\/([^/]+)\/access$/,
      async (request, [id = ""], actor, isAdmin) => {
        const body = await readBody(request, sessionAccess);

        const access =
          body.kind === "named"
            ? { kind: body.kind, people: [...new Set(body.people)] }
            : body;

        const users = new Set(auth.people.users().map((user) => user.id));
        if (
          access.kind === "named" &&
          !access.people.every((person) => users.has(person))
        ) {
          throw new BadRequest("people must be users of this server");
        }

        const limited = sessions.limit(id, access, {
          person: userIdOf(actor),
          admin: isAdmin,
        });

        if (limited.ok) {
          log("session access changed", { sessionId: id, access: access.kind });
        }

        return reply(limited, 200);
      },
    ],
    [
      "POST",
      /^\/api\/sessions\/([^/]+)\/commands$/,
      async (request, [id = ""], actor, isAdmin) => {
        const { quote, ...sent } = await readBody(request, browserCommand);
        const command = { ...sent, actor };
        const owned = sessions.owned(id);
        const viewer = viewerOf(actor, isAdmin);

        if (
          canSteer(viewer, owned) ||
          (command.type === "abort" && canManage(viewer, owned))
        ) {
          return reply(sessions.send(id, command, quote), 202);
        }

        return canSee(viewer, owned) ? rejected("view_only") : notFound();
      },
    ],
  ];

  const routes: RouteTable = [
    ...publicRoutes,
    ...browserRoutes.map(
      ([method, pattern, route]) => [method, pattern, signedIn(route)] as const,
    ),
    ...agentRoutes(auth.runners, sessions, profiles, plugins, log).map(
      ([method, pattern, route]) => [method, pattern, agent(route)] as const,
    ),
  ];

  return async (request) => {
    const { pathname } = new URL(request.url);
    for (const [method, pattern, route] of routes) {
      const match = pattern.exec(pathname);
      if (match && (method === "ANY" || request.method === method)) {
        try {
          return await route(request, match.slice(1));
        } catch (error) {
          if (isHttpError(error)) {
            return thrown(error);
          }

          if (
            error instanceof InvalidProfile ||
            error instanceof ProfileTooBig ||
            error instanceof InvalidCredentials ||
            error instanceof InvalidRepository
          ) {
            return errorReply(400, "bad_request", error.message);
          }

          log("request failed", {
            method,
            path: pathname,
            error: String(error),
          });

          return errorReply(
            500,
            "internal",
            "The server failed to answer. Its log says why.",
          );
        }
      }
    }

    return notFound();
  };
}

function authRoutes(
  auth: Auth,
  plugins: PluginHost,
  log: Log,
  changes: Changes,
): RouteTable {
  return [
    [
      "GET",
      /^\/api\/auth$/,
      (request) =>
        Response.json({
          ...auth.signIn.status(request),
          logins: plugins.logins(),
        }),
    ],
    [
      "POST",
      /^\/api\/auth\/setup$/,
      async (request) => {
        const { token, ...given } = await readBody(request, firstUser);
        const user = await auth.signIn.setUp(token, credentialsOf(given));

        if (user === undefined) {
          return errorReply(
            403,
            "invalid_token",
            "This setup link is not the server's current one. Open the link from its latest log.",
          );
        }

        log("first user created", { userId: user.id });

        return signedInAs(auth, user, request, 201);
      },
    ],
    [
      "GET",
      /^\/api\/auth\/join\/([\w-]+)$/,
      (_request, [token = ""]) => {
        const invite = auth.people.inviteFor(token, undefined);
        if (invite === undefined) {
          return expiredInvite();
        }

        return Response.json({
          email: invite.email,
          admin: invite.admin,
          invitedBy: auth.people.userById(invite.createdBy)?.name ?? "An admin",
          expiresAt: invite.expiresAt,
          passwordLogin: auth.signIn.passwordLogin,
          logins: plugins.logins().map((login) => ({
            ...login,
            path: `${login.path}?join=${token}`,
          })),
        } satisfies JoinInfo);
      },
    ],
    [
      "POST",
      /^\/api\/auth\/join\/([\w-]+)$/,
      async (request, [token = ""]) => {
        const joined = await auth.signIn.joinWithInvite(
          token,
          credentialsOf(await readBody(request, credentials)),
        );

        if (joined === "off") {
          return errorReply(
            403,
            "password_login_off",
            "This server doesn't sign people in with a password.",
          );
        }

        if (joined === "taken") {
          return errorReply(409, "name_taken", "Someone has that name.");
        }

        if (joined === undefined) {
          return expiredInvite();
        }

        log("user joined", { userId: joined.id, admin: joined.admin });
        changes.publish("environments");

        return signedInAs(auth, joined, request, 201);
      },
    ],
    [
      "GET",
      /^\/api\/auth\/link\/([\w-]+)$/,
      (request, [token = ""]) => {
        const verifier =
          new URL(request.url).searchParams.get("verifier") ?? undefined;

        const user = auth.signIn.redeemLink(token, verifier);

        if (user === undefined) {
          return errorReply(
            403,
            "invalid_token",
            "This sign-in link was used or is too old. Get a new one with pipoca link, or from the Pipoca app.",
          );
        }

        log("signed in with a link", { userId: user.id });

        return new Response(null, {
          status: 303,
          headers: {
            location: "/",
            "set-cookie": auth.signIn.startSession(user, request),
          },
        });
      },
    ],
    [
      "POST",
      /^\/api\/auth\/app$/,
      async (request) => {
        const user = auth.signIn.userOf(request);
        if (user === undefined) {
          return errorReply(401, "signed_out", "Sign in first.");
        }

        const { challenge } = await readBody(request, appSignIn);

        if (!/^[\w-]{43}$/.test(challenge)) {
          return errorReply(
            400,
            "invalid_challenge",
            "This isn't a link from the Pipoca app.",
          );
        }

        log("signed the desktop app in", { userId: user.id });

        const link = new URL("pipoca://signed-in");
        link.searchParams.set("challenge", challenge);
        link.searchParams.set("link", auth.signIn.appLink(user, challenge));

        return Response.json({ link: link.href });
      },
    ],
    [
      "POST",
      /^\/api\/auth\/login$/,
      async (request) => {
        const given = credentialsOf(await readBody(request, credentials));
        const address = addresses.get(request) ?? "";
        const user = await auth.signIn.signIn(given, address);

        if (user === "off") {
          return errorReply(
            403,
            "password_login_off",
            "This server doesn't sign people in with a password.",
          );
        }

        if (user === "locked") {
          log("sign-in locked", { name: given.name, address });

          return errorReply(
            429,
            "locked",
            "Too many failed sign-ins. Try again in 15 minutes.",
          );
        }

        if (user === "wrong") {
          log("sign-in failed", { name: given.name, address });

          return errorReply(401, "wrong_password", "Wrong name or password.");
        }

        log("signed in", { userId: user.id });

        return signedInAs(auth, user, request, 200);
      },
    ],
    [
      "POST",
      /^\/api\/auth\/logout$/,
      (request) =>
        new Response(null, {
          status: 204,
          headers: { "set-cookie": auth.signIn.endSession(request) },
        }),
    ],
  ];
}

function signedInAs(
  auth: Auth,
  user: User,
  request: Request,
  status: number,
): Response {
  return Response.json(user, {
    status,
    headers: { "set-cookie": auth.signIn.startSession(user, request) },
  });
}

function expiredInvite(): Response {
  return errorReply(
    404,
    "invalid_invite",
    "This invite was used, revoked or is too old. Ask an admin for a new one.",
  );
}

function credentialsOf({ name, password }: Credentials): Credentials {
  return { name: name.trim(), password };
}

async function pluginChange(
  plugins: PluginHost,
  name: string,
  change: {
    readonly settings: unknown;
    readonly enabled: boolean | undefined;
    readonly update: boolean;
    readonly digest?: string;
  },
): Promise<PluginInfo | string | undefined> {
  if (change.update) {
    return plugins.update(name);
  }

  return change.enabled === undefined
    ? plugins.saveSettings(name, change.settings)
    : plugins.turnOn(name, change.enabled, change.digest);
}

function tokenView({
  id,
  name,
  createdAt,
}: AccessToken): Omit<AccessToken, "userId"> {
  return { id, name, createdAt };
}

// What an in-place plugin's change can't do is the caller's to fix.
async function refused<T>(change: Promise<T>): Promise<T> {
  return change.catch((error: unknown) => {
    if (error instanceof NotFound) {
      throw error;
    }

    throw new BadRequest(
      error instanceof Error ? error.message : String(error),
    );
  });
}

function unsupportedVersion(request: Request): Response | undefined {
  const version = request.headers.get(versionHeader);

  return version === String(protocolVersion)
    ? undefined
    : errorReply(
        400,
        "unsupported_version",
        `unsupported protocol version ${String(version)}`,
      );
}

// The owner of what the team owns, rather than one person (ADR 0064).
const teamOwner = "team";

// Sessions and Environments decide only for people; an admin's rights come
// from the route.
function viewerOf(actor: UserActor, admin = false): Viewer {
  return { id: userIdOf(actor), admin };
}

function ownedEnvironment(environment: Pick<Environment, "ownerId">): {
  owner: string;
} {
  return { owner: environment.ownerId };
}

function peopleAll(request: Request): boolean {
  return new URL(request.url).searchParams.get("people") === "all";
}

// What an admin sees of someone else's Environment and Session: never
// their variable values, folders or what they first asked (ADR 0049).
function environmentOutline(environment: Environment): Environment {
  return { ...environment, variables: {}, folders: [], models: [] };
}

function sessionOutline(session: Session): Session {
  return { ...session, systemPrompt: null, firstMessage: null };
}

// The Host header already passed the server's own site check, and HTTPS
// usually ends in a gateway in front of the server (ADR 0034).
function originOf(request: Request): string {
  const url = new URL(request.url);

  const secure =
    url.protocol === "https:" ||
    request.headers.get("x-forwarded-proto") === "https";

  return `${secure ? "https" : "http"}://${request.headers.get("host") ?? url.host}`;
}
