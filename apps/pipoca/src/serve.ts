import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ServerWebSocket } from "bun";
import { askServer } from "@pipoca/ask/server";
import { gitHosts } from "@pipoca/git-hosts/server";
import { kubernetesPlugin } from "@pipoca/kubernetes/server";
import { library } from "@pipoca/library/server";
import { push } from "@pipoca/push/server";
import { local, type LocalOptions } from "@pipoca/local/server";
import { logins as loginsPlugin } from "@pipoca/logins/server";
import { meta } from "@pipoca/meta/server";
import { models } from "@pipoca/models/server";
import { oidc } from "@pipoca/oidc/server";
import { projects } from "@pipoca/projects/server";
import { email } from "@pipoca/email/server";
import { routines } from "@pipoca/routines/server";
import { usage } from "@pipoca/usage/server";
import { slack } from "@pipoca/slack/server";
import {
  kernelToolsets,
  pluginSwitches,
  startPlugins,
} from "@pipoca/pluginhost";
import { eventBus, type ServerPlugin } from "@pipoca/plugins";
import {
  apiPath,
  type Clock,
  type Log,
  type PluginManifest,
  systemClock,
} from "@pipoca/protocol";
import { ProfileFolders, Profiles } from "@pipoca/profiles";
import { Sessions } from "@pipoca/sessions";
import {
  environmentTemplates,
  Environments,
  type EnvironmentsOptions,
  RunnerCredentials,
} from "@pipoca/environments";
import { People, SignIn } from "@pipoca/people";
import web from "@pipoca/web/index.html";
import { type AgentOptions, runAgent } from "@pipoca/runner";
import { binary, pipoca } from "./binary";
import { configFiles, configFolder } from "./config";
import { sessionDocs } from "./docs";
import { hubSettings } from "./hub";
import { newcomerSetup } from "./newcomers";
import { serverConfig } from "./server-config";
import { teamSettings } from "./team";
import {
  buildPlugin,
  pluginFiles,
  readPluginFile,
  writePluginFile,
} from "./in-place";
import {
  type InstalledPlugin,
  install,
  remove,
  reread,
  update,
} from "./installed";
import { latestCommit } from "@pipoca/repositories";
import { builtInPlugins, sessionPlugins } from "./session-parts";
import { errorReply } from "./server/http/replies";
import { previewBroker } from "./previews";
import { webAppFile } from "./web-app";
import { changeFeed } from "./changes";
import { createApi } from "./server/http/api";
import { fromAddress, onBehalfOf } from "./server/http/router";
import type { PreviewData, SocketData, TerminalData } from "./sockets";
import { openStore, type Store } from "./sqlite/store";
import { terminalBroker } from "./terminals";

const serverPlugins: readonly ServerPlugin[] = [
  askServer,
  projects,
  library,
  models,
  kubernetesPlugin,
  meta,
  oidc,
  gitHosts,
  loginsPlugin,
  push,
  routines,
  slack,
  email,
  usage,
];

const updateCheckMs = 6 * 60 * 60_000;
export interface ServeOptions {
  // 127.0.0.1 unless a proxy or other machines reach the server directly.
  readonly hostname?: string;
  readonly port: number;
  // Where people open the server, for the setup link, when that isn't where
  // it listens, such as behind a gateway.
  readonly url?: URL;
  readonly database: string;
  // Holds pipoca.json and the plugins' own config files (ADR 0039); a
  // config folder next to the database when unset.
  readonly configDir?: string;
  // A pipoca.json whose plugin keys win and stay read-only in Settings, such
  // as the one the Helm chart mounts (ADR 0063).
  readonly lockedConfig?: string;
  // Encrypts Environment secrets; a file next to the database when unset.
  readonly secretKey?: Buffer;
  // False leaves only the setup link and plugin logins, such as OIDC.
  readonly passwordLogin?: boolean;
  // One person's install (ADR 0053): it has one admin, named here, who signs
  // in through one-time links that `pipoca link` asks for over this socket.
  // Its server starts runners on its own machine, and makes an Environment
  // whose runner shares these folders while it has none.
  readonly solo?: {
    readonly name: string;
    readonly socket: string;
    readonly folders?: readonly string[];
  };
  // Takes a client's address from the X-Forwarded-For entry the proxy in
  // front added. Only behind one, since without it anyone can send that
  // header and pick the address their failed sign-ins count against.
  readonly trustProxy?: boolean;
  // How the runner pool times polls, going offline and leases.
  readonly runners?: Pick<
    EnvironmentsOptions,
    "pollWaitMs" | "offlineAfterMs" | "leaseMs"
  >;
  readonly agent?: Omit<
    AgentOptions,
    "server" | "credential" | "binary" | "log" | "signal"
  >;
  // Replaces the built-in plugins. A plugin without a manifest gets one with
  // just its name.
  readonly plugins?: readonly ServerPlugin[];
  readonly manifests?: readonly PluginManifest[];
  readonly disabledPlugins?: readonly string[];
  // The plugins folder and what was found in it (ADR 0022).
  readonly installed?: {
    readonly root: string;
    readonly plugins: readonly InstalledPlugin[];
  };
  // Exits so that whatever runs the server starts it again. Without it the
  // server can't restart itself.
  readonly restart?: () => void;
  // Seconds a connection may go quiet before the server closes it; 30 when
  // unset.
  readonly idleTimeout?: number;
  // The clock leases, tokens and stored times follow; the system's when unset.
  readonly clock?: Clock;
  readonly log: Log;
}

export function serve(options: ServeOptions): {
  readonly url: URL;
  readonly stop: () => Promise<void>;
} {
  // A server on an in-memory database keeps nothing, its config included.
  const configDir =
    options.configDir ??
    (options.database === ":memory:"
      ? mkdtempSync(join(tmpdir(), "pipoca-config-"))
      : join(dirname(options.database), "config"));

  const config = configFolder(configDir, options.log, options.lockedConfig);

  const profiles = new ProfileFolders(
    join(configDir, "profiles"),
    options.log,
    join(configDir, "base"),
    join(configDir, "people"),
  );

  const clock = options.clock ?? systemClock;

  // Which plugins are on, under "plugins" in pipoca.json. A team server's
  // machine holds everyone's data and the sealing key, so only a solo install
  // runs runners on it unless admins say otherwise, and a solo install signs
  // in no one else (ADR 0053).
  const switches = pluginSwitches(config("plugins"));
  const offByDefault = options.solo === undefined ? ["local"] : ["oidc"];

  const folder = options.installed;
  const installed = folder?.plugins ?? [];
  let seed: LocalOptions["seed"];

  const thisMachine = local(() => ({
    command: pipoca,
    server: () => server.url.href,
    dataDir:
      options.database === ":memory:"
        ? mkdtempSync(join(tmpdir(), "pipoca-local-"))
        : join(dirname(options.database), "local"),
    ...(seed !== undefined && { seed }),
  }));

  const plugins = [
    ...(options.plugins ?? [...serverPlugins, thisMachine]),
    ...installed.flatMap(({ server }) => (server ? [server] : [])),
  ];

  const builtIn =
    options.plugins?.map(
      ({ name }) =>
        options.manifests?.find(({ id }) => id === name) ??
        builtInPlugins.find(({ id }) => id === name) ?? {
          id: name,
          title: name,
          description: "",
        },
    ) ?? builtInPlugins;

  const known = [...builtIn, ...installed.map(({ manifest }) => manifest)];

  const enabled = [
    ...builtIn
      .map(({ id }) => id)
      .filter(
        (name) =>
          options.disabledPlugins?.includes(name) !== true &&
          (switches.get(name).personal ?? !offByDefault.includes(name)),
      ),
    ...installed.flatMap(({ manifest: { id }, on }) => (on ? [id] : [])),
  ];

  const store = openStore(
    options.database,
    options.secretKey,
    profiles,
    clock,
    plugins.filter(({ name }) => enabled.includes(name)),
  );

  // A Session on the server's own runner would share the server pod's files,
  // its sealing key among them, so a server that can start runner pods runs
  // no runner itself (ADR 0049). The chart names the runners' URL only when
  // it lets the server start them.
  const startsPods =
    enabled.includes("kubernetes") &&
    process.env["KUBERNETES_SERVICE_HOST"] !== undefined &&
    process.env["PIPOCA_RUNNER_URL"] !== undefined;

  const ownAgent = startsPods ? undefined : options.agent;

  if (options.agent !== undefined && ownAgent === undefined) {
    options.log(
      "the server's own runner is off, since it starts runner pods in its cluster",
      { runner: options.agent.provider },
    );
  }

  const events = eventBus((type, error) => {
    options.log("event listener failed", { type, error: String(error) });
  });

  const changes = changeFeed();

  const templates = environmentTemplates(config("templates"), options.log);
  const ownConfig = serverConfig(config("server"));
  const team = teamSettings(config("team"));

  const environments: Environments = new Environments(store.environments, {
    ...options.runners,
    clock,
    templates: () => templates.list(),
    offeredModels: (environment, userId) =>
      pluginHost.offeredModels(environment, userId),
    startsRunners: (environment) => pluginHost.startsRunners(environment),
    sessions: () => ({
      running: (provider, runner) => sessions.running(provider, runner),
      inUse: (id) => sessions.inUse(id),
      removed: () => {
        changes.publish("sessions");
      },
    }),
    onlineChanged: (provider, runner) => {
      sessions.runnerChanged(provider, runner);
    },
    changed: () => {
      changes.publish("environments");
    },
  });

  const sessions: Sessions = new Sessions(store.sessions, environments, {
    clock,
    events: events.publish,
    changed: () => {
      changes.publish("sessions");
    },
    sessionPlugins: () => pluginHost.sessionPlugins(),
    offeredModels: (environment, userId) =>
      pluginHost.offeredModels(environment, userId),
    pluginProfile: (id) => pluginHost.profile(id),
    gitLogins: (userId, session) => pluginHost.gitLogins(userId, session),
    teamMessagesRead: team.messagesRead,
    names: (person) => people.userById(person)?.name,
    docs: sessionDocs(
      folder === undefined
        ? []
        : installed.flatMap(({ manifest: { id }, on }) =>
            on ? [{ id, folder: join(folder.root, id) }] : [],
          ),
    ),
  });

  const pluginsStop = new AbortController();

  // Outside a cluster, the built-in runner's Environment is the first
  // person's (ADR 0049): made when the setup link, a sign-in or a solo
  // install makes them, and until then its runner polls for nothing.
  const ownRunner = ownAgent?.provider;

  const ownEnvironment = (person: string): void => {
    if (ownRunner !== undefined) {
      store.environments.ensureEnvironment(ownRunner, person);
    }
  };

  const peopleStore = {
    ...store.people,
    insertUser: (user: Parameters<typeof store.people.insertUser>[0]) => {
      store.people.insertUser(user);

      if (store.people.userCount() === 1) {
        ownEnvironment(user.id);
      }
    },
  };

  const people = new People(peopleStore, {
    clock,
    ...(options.solo && { solo: options.solo.name }),
  });

  const signIn = new SignIn(people, peopleStore, {
    clock,
    ...(options.passwordLogin !== undefined && {
      passwordLogin: options.passwordLogin,
    }),
    sessionDays: () => ownConfig().sessionDays,
  });

  const runners = new RunnerCredentials(store.credentials, {
    clock,
    runnerTokenDays: () => ownConfig().runnerTokenDays,
  });

  const auth = { people, signIn, runners };

  if (
    options.solo !== undefined &&
    store.environments.environments().length === 0
  ) {
    seed = thisMachineEnvironment(store, options.solo.folders ?? []);
  }

  const userProfiles = new Profiles(profiles, store.profiles);

  // Profiles and templates that follow a repository keep up with it
  // (ADR 0063).
  let syncing: ReturnType<typeof setTimeout> | undefined;

  const syncLater = (): void => {
    syncing = setTimeout(() => {
      void userProfiles.sync(options.log).then(async () => templates.sync());
      syncLater();
    }, ownConfig().repositorySyncMinutes * 60_000);
  };

  syncLater();

  const pluginHost = startPlugins(plugins, enabled, {
    manifests: known,
    sessions,
    environments,
    runners: {
      token: (environment, runner) => runners.runnerToken(environment, runner),
      revoke: (environment, runner) => {
        runners.revokeRunner(environment, runner);
      },
    },
    events,
    changes: changes.publish,
    store: store.plugin,
    dataFailure: store.pluginFailure,
    resetData: store.resetPlugin,
    config,
    toolsets: kernelToolsets,
    api: async (onBehalf, request) => handler(onBehalfOf(onBehalf, request)),
    auth: {
      userOf: (request) => signIn.userOf(request),
      users: () => people.users(),
      createUser: (name, admin) => people.createUser(name, admin),
      setAdmin: (userId, admin) => {
        people.setAdmin(userId, admin);
      },
      invited: (token, address) => people.inviteFor(token, address),
      acceptInvite: (id) => {
        people.acceptInvite(id);
      },
      passwordLogin: () => signIn.passwordLogin,
      startSession: (userId, request) => {
        const user = people.userById(userId);

        return user && signIn.startSession(user, request);
      },
    },
    ...(folder && {
      installed: {
        plugins: installed,
        install: async (url, taken) => install(folder.root, url, taken),
        update: async (id) => update(folder.root, id),
        latest: latestCommit,
        remove: async (id) => remove(folder.root, id),
        reread: async (id) => reread(folder.root, id),
        files: async (id) => pluginFiles(folder.root, id),
        read: async (id, path) => readPluginFile(folder.root, id, path),
        write: async (id, path, content) =>
          writePluginFile(folder.root, id, path, content),
        build: async (id) => buildPlugin(folder.root, id),
      },
    }),
    sessionParts: sessionPlugins,
    mcpServers: () => userProfiles.mcpServers(),
    switches,
    templates,
    buildsOn: (id) => profiles.buildsOn(id),
    signal: pluginsStop.signal,
    log: options.log,
  });

  // Asked at start and a few times a day, since each check reaches every
  // installed plugin's repository.
  void pluginHost.checkUpdates();

  const checkingUpdates = setInterval(() => {
    void pluginHost.checkUpdates();
  }, updateCheckMs);

  const api = createApi({
    people,
    signIn,
    runners,
    sessions,
    environments,
    profiles: userProfiles,
    plugins: pluginHost,
    changes,
    checkStore: store.check,
    log: options.log,
    restart: options.restart && {
      busy: () =>
        sessions
          .list()
          .filter(
            ({ provider, runner, status }) =>
              provider === ownAgent?.provider &&
              runner === ownAgent.provider &&
              (status === "starting" || status === "running"),
          ).length,
      now: options.restart,
    },
    templates,
    config: configFiles(configDir, options.lockedConfig),
    hub: hubSettings(config("hub")),
    newcomers: newcomerSetup(config("newcomers")),
    team,
  });

  const handler = api.handle;

  const terminals = terminalBroker(sessions, auth, options.log);

  const siteHosts = new Set([
    ...loopback,
    ...(options.url ? [options.url.hostname] : []),
    ...(options.hostname === undefined || wildcards.has(options.hostname)
      ? []
      : [options.hostname]),
  ]);

  const previews = previewBroker({
    sessions,
    auth,
    siteHosts,
    secure: options.url?.protocol === "https:",
    log: options.log,
  });

  const server = Bun.serve<SocketData>({
    hostname: options.hostname ?? "127.0.0.1",
    port: options.port,
    idleTimeout: options.idleTimeout ?? 30,
    development: false,
    routes: { [webPath]: web },
    fetch: async (request, bunServer) => {
      const preview = await previews.visit(request, bunServer);
      if (preview === "upgraded") {
        return undefined;
      }

      if (preview !== undefined) {
        return preview;
      }

      const { pathname } = new URL(request.url);
      if (pathname === "/") {
        return fetch(new URL(webPath, bunServer.url));
      }

      const appFile =
        request.method === "GET" ? webAppFile(pathname) : undefined;

      if (appFile !== undefined) {
        return appFile;
      }

      if (!fromThisSite(request, siteHosts)) {
        return errorReply(
          403,
          "forbidden",
          "Requests from another site aren't allowed.",
        );
      }

      const upgraded =
        terminals.upgrade(request, bunServer) ??
        previews.upgrade(request, bunServer);

      if (upgraded === "upgraded") {
        return undefined;
      }

      if (api.takesLong(request)) {
        bunServer.timeout(request, 0);
      }

      return (
        upgraded ??
        previews.open(request) ??
        handler(
          fromAddress(
            clientAddress(request, bunServer, options.trustProxy === true),
            request,
          ),
        )
      );
    },
    websocket: {
      open: (ws) => {
        if (isPreview(ws)) {
          previews.websocket.open(ws);
        } else if (isTerminal(ws)) {
          terminals.websocket.open(ws);
        }
      },
      message: (ws, message) => {
        if (isPreview(ws)) {
          previews.websocket.message(ws, message);
        } else if (isTerminal(ws)) {
          terminals.websocket.message(ws, message);
        }
      },
      close: (ws, code, reason) => {
        if (isPreview(ws)) {
          previews.websocket.close(ws, code, reason);
        } else if (isTerminal(ws)) {
          terminals.websocket.close(ws, code, reason);
        }
      },
    },
  });

  options.log("server listening", { url: server.url.href });

  const links =
    options.solo &&
    soloSocket(options.solo.socket, {
      link: () =>
        new URL(
          apiPath("auth.link", { params: { token: signIn.link() } }),
          options.url ?? server.url,
        ),
      runner: (name) => {
        const [owner] = people.users();

        if (owner === undefined) {
          throw new Error("a solo install has no user yet");
        }

        store.environments.ensureEnvironment(name, owner.id);

        return runners.runnerToken(name, name);
      },
    });

  if (signIn.setupToken !== undefined) {
    options.log("open the setup link to create the first user", {
      link: new URL(`/#setup/${signIn.setupToken}`, options.url ?? server.url)
        .href,
    });
  }

  const agentStop = new AbortController();

  const [firstPerson] = people.users();

  if (firstPerson !== undefined) {
    ownEnvironment(firstPerson.id);
  }

  // The built-in provider is the same agent a laptop runs, talking to this
  // server over loopback, so both providers share one tested path.
  const agent =
    ownAgent &&
    runAgent({
      binary,
      ...ownAgent,
      server: server.url.href,
      credential: {
        token: runners.ownRunnerToken(ownAgent.provider, ownAgent.provider),
      },
      log: options.log,
      signal: agentStop.signal,
    });

  return {
    url: server.url,
    stop: async () => {
      clearTimeout(syncing);
      clearInterval(checkingUpdates);
      agentStop.abort();
      pluginsStop.abort();
      await agent;
      await links?.stop(true);
      await server.stop(true);
      environments.close();
      store.close();
      options.log("server stopped");
    },
  };
}

// The socket is made for the server's own system user only, so only they get
// a link that signs a browser in, or a token that joins a machine of theirs
// as the runner of its own Environment, as `pipoca connect` does.
function soloSocket(
  socket: string,
  answers: {
    readonly link: () => URL;
    readonly runner: (name: string) => string;
  },
): Bun.Server<undefined> {
  mkdirSync(dirname(socket), { recursive: true, mode: 0o700 });
  rmSync(socket, { force: true });

  const umask = process.umask(0o077);

  try {
    return Bun.serve({
      unix: socket,
      fetch: (request) => {
        const url = new URL(request.url);
        const name = url.searchParams.get("name") ?? "";

        if (request.method !== "POST") {
          return new Response(null, { status: 404 });
        }

        if (url.pathname === "/link") {
          return Response.json({ url: answers.link().href });
        }

        if (url.pathname === "/runner" && /^[\w.-]{1,64}$/.test(name)) {
          return Response.json({ token: answers.runner(name) });
        }

        return new Response(null, { status: 404 });
      },
    });
  } finally {
    process.umask(umask);
  }
}

// A proxy adds the address it saw to the end of the header, after whatever
// the client sent.
function clientAddress(
  request: Request,
  server: Bun.Server<SocketData>,
  trustProxy: boolean,
): string {
  const forwarded = trustProxy
    ? request.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim()
    : undefined;

  if (forwarded !== undefined && forwarded !== "") {
    return forwarded;
  }

  return server.requestIP(request)?.address ?? "";
}

function isPreview(
  ws: ServerWebSocket<SocketData>,
): ws is ServerWebSocket<PreviewData> {
  return ws.data.kind === "preview";
}

function isTerminal(
  ws: ServerWebSocket<SocketData>,
): ws is ServerWebSocket<TerminalData> {
  return ws.data.kind === "terminal";
}

// Bun matches routes before fetch and on every host, so the web UI can't be
// a route at "/", where a preview's own page is.
const webPath = "/__pipoca/web";

const loopback = ["127.0.0.1", "localhost", "[::1]"];
const wildcards = new Set(["0.0.0.0", "::", "[::]"]);

// Runners carry a token and reach the server under any name, such as Docker's
// host.docker.internal or a cluster Service's. A browser page sends an Origin.
// Pages are refused under names the server doesn't go by, so one that rebinds
// its own name to the server can't even try passwords (ADR 0033).
function fromThisSite(request: Request, hosts: ReadonlySet<string>): boolean {
  const host = request.headers.get("host") ?? "";
  const origin = request.headers.get("origin");

  const { pathname } = new URL(request.url);

  // Health checks, such as Kubernetes probes, use the pod's own address.
  if (pathname === "/healthz") {
    return true;
  }

  if (pathname.startsWith("/runner/")) {
    return origin === null;
  }

  return (
    URL.canParse(`http://${host}`) &&
    hosts.has(new URL(`http://${host}`).hostname) &&
    (origin === null || (URL.canParse(origin) && new URL(origin).host === host))
  );
}

// The Environment a new solo install starts with, its runner on this machine.
function thisMachineEnvironment(
  store: Store,
  folders: readonly string[],
): LocalOptions["seed"] {
  const provider = "this-machine";
  const [owner] = store.people.users();

  if (owner === undefined) {
    return undefined;
  }

  store.environments.ensureEnvironment(provider, owner.id);

  const created = store.environments
    .environments()
    .find((environment) => environment.provider === provider);

  if (created === undefined) {
    return undefined;
  }

  store.environments.updateEnvironment({ ...created, name: "This machine" });

  return { environmentId: created.id, folders };
}
