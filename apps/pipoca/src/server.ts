import {
  type Environment,
  type JoinInfo,
  type ListedTemplate,
  type PluginInfo,
  type Session,
  type SessionEvent,
  type Teammate,
  protocolVersion,
  type EnvironmentKey,
  versionHeader,
} from "@pipoca/protocol";
import { VERSION as piVersion } from "@earendil-works/pi-coding-agent";
import {
  BadRequest,
  fieldsOf,
  HttpError,
  isHttpError,
  NotFound,
  readJson,
} from "@pipoca/plugins";
import {
  type OnBehalf,
  type PluginHost,
  type UserActor,
  userIdOf,
} from "@pipoca/pluginhost";
import { InvalidProfile, ProfileTooBig, type Profiles } from "@pipoca/profiles";
import type { Log } from "@pipoca/providers";
import type { Result, Sessions } from "@pipoca/sessions";
import { version as serverVersion } from "../package.json";
import {
  type Auth,
  type Credentials,
  InvalidCredentials,
  type McpToken,
  type User,
} from "./auth";
import { type Changes, changedBy } from "./changes";
import { mcpHandler } from "./mcp";
import { type AgentRoute, agentRoutes } from "./agent-routes";
import { profileRoutes } from "./profile-routes";
import { errorReply, notFound, rejected, reply } from "./replies";
import {
  browserCommand,
  createEnvironment,
  createFork,
  moveToTeam,
  createSession,
  environmentUpdate,
  joinRequest,
  lineAfter,
  listOf,
  quoteOf,
  sessionAccess,
  teamMessage,
  setupChangeOf,
  textOf,
} from "./requests";
import { presences } from "./presence";
import { sseResponse } from "./sse";
import type { ConfigFiles } from "./config";
import type { Templates } from "./templates";
import { type Hub, layoutOf } from "./hub";

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

export function createHandler(
  auth: Auth,
  sessions: Sessions,
  profiles: Profiles,
  plugins: PluginHost,
  changes: Changes,
  checkStore: () => void,
  log: Log,
  restart?: ServerRestart,
  templates?: Templates,
  config?: ConfigFiles,
  hub?: Hub,
): (request: Request) => Promise<Response> {
  const present = presences();

  const agent = (route: AgentRoute): Route => {
    return async (request, params) => {
      const unsupported = unsupportedVersion(request);
      if (unsupported) {
        return unsupported;
      }

      const caller = auth.agentOf(request);
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
      const user = auth.userOf(request);
      const behalf = onBehalf.get(request);

      const actor =
        behalf?.actor ??
        (user === undefined ? undefined : (`user:${user.id}` as const));

      if (actor === undefined) {
        return errorReply(401, "signed_out", "Sign in again.");
      }

      const admin =
        behalf?.mayAdmin !== false &&
        auth.userById(userIdOf(actor))?.admin === true;

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
      auth.userById(userIdOf(actor))?.admin === true
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
      sessions.sees(params[0] ?? "", userIdOf(actor))
        ? await route(request, params, actor, isAdmin)
        : notFound();

  const steer =
    (route: BrowserRoute): BrowserRoute =>
    async (request, params, actor, isAdmin) => {
      const id = params[0] ?? "";

      if (isAdmin || sessions.belongsTo(id, userIdOf(actor))) {
        return await route(request, params, actor, isAdmin);
      }

      return sessions.sees(id, userIdOf(actor))
        ? rejected("view_only")
        : notFound();
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

  // A runner that joins with a join key gets an Environment of its own name,
  // numbered when another Environment has it.
  const environmentFor = (runner: string, ownerId: string): string => {
    const taken = new Set(
      sessions.environments().map(({ provider }) => provider),
    );

    let provider = runner;
    for (let n = 2; taken.has(provider); n++) {
      provider = `${runner.slice(0, 60)}-${String(n)}`;
    }

    const created = sessions.createEnvironment(provider, ownerId);
    if (!created.ok) {
      throw new Error(`environment ${provider} was not made`);
    }

    log("environment created", { environmentId: created.value.id, runner });
    changes.publish("environments");

    return provider;
  };

  const runnerOnline = (environment: string, runner: string): boolean =>
    sessions
      .environments()
      .some(
        ({ provider, runners }) =>
          provider === environment &&
          runners.some(({ name, online }) => name === runner && online),
      );

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
    ["ANY", /^\/api\/mcp$/, mcpHandler(auth, plugins, serverVersion, log)],
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

        const { name } = joinRequest(await readJson(request));

        const joined =
          scheme === "Bearer" && key !== undefined
            ? auth.join(key, name, {
                create: environmentFor,
                online: runnerOnline,
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

          throw new HttpError(
            409,
            `a runner named ${name} is online here`,
            "runner_online",
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
        const { url } = fieldsOf(await readJson(request));
        const installed = await plugins.install(textOf("url", url));

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
        const { path, content } = fieldsOf(await readJson(request));

        if (typeof content !== "string") {
          throw new BadRequest("content must be text");
        }

        return Response.json(
          await refused(
            plugins.files.write(name, textOf("path", path), content),
          ),
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

        const { force } = fieldsOf(await readJson(request));
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
      (_request, _params, actor) => Response.json(auth.setup(userIdOf(actor))),
    ],
    [
      "POST",
      /^\/api\/setup$/,
      async (request, _params, actor) => {
        const change = setupChangeOf(await readJson(request));

        if ("finished" in change) {
          auth.finishSetup(userIdOf(actor));
        } else {
          auth.dismissSetupStep(userIdOf(actor), change.dismiss);
        }

        return new Response(null, { status: 204 });
      },
    ],
    [
      "GET",
      /^\/api\/pinned-pages$/,
      (_request, _params, actor) =>
        Response.json({ pages: auth.pinnedPages(userIdOf(actor)) }),
    ],
    [
      "PUT",
      /^\/api\/pinned-pages$/,
      async (request, _params, actor) => {
        const { pages } = fieldsOf(await readJson(request));

        auth.pinPages(
          userIdOf(actor),
          listOf("pages", pages, (page) => textOf("page", page)),
        );

        return new Response(null, { status: 204 });
      },
    ],
    [
      "GET",
      /^\/api\/mcp-tokens$/,
      (_request, _params, actor) =>
        Response.json(auth.mcpTokens(userIdOf(actor)).map(mcpTokenView)),
    ],
    [
      "POST",
      /^\/api\/mcp-tokens$/,
      async (request, _params, actor) => {
        const { name } = fieldsOf(await readJson(request));

        const { token, secret } = auth.newMcpToken(
          userIdOf(actor),
          textOf("name", name),
        );

        log("mcp token created", { tokenId: token.id });

        return Response.json(
          { token: mcpTokenView(token), secret },
          { status: 201 },
        );
      },
    ],
    [
      "DELETE",
      /^\/api\/mcp-tokens\/([^/]+)$/,
      (_request, [id = ""], actor) => {
        if (!auth.revokeMcpToken(userIdOf(actor), id)) {
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
        const { settings, enabled, update, digest } = fieldsOf(
          await readJson(request),
        );

        if (enabled !== undefined && typeof enabled !== "boolean") {
          throw new BadRequest("enabled must be true or false");
        }

        const saved = await pluginChange(plugins, name, {
          settings,
          enabled,
          update: update === true,
          ...(typeof digest === "string" && { digest }),
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
            sessions
              .environments(person)
              .filter(({ ownerId }) => ownerId === teamOwner)
              // Anyone can start team work, so they see its folders and
              // models; only its variables stay with admins.
              .map((environment) =>
                isAdmin ? environment : { ...environment, variables: {} },
              ),
          );
        }

        return Response.json(
          sessions
            .environments(person)
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
        const { name, template, team } = createEnvironment(
          await readJson(request),
        );

        if (team === true && !isAdmin) {
          return errorReply(
            403,
            "admin_only",
            "Only admins make team Environments.",
          );
        }

        const created = sessions.createEnvironment(
          name,
          team === true ? teamOwner : userIdOf(actor),
          template,
        );

        if (!created.ok) {
          return reply(created, 201);
        }

        const key = auth.newEnvironmentKey(created.value.provider);
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
          { key: auth.newJoinKey(userIdOf(actor)) },
          { status: 201 },
        );
      },
    ],
    [
      "POST",
      /^\/api\/environments\/([^/]+)\/key$/,
      (_request, [id = ""], actor, isAdmin) => {
        const environment = sessions
          .environments()
          .find((each) => each.id === id && manages(each, actor, isAdmin));

        if (!environment) {
          return notFound();
        }

        const key: EnvironmentKey = {
          key: auth.newEnvironmentKey(environment.provider),
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
          !sessions
            .environments()
            .some((each) => each.id === id && manages(each, actor, isAdmin))
        ) {
          return notFound();
        }

        const updated = sessions.updateEnvironment(
          id,
          environmentUpdate(await readJson(request)),
        );

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
          !sessions
            .environments()
            .some(
              (each) =>
                each.id === id && (isAdmin || each.ownerId === userIdOf(actor)),
            )
        ) {
          return notFound();
        }

        const deleted = sessions.deleteEnvironment(id);
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
          ? Response.json(auth.people())
          : errorReply(403, "admin_only", "Only admins list everyone."),
    ],
    [
      "GET",
      /^\/api\/teammates$/,
      () =>
        Response.json(
          auth.users().map(({ id, name }): Teammate => ({ id, name })),
        ),
    ],
    [
      "GET",
      /^\/api\/invites$/,
      (_request, _params, _actor, isAdmin) =>
        isAdmin
          ? Response.json(auth.invites())
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
          emails,
          admin: asAdmin,
          days,
        } = inviteOf(fieldsOf(await readJson(request)));

        const by = userIdOf(actor);
        const made = auth.invite(by, emails, asAdmin, days);
        const name = auth.userById(by)?.name ?? "An admin";

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
          link: emails.length === 0,
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

        return auth.revokeInvite(id)
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

        const { name, text, version } = fieldsOf(await readJson(request));

        if (
          typeof name !== "string" ||
          typeof text !== "string" ||
          (version !== null && typeof version !== "string")
        ) {
          return errorReply(
            400,
            "invalid_config",
            "Send name, text and version.",
          );
        }

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

        const { admin: makeAdmin } = fieldsOf(await readJson(request));

        if (typeof makeAdmin !== "boolean") {
          throw new BadRequest("admin must be true or false");
        }

        const people = auth.people();
        if (!people.some((person) => person.id === id)) {
          return notFound();
        }

        if (
          !makeAdmin &&
          !people.some((person) => person.admin && person.id !== id)
        ) {
          return errorReply(
            409,
            "last_admin",
            "The server needs an admin: make someone else an admin first.",
          );
        }

        auth.setAdmin(id, makeAdmin);
        log("role changed", { userId: id, admin: makeAdmin });

        return Response.json(auth.people().find((person) => person.id === id));
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

        const layout = layoutOf(await readJson(request));

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
        const created = made.create(await readJson(request));
        log("template created", { templateId: created.id });

        return Response.json(created, { status: 201 });
      }),
    ],
    [
      "POST",
      /^\/api\/templates\/listed$/,
      templateChange(async (request, _params, made) => {
        const { url } = fieldsOf(await readJson(request));
        if (typeof url !== "string") {
          throw new BadRequest("url must be a string");
        }

        return Response.json({ templates: await made.listed(url) });
      }),
    ],
    [
      "POST",
      /^\/api\/templates\/import$/,
      templateChange(async (request, _params, made) => {
        const { url, paths } = fieldsOf(await readJson(request));
        if (
          typeof url !== "string" ||
          !Array.isArray(paths) ||
          !paths.every((path) => typeof path === "string")
        ) {
          throw new BadRequest("url must be a string and paths a list");
        }

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
        const updated = made.update(id, await readJson(request));
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
        const forked = sessions.fork(id, {
          ...createFork(await readJson(request)),
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
        const moved = sessions.move(id, {
          ...moveToTeam(await readJson(request)),
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
          ...createSession(await readJson(request)),
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
        const sees = sessions.sees(id, userIdOf(actor));
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
      steer(async (request, [id = ""], actor) =>
        reply(
          sessions.say(id, { ...teamMessage(await readJson(request)), actor }),
          201,
        ),
      ),
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
        const access = sessionAccess(await readJson(request));

        const users = new Set(auth.users().map((user) => user.id));
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
        const body = await readJson(request);
        const command = browserCommand(body, actor);
        const person = userIdOf(actor);

        if (
          sessions.belongsTo(id, person) ||
          (isAdmin && command.type === "abort")
        ) {
          return reply(
            sessions.send(id, command, quoteOf(fieldsOf(body)["quote"])),
            202,
          );
        }

        return sessions.sees(id, person) ? rejected("view_only") : notFound();
      },
    ],
  ];

  const routes: RouteTable = [
    ...publicRoutes,
    ...browserRoutes.map(
      ([method, pattern, route]) => [method, pattern, signedIn(route)] as const,
    ),
    ...agentRoutes(auth, sessions, profiles, plugins, log).map(
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
            // A plugin that bundles an SDK from before codes throws none
            // (ADR 0046), so its status gives one.
            const { status, code, message } = new HttpError(
              error.status,
              error.message,
              (error as Partial<HttpError>).code,
            );

            return errorReply(status, code, message);
          }

          if (
            error instanceof InvalidProfile ||
            error instanceof ProfileTooBig ||
            error instanceof InvalidCredentials
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
        Response.json({ ...auth.status(request), logins: plugins.logins() }),
    ],
    [
      "POST",
      /^\/api\/auth\/setup$/,
      async (request) => {
        const fields = fieldsOf(await readJson(request));

        const user = await auth.setUp(
          textOf("token", fields["token"]),
          credentialsOf(fields),
        );

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
        const invite = auth.inviteFor(token, undefined);
        if (invite === undefined) {
          return expiredInvite();
        }

        return Response.json({
          email: invite.email,
          admin: invite.admin,
          invitedBy: auth.userById(invite.createdBy)?.name ?? "An admin",
          expiresAt: invite.expiresAt,
          passwordLogin: auth.passwordLogin,
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
        const joined = await auth.joinWithInvite(
          token,
          credentialsOf(fieldsOf(await readJson(request))),
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

        const user = auth.redeemSignInLink(token, verifier);

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
            "set-cookie": auth.startSession(user, request),
          },
        });
      },
    ],
    [
      "POST",
      /^\/api\/auth\/app$/,
      async (request) => {
        const user = auth.userOf(request);
        if (user === undefined) {
          return errorReply(401, "signed_out", "Sign in first.");
        }

        const challenge = textOf(
          "challenge",
          fieldsOf(await readJson(request))["challenge"],
        );

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
        link.searchParams.set("link", auth.appSignInLink(user, challenge));

        return Response.json({ link: link.href });
      },
    ],
    [
      "POST",
      /^\/api\/auth\/login$/,
      async (request) => {
        const credentials = credentialsOf(fieldsOf(await readJson(request)));
        const address = addresses.get(request) ?? "";
        const user = await auth.signIn(credentials, address);

        if (user === "off") {
          return errorReply(
            403,
            "password_login_off",
            "This server doesn't sign people in with a password.",
          );
        }

        if (user === "locked") {
          log("sign-in locked", { name: credentials.name, address });

          return errorReply(
            429,
            "locked",
            "Too many failed sign-ins. Try again in 15 minutes.",
          );
        }

        if (user === "wrong") {
          log("sign-in failed", { name: credentials.name, address });

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
          headers: { "set-cookie": auth.endSession(request) },
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
    headers: { "set-cookie": auth.startSession(user, request) },
  });
}

const maxInvites = 100;
const emailPattern = /^[^\s@]+@[^\s@]+$/;

function inviteOf(fields: Record<string, unknown>): {
  readonly emails: readonly string[];
  readonly admin: boolean;
  readonly days: number;
} {
  const { emails = [], admin = false, days = 7 } = fields;

  if (
    !Array.isArray(emails) ||
    emails.length > maxInvites ||
    !emails.every(
      (email): email is string =>
        typeof email === "string" && emailPattern.test(email.trim()),
    )
  ) {
    throw new BadRequest(
      `emails must be a list of up to ${String(maxInvites)} email addresses`,
    );
  }

  if (typeof admin !== "boolean") {
    throw new BadRequest("admin must be true or false");
  }

  if (
    typeof days !== "number" ||
    !Number.isInteger(days) ||
    days < 1 ||
    days > 30
  ) {
    throw new BadRequest("days must be a whole number from 1 to 30");
  }

  return {
    emails: [...new Set(emails.map((email) => email.trim().toLowerCase()))],
    admin,
    days,
  };
}

function expiredInvite(): Response {
  return errorReply(
    404,
    "invalid_invite",
    "This invite was used, revoked or is too old. Ask an admin for a new one.",
  );
}

function credentialsOf(fields: Record<string, unknown>): Credentials {
  return {
    name: textOf("name", fields["name"]).trim(),
    password: textOf("password", fields["password"]),
  };
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

function mcpTokenView({
  id,
  name,
  createdAt,
}: McpToken): Omit<McpToken, "userId"> {
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

// A person changes their own Environments, and admins the team's.
function manages(
  environment: Environment,
  actor: UserActor,
  isAdmin: boolean,
): boolean {
  return (
    environment.ownerId === userIdOf(actor) ||
    (environment.ownerId === teamOwner && isAdmin)
  );
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
