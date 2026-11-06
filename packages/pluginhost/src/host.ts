import { basename } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { Environments } from "@pipoca/environments";
import type {
  Person,
  PluginDefinition,
  RouteToolSpec,
  ProfileMcpServer,
  RunnerSource,
  SignInApi,
  SignInProvider,
  ToolDef,
} from "@pipoca/plugins";
import {
  checked,
  type ConfigKey,
  configOf,
  envSecrets,
  type EventBus,
  type ModelOffer,
  pluginConfig,
  pluginEvents,
  type PluginEnvironments,
  type RunnerProvider,
  type Runners,
  type Runtime,
  sealedConfig,
  secretRefs,
  type ServerPart,
  sessionConfig,
  transcriptReader,
} from "@pipoca/plugins/host";
import type {
  Actor,
  Clock,
  DeclaredEvent,
  GitLogin,
  Log,
  Owner,
  PluginInfo,
  PluginManifest,
  RunnersFrom,
  Session,
  Timer,
  ToolCall,
  ToolResult,
  ToolSpec,
} from "@pipoca/protocol";
import type { PluginProfile, SessionPlugins, Sessions } from "@pipoca/sessions";
import { type PluginDb, secretsOf, sessionsFor, storeOf } from "./context";
import {
  definedTool,
  kernelRouteTools,
  type RouteTool,
  routeTools as routeToolsOf,
  routeToolQuestion,
  runRouteTool,
  type ServedTool,
} from "./tools";
import { scheduler, type ScheduleStore } from "./scheduler";
import { kernelKeys, type PluginSwitches } from "./switches";
import { type ExtRoute, pluginRoutes, pluginUrls } from "./routes";

export type UserActor = `user:${string}`;

type GitLoginsOf = (
  owner: Owner,
  session: Pick<Session, "actsAs" | "workspace">,
) => readonly GitLogin[];

export interface PluginConfigView {
  readonly value: unknown;
  readonly lockedIn?: string;
}

export function userIdOf(actor: UserActor): string {
  return actor.slice("user:".length);
}

// Who a toolset tool's request acts as (ADR 0035). A meta-session's acts as
// the user who started it, but never as an admin (ADR 0038). A team
// Session's reach only team work, so nothing it does touches the person's
// own (ADR 0067).
export interface OnBehalf {
  readonly actor: UserActor;
  readonly mayAdmin: boolean;
  readonly team: boolean;
}

export interface PluginHost {
  // The plugins that are on, without any that failed to register.
  readonly names: readonly string[];
  readonly list: () => readonly PluginInfo[];
  // Asks where each installed plugin came from whether it has a newer
  // version, for the Plugins page to offer.
  readonly checkUpdates: () => Promise<void>;
  // Tells plugins of something the kernel did.
  readonly publish: EventBus["publish"];
  // Drops the tables of a plugin that failed because of them, makes them again and starts it, as it
  // starts after its schema changed (ADR 0068). Says why it couldn't, or
  // undefined when no plugin has the name.
  readonly resetData: (name: string) => PluginInfo | string | undefined;
  // A defined plugin's config as pipoca.json keeps it, its secrets sealed or
  // named by environment variable, or undefined when it has none.
  readonly config: (name: string) => PluginConfigView | undefined;
  // Seals the plain secrets in it first. Says what is wrong with it, or
  // undefined when the plugin has no config.
  readonly setConfig: (
    name: string,
    value: unknown,
  ) => PluginConfigView | string | undefined;
  // Turns an installed plugin on or off for the next start.
  // Turning one on with the digest of the manifest and files the user saw
  // refuses it when its folder changed since.
  readonly turnOn: (
    name: string,
    on: boolean,
    digest?: string,
  ) => Promise<PluginInfo | string | undefined>;
  // Installs a plugin from a git repository or a tarball, turned off.
  readonly install: (url: string) => Promise<PluginInfo | string>;
  // Fetches an installed plugin's newest version for the next start.
  readonly update: (name: string) => Promise<PluginInfo | string | undefined>;
  // Removes an installed plugin that isn't running.
  readonly remove: (name: string) => Promise<boolean | string>;
  // The files of an in-place plugin, which a meta-session writes and builds
  // while it is turned off (ADR 0035). These throw with why they can't.
  readonly files: {
    readonly list: (name: string) => Promise<readonly string[]>;
    readonly read: (name: string, path: string) => Promise<string>;
    readonly write: (
      name: string,
      path: string,
      content: string,
    ) => Promise<PluginInfo>;
    readonly build: (name: string) => Promise<PluginInfo>;
  };
  // The file of a running installed plugin's web part, by its name.
  readonly webPart: (name: string, file: string) => string | undefined;
  // The file of a running installed plugin's Session part, by its hash.
  readonly sessionPart: (name: string, hash: string) => string | undefined;
  readonly sessionPlugins: () => SessionPlugins;
  // Keeps a plugin that works in team work on or off there. Says why not,
  // or undefined when no plugin has the name.
  readonly setTeamWork: (
    name: string,
    on: boolean,
  ) => PluginInfo | string | undefined;
  readonly profile: (id: string) => PluginProfile | undefined;
  readonly profileIds: () => readonly string[];
  readonly tools: (session: Session) => readonly ToolSpec[];
  readonly call: (session: Session, call: ToolCall) => void;
  // What to ask the person before the Session's call, if anything.
  readonly question: (
    session: Session,
    name: string,
    input: unknown,
  ) => Promise<string | undefined>;
  // Every route tool, and a call to one as a person, for MCP clients.
  readonly routeTools: () => readonly ToolSpec[];
  readonly callRouteTool: (
    name: string,
    input: unknown,
    actor: UserActor,
  ) => Promise<ToolResult>;
  readonly offeredModels: ModelOffer;
  // The plugin that starts runners for the Environment on demand, if any.
  readonly startsRunners: (
    environment: RunnerSource,
  ) => RunnersFrom | undefined;
  // A plugin starts runners where the server's own would share its files.
  readonly replacesServerRunner: () => boolean;
  readonly gitLogins: GitLoginsOf;
  // The links the sign-in page shows besides the password form, each with
  // its path from the server's root.
  readonly logins: () => readonly {
    readonly label: string;
    readonly path: string;
  }[];
  readonly extRoutes: () => readonly ExtRoute[];
}

function runnersOf(
  sessions: Sessions,
  environments: Environments,
  runners: {
    readonly token: (environment: string, runner: string) => string;
    readonly revoke: (environment: string, runner: string) => void;
  },
): Runners {
  const provider = (environmentId: string): string => {
    const found = environments.get(environmentId);

    if (found === undefined) {
      throw new Error(`no Environment ${environmentId}`);
    }

    return found.provider;
  };

  return {
    unplaced: (environmentId) => sessions.unplaced(environmentId),
    token: (environmentId, runner) =>
      runners.token(provider(environmentId), runner),
    revoke: (environmentId, runner) => {
      runners.revoke(provider(environmentId), runner);
    },
  };
}

export function startPlugins(
  enabled: readonly string[],
  deps: {
    readonly definitions: readonly PluginDefinition[];
    readonly servers: readonly ServerPart[];
    // Where people open the server, for plugins' public URLs.
    readonly url: () => URL;
    // What the Plugins page lists, on or not.
    readonly manifests: readonly PluginManifest[];
    readonly sessions: Sessions;
    readonly environments: Environments;
    readonly runners: {
      readonly token: (environment: string, runner: string) => string;
      readonly revoke: (environment: string, runner: string) => void;
    };
    readonly events: EventBus;
    readonly changes: (topic: string) => void;
    readonly store: (name: string) => PluginDb;
    // Why a plugin's tables can't be used, if they can't.
    readonly dataFailure: (name: string) => string | undefined;
    // Drops a plugin's tables and makes them again, or says why it couldn't.
    readonly resetData: (name: string) => string | undefined;
    readonly config: (name: string) => ConfigKey;
    // Handles a route tool's request as the person.
    readonly api: (onBehalf: OnBehalf, request: Request) => Promise<Response>;
    readonly auth: { readonly users: () => readonly Person[] } & SignInApi;
    readonly installed?: InstalledPlugins;
    readonly mcpServers?: () => readonly ProfileMcpServer[];
    readonly switches: PluginSwitches;
    // Each plugin's key in a template's entry in pipoca.json.
    readonly templates?: {
      readonly config: (templateId: string, plugin: string) => unknown;
      readonly setConfig: (
        templateId: string,
        plugin: string,
        value: unknown,
      ) => void;
    };
    readonly buildsOn?: (profileId: string) => readonly string[];
    // What runner providers start runners on this machine with.
    readonly runtime?: () => Runtime;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly schedules: ScheduleStore;
    readonly clock: Clock;
    readonly timer: Timer;
    readonly signal: AbortSignal;
    readonly log: Log;
  },
): PluginHost {
  const tools = new Map<string, ServedTool>();
  const routeTools = new Map<string, RouteTool>();
  const routeToolProfiles = new Set<string>();
  let signIn: { plugin: string; provider: SignInProvider } | undefined;
  const { users: _users, ...signInApi } = deps.auth;
  const offers: { plugin: string; offer: ModelOffer }[] = [];
  const gitLogins: { plugin: string; of: GitLoginsOf }[] = [];
  const fromEnv = envSecrets(process.env);
  const settled = new Set<string>();

  const used = new Map<
    string,
    { readonly uses: readonly string[]; readonly provides: readonly string[] }
  >();

  const transcript = transcriptReader((id) => deps.sessions.transcript(id));
  const running: string[] = [];

  // A plugin's code the kernel calls, such as for the models it offers,
  // can't break the kernel: a throw is logged and counts as nothing offered
  // (spec 2.8a).
  const guarded = <T>(
    plugin: string,
    call: string,
    nothing: T,
    run: () => T,
  ): T => {
    try {
      return run();
    } catch (error) {
      deps.log("plugin call failed", {
        plugin,
        call,
        error: messageOf(error),
      });

      return nothing;
    }
  };

  const schedules = scheduler({
    store: deps.schedules,
    clock: deps.clock,
    timer: deps.timer,
    on: () => running,
    signal: deps.signal,
    log: deps.log,
  });

  const starters: (RunnerProvider & { readonly plugin: string })[] = [];

  const failures = new Map<string, string>(
    deps.installed?.plugins.flatMap(({ manifest: { id }, error }) =>
      error === undefined ? [] : [[id, error] as const],
    ),
  );

  const installedIds = new Set(
    deps.installed?.plugins.map(({ manifest: { id } }) => id),
  );

  // What is in the plugins folder now, which installs and updates change
  // before the server restarts.
  let manifests = [...deps.manifests];

  const sources = new Map(
    deps.installed?.plugins.flatMap(({ manifest: { id }, source }) =>
      source === undefined ? [] : [[id, source] as const],
    ),
  );

  const updated = new Set<string>();

  // Installed plugins whose URL points at a newer version than they have.
  const newer = new Set<string>();

  const fileDigests = new Map(
    deps.installed?.plugins.flatMap(({ manifest: { id }, digest }) =>
      digest === undefined ? [] : [[id, digest] as const],
    ),
  );

  const remember = (id: string, digest: string | undefined): void => {
    if (digest === undefined) {
      fileDigests.delete(id);
    } else {
      fileDigests.set(id, digest);
    }
  };

  const folder = (): InstalledPlugins => {
    if (deps.installed === undefined) {
      throw new Error("this server has no plugins folder");
    }

    return deps.installed;
  };

  // Only a plugin turned off changes, since turning one on trusted what it
  // was then.
  const changeable = (name: string): InstalledPlugins => {
    if (listed(name) !== undefined && !installedIds.has(name)) {
      throw new Error(`${name} is a built-in plugin`);
    }

    if (switchedOn.has(name)) {
      throw new Error(
        `${name} is turned on; the user turns it off on the Plugins page before it changes`,
      );
    }

    return folder();
  };

  // Writes, builds, switches and removals go one at a time, so a plugin
  // isn't turned on while a write changes it.
  let changing = Promise.resolve();

  const oneAtATime = async <T>(change: () => T | Promise<T>): Promise<T> => {
    const next = changing.then(change);

    changing = next.then(
      () => undefined,
      () => undefined,
    );

    return next;
  };

  const turned = (found: PluginManifest, on: boolean): PluginInfo => {
    deps.switches.set(found.id, { personal: on });

    if (on) {
      switchedOn.add(found.id);
    } else {
      switchedOn.delete(found.id);
    }

    deps.log("plugin turned on or off", { plugin: found.id, on });

    return info(found);
  };

  // A plugin running until the restart keeps its state; the listing shows
  // what its folder holds now.
  const reread = async (name: string): Promise<PluginInfo> => {
    const read = await folder().reread(name);

    manifests = listed(name)
      ? manifests.map((each) => (each.id === name ? read.manifest : each))
      : [...manifests, read.manifest];

    installedIds.add(name);
    remember(name, read.digest);

    if (!running.includes(name)) {
      if (read.error === undefined) {
        failures.delete(name);
      } else {
        failures.set(name, read.error);
      }
    }

    return info(read.manifest);
  };

  const webParts = new Map(
    deps.installed?.plugins.flatMap(({ manifest: { id }, web }) =>
      web === undefined ? [] : [[id, web] as const],
    ),
  );

  const sessionBundles = new Map(
    deps.installed?.plugins.flatMap(({ manifest: { id }, session }) =>
      session === undefined ? [] : [[id, session] as const],
    ),
  );

  const switchedOn = new Set(
    deps.installed?.plugins.flatMap(({ manifest: { id }, on }) =>
      on ? [id] : [],
    ),
  );

  const profiles = new Map<string, PluginProfile>();

  const listed = (name: string): PluginManifest | undefined =>
    manifests.find(({ id }) => id === name);

  // The version running, whose settings and parts an update changes only
  // when the server restarts.
  const manifest = (name: string): PluginManifest | undefined =>
    listed(name) &&
    (deps.manifests.find(({ id }) => id === name) ?? listed(name));

  const taken = (name: string): boolean =>
    tools.has(name) || routeTools.has(name);

  for (const tool of kernelRouteTools()) {
    routeTools.set(tool.spec.name, tool);
  }

  // What the model and MCP clients see; internal tools are for plugins.
  const modelTools = (): RouteTool[] =>
    [...routeTools.values()].filter(({ internal }) => !internal);

  const loadsRouteTools = (session: Session): boolean =>
    routeToolProfiles.has(session.profileId);

  const personOf = (id: string): Person | undefined =>
    deps.auth.users().find((each) => each.id === id);

  const servedTool = (
    session: Session,
    name: string,
  ): ServedTool | undefined => {
    const found = tools.get(name);

    return found !== undefined &&
      loadsIn(session, found.plugin) &&
      found.applies(session)
      ? found
      : undefined;
  };

  const routedTool = (
    session: Session,
    name: string,
  ): RouteTool | undefined => {
    const found = loadsRouteTools(session)
      ? modelTools().find(
          ({ spec, plugin }) => spec.name === name && loadsIn(session, plugin),
        )
      : undefined;

    return found && onOwnersHalf(found, session);
  };

  // A plugin loads in team work only if it says it works there, and then
  // a built-in is on until admins turn it off and an installed one is off
  // until they turn it on (ADR 0067).
  const inTeamWork = (name: string): boolean => {
    return (
      running.includes(name) &&
      (deps.switches.get(name).team ?? !installedIds.has(name))
    );
  };

  const runners = runnersOf(deps.sessions, deps.environments, deps.runners);

  const templateConfigOf =
    (plugin: string, log: Log): PluginEnvironments["templateConfig"] =>
    (schema) => {
      const fitted = (value: unknown) =>
        value === undefined || value === null
          ? undefined
          : checked(
              Value.Default(schema, structuredClone(value)),
              schema,
              plugin,
            );

      return {
        get: (templateId) => {
          try {
            return fitted(deps.templates?.config(templateId, plugin));
          } catch (error) {
            log("template config doesn't fit", {
              templateId,
              error: error instanceof Error ? error.message : String(error),
            });

            return undefined;
          }
        },
        set: (templateId, value) => {
          if (deps.templates === undefined) {
            throw new Error("this server keeps no templates");
          }

          const kept = fitted(value);
          deps.templates.setConfig(templateId, plugin, kept);

          return kept;
        },
      };
    };

  // The kernel's own tools have no plugin.
  const loadsIn = (session: Session, plugin: string | undefined): boolean =>
    session.ownedBy !== "team" || plugin === undefined || inTeamWork(plugin);

  // The events enabled plugins say they publish (ADR 0059).
  const declaredEvents = (): DeclaredEvent[] =>
    deps.definitions
      .filter(({ id }) => enabled.includes(id) && !failures.has(id))
      .flatMap(({ id, events = {} }) =>
        Object.entries(events).map(
          ([event, { title, description, fields }]) => ({
            title,
            ...(description !== undefined && { description }),
            fields: { ...fields },
            type: `${id}.${event}` as const,
          }),
        ),
      );

  running.push(...enabled.filter((name) => !failures.has(name)));

  const extRoutes: ExtRoute[] = [];

  const schemaOf = (name: string): PluginDefinition["config"] =>
    deps.definitions.find(({ id }) => id === name)?.config;

  const configView = (name: string): PluginConfigView | undefined => {
    const schema = schemaOf(name);

    if (schema === undefined) {
      return undefined;
    }

    const config = deps.config(name);
    const locked = config.lockedIn();

    return {
      value: Value.Default(schema, structuredClone(config.get())),
      ...(locked !== undefined && { lockedIn: locked }),
    };
  };

  const load = (definition: PluginDefinition): void => {
    const { id } = definition;

    const log: Log = (message, fields) => {
      deps.log(message, { plugin: id, ...fields });
    };

    const failed = new AbortController();
    const touched = new Set<string>();
    const provided = new Set<string>();
    const unsubscribes: (() => void)[] = [];

    const declared = pluginRoutes(id, {
      inTeamWork: () => inTeamWork(id),
      publish: deps.changes,
    });

    const scheduled = schedules.part(id);

    const staged = {
      defined: [] as ToolDef[],
      fromRoutes: [] as {
        readonly method: ExtRoute["method"];
        readonly path: string;
        readonly spec: RouteToolSpec;
      }[],
      profiles: new Map<string, PluginProfile>(),
      routeToolProfiles: [] as string[],
      offers: [] as ModelOffer[],
      gitCredentials: [] as GitLoginsOf[],
      runners: [] as RunnerProvider[],
      signIn: undefined as SignInProvider | undefined,
    };

    try {
      if (kernelKeys.includes(id)) {
        throw new Error(
          `${id} is a key the kernel keeps in pipoca.json, so no plugin can have it`,
        );
      }

      for (const needed of definition.requires ?? []) {
        if (!settled.has(needed)) {
          throw new Error(
            `${id} needs ${needed}, which ${failures.has(needed) ? "failed" : "is off"}`,
          );
        }
      }

      const dataFailure = deps.dataFailure(id);

      if (dataFailure !== undefined) {
        throw new Error(dataFailure);
      }

      const part = deps.servers.find(({ plugin }) => plugin.id === id);
      const store = deps.store(id);
      const signal = AbortSignal.any([deps.signal, failed.signal]);

      part?.register(
        recorded(touched, {
          id,
          people: {
            get: personOf,
            list: () => deps.auth.users(),
            byName: (name) =>
              deps.auth.users().find((each) => each.name === name),
          },
          sessions: sessionsFor(deps.sessions, id),
          routes: declared.routes,
          tools: {
            define: (tool) => {
              staged.defined.push(tool);
            },
            fromRoute: (method, path, spec) => {
              staged.fromRoutes.push({ method, path, spec });
            },
            call: async (name, input, { session: sessionId }) => {
              const session = deps.sessions.get(sessionId);
              const tool = routeTools.get(name);
              const found = tool && session && onOwnersHalf(tool, session);

              if (
                session === undefined ||
                found === undefined ||
                !loadsRouteTools(session)
              ) {
                return { text: `no tool named ${name}`, isError: true };
              }

              const onBehalf = ownerOf(session, deps.auth.users());

              return onBehalf === undefined
                ? nobodyToActAs
                : runRouteTool(
                    found,
                    input,
                    onBehalf,
                    deps.api,
                    () => undefined,
                  ).catch((error: unknown) => ({
                    text: messageOf(error),
                    isError: true,
                  }));
            },
          },
          schedule: scheduled.schedule,
          events: {
            ...pluginEvents(
              deps.events,
              definition,
              deps.definitions,
              (stop) => {
                unsubscribes.push(stop);
              },
              log,
            ),
            declared: declaredEvents,
          },
          config: pluginConfig(
            definition.config ?? Type.Object({}),
            deps.config(id),
            secretRefs(store, fromEnv),
            { timer: deps.timer, signal, log },
          ),
          store: storeOf(store),
          transcript,
          urls: pluginUrls(id, deps.url),
          provide: {
            runners: (provider) => {
              provided.add("runners");
              staged.runners.push(provider);

              return runners;
            },
            runtime: () => {
              provided.add("runtime");

              if (deps.runtime === undefined) {
                throw new Error("this server starts no runners itself");
              }

              return deps.runtime();
            },
            models: (offer) => {
              provided.add("models");
              staged.offers.push(offer);
            },
            gitCredentials: (of) => {
              provided.add("gitCredentials");
              staged.gitCredentials.push(of);
            },
            signIn: (provider) => {
              if (installedIds.has(id)) {
                throw new Error("an installed plugin can't sign people in");
              }

              const taker = signIn?.plugin ?? (staged.signIn && id);

              if (taker !== undefined) {
                throw new Error(`${taker} already signs people in`);
              }

              provided.add("signIn");
              staged.signIn = provider;

              return signInApi;
            },
            profile: (key, { name: _name, ...content }, o) => {
              provided.add("profiles");
              const profileId = `${id}.${key}`;

              staged.profiles.set(profileId, {
                plugin: id,
                profile: { id: profileId, ...content },
                ...(o?.team === true && { team: true }),
              });

              if (o?.routeTools === true) {
                staged.routeToolProfiles.push(profileId);
              }

              return profileId;
            },
          },
          secrets: secretsOf(store),
          environments: {
            list: () => deps.environments.list(),
            get: (environmentId) =>
              deps.environments
                .list()
                .find((each) => each.id === environmentId),
            templates: () => deps.environments.templates(),
            templateConfig: templateConfigOf(id, log),
          },
          profiles: {
            mcpServers: deps.mcpServers ?? (() => []),
            buildsOn: deps.buildsOn ?? (() => []),
          },
          clock: deps.clock,
          env: (name) => (deps.env ?? process.env)[name],
          timer: deps.timer,
          log,
          signal,
        }),
      );

      const served = [
        ...staged.defined.map((tool) =>
          definedTool(id, tool, { person: personOf, log }),
        ),
      ];

      const routed = [
        ...declared.declared.flatMap((route) =>
          routeToolsOf(id, routeOf(route), route.spec.tool),
        ),
        ...staged.fromRoutes.flatMap(({ method, path, spec }) => {
          const route = declared.declared.find(
            (each) => each.method === method && each.path === trimmed(path),
          );

          if (route === undefined) {
            throw new Error(
              `tool ${spec.name} names no route ${method} ${path}`,
            );
          }

          return routeToolsOf(id, routeOf(route), spec);
        }),
      ];

      const names = new Set<string>();

      for (const { spec } of [...served, ...routed]) {
        if (taken(spec.name) || names.has(spec.name)) {
          throw new Error(`tool ${spec.name} is already registered`);
        }

        names.add(spec.name);
      }

      for (const tool of served) {
        tools.set(tool.spec.name, tool);
      }

      for (const tool of routed) {
        routeTools.set(tool.spec.name, tool);
      }
    } catch (error) {
      for (const unsubscribe of unsubscribes) {
        unsubscribe();
      }

      failed.abort();

      const message = messageOf(error);
      failures.set(id, message);
      running.splice(running.indexOf(id), 1);
      log("plugin failed to register", { error: message });

      return;
    }

    // The server stopped while the plugin registered, its database with it.
    if (deps.signal.aborted) {
      return;
    }

    for (const [profileId, profile] of staged.profiles) {
      profiles.set(profileId, profile);
    }

    for (const profileId of staged.routeToolProfiles) {
      routeToolProfiles.add(profileId);
    }

    offers.push(...staged.offers.map((offer) => ({ plugin: id, offer })));
    starters.push(...staged.runners.map((each) => ({ ...each, plugin: id })));

    gitLogins.push(...staged.gitCredentials.map((of) => ({ plugin: id, of })));

    if (staged.signIn !== undefined) {
      signIn = { plugin: id, provider: staged.signIn };
    }

    scheduled.commit();
    schedules.wake();
    extRoutes.push(...declared.declared);
    settled.add(id);
    used.set(id, { uses: [...touched], provides: [...provided] });
    deps.log("plugin registered", { plugin: id });
  };

  // In order, so a plugin loads after the ones it requires, and before the
  // server listens.
  for (const definition of inOrder(
    deps.definitions.filter(({ id }) => enabled.includes(id)),
  )) {
    if (deps.signal.aborted) {
      break;
    }

    load(definition);
  }

  const info = (found: PluginManifest): PluginInfo => {
    const error = failures.get(found.id);
    const installed = installedIds.has(found.id);
    const source = sources.get(found.id);
    const reached = used.get(found.id);

    // What is in its folder now, which may wait for a restart to run.
    const base = {
      ...(listed(found.id) ?? found),
      ...reached,
      source: installed ? "installed" : "built-in",
      turnedOn: installed
        ? switchedOn.has(found.id)
        : enabled.includes(found.id),
      digest: new Bun.CryptoHasher("sha256")
        .update(JSON.stringify(listed(found.id) ?? found))
        .update(fileDigests.get(found.id) ?? "")
        .digest("hex"),
      ...(source !== undefined && { installedFrom: source }),
      ...(updated.has(found.id) && { updated: true }),
      ...(newer.has(found.id) && { updateAvailable: true }),
      teamWork: inTeamWork(found.id),
    } as const;

    if (error !== undefined) {
      return {
        ...base,
        state: "failed",
        error,
        ...(deps.dataFailure(found.id) !== undefined && { resettable: true }),
      };
    }

    const web = webParts.get(found.id);

    return running.includes(found.id)
      ? {
          ...base,
          state: "on",
          ...(web !== undefined && {
            webPart: `/api/plugins/${found.id}/parts/${basename(web)}`,
          }),
        }
      : { ...base, state: "off" };
  };

  return {
    names: running,
    extRoutes: () => extRoutes,
    list: () => manifests.map(info),
    checkUpdates: async () => {
      const latest = deps.installed?.latest;

      if (latest === undefined) {
        return;
      }

      for (const [id, { url, pinned }] of sources) {
        try {
          const found = await latest(url);

          if (found !== undefined && found !== pinned) {
            newer.add(id);
          } else {
            newer.delete(id);
          }
        } catch (error) {
          deps.log("plugin update check failed", {
            plugin: id,
            url,
            error: messageOf(error),
          });
        }
      }

      deps.log("plugin updates checked", {
        checked: sources.size,
        newer: [...newer],
      });
    },
    publish: deps.events.publish,
    resetData: (name) => {
      const found = manifest(name);

      if (found === undefined) {
        return undefined;
      }

      if (
        !enabled.includes(name) ||
        !failures.has(name) ||
        deps.dataFailure(name) === undefined
      ) {
        return "only the data of a plugin whose tables can't be used is reset";
      }

      const refused =
        deps.resetData(name) ??
        "its data was reset; it starts when the server restarts";

      failures.set(name, refused);
      deps.log("plugin data reset", { plugin: name, refused });

      return info(found);
    },
    turnOn: async (name, on, digest) =>
      oneAtATime(() => {
        const found = manifest(name);
        if (found === undefined) {
          return undefined;
        }

        if (deps.installed === undefined || !installedIds.has(name)) {
          return "only an installed plugin can be turned on or off here";
        }

        const error = failures.get(name);
        if (on && error !== undefined && !switchedOn.has(name)) {
          return `fix its manifest first: ${error}`;
        }

        if (on && digest !== undefined && digest !== info(found).digest) {
          return "it changed since the page showed it; look at it again before turning it on";
        }

        return turned(found, on);
      }),
    install: async (url) => {
      if (deps.installed === undefined) {
        return "this server has no plugins folder";
      }

      try {
        const {
          manifest: found,
          source,
          digest,
        } = await deps.installed.install(
          url,
          (id) => manifest(id) !== undefined,
        );

        // A switch left from a plugin of this id removed by hand.
        deps.switches.set(found.id, undefined);

        manifests = [...manifests, found];
        installedIds.add(found.id);
        remember(found.id, digest);

        if (source !== undefined) {
          sources.set(found.id, source);
        }

        deps.log("plugin installed", { plugin: found.id, ...source });

        return info(found);
      } catch (error) {
        return messageOf(error);
      }
    },
    update: async (name) => {
      const found = manifest(name);
      if (found === undefined) {
        return undefined;
      }

      if (deps.installed === undefined || !installedIds.has(name)) {
        return "only an installed plugin can update";
      }

      try {
        const fetched = await deps.installed.update(name);

        if (fetched === undefined) {
          return info(found);
        }

        manifests = manifests.map((each) =>
          each.id === name ? fetched.manifest : each,
        );

        if (fetched.source !== undefined) {
          sources.set(name, fetched.source);
        }

        remember(name, fetched.digest);

        updated.add(name);
        newer.delete(name);

        // Why the version before failed doesn't hold for this one.
        failures.delete(name);

        // A version that asks for more than the one turned on is turned off.
        if (!fetched.on && deps.switches.get(name).personal === true) {
          deps.switches.set(name, { personal: false });
          switchedOn.delete(name);
        }

        deps.log("plugin updated", {
          plugin: name,
          ...fetched.source,
          on: fetched.on,
        });

        return info(fetched.manifest);
      } catch (error) {
        return messageOf(error);
      }
    },
    remove: async (name) =>
      oneAtATime(async () => {
        if (manifest(name) === undefined) {
          return false;
        }

        if (deps.installed === undefined || !installedIds.has(name)) {
          return "only an installed plugin can be removed";
        }

        if (running.includes(name)) {
          return "it is running, so turn it off and restart the server first";
        }

        try {
          deps.switches.set(name, undefined);
          await deps.installed.remove(name);
        } catch (error) {
          return messageOf(error);
        }

        manifests = manifests.filter(({ id }) => id !== name);
        installedIds.delete(name);
        switchedOn.delete(name);
        failures.delete(name);
        sources.delete(name);
        updated.delete(name);
        fileDigests.delete(name);

        deps.log("plugin removed", { plugin: name });

        return true;
      }),
    files: {
      list: async (name) => folder().files(name),
      read: async (name, path) => folder().read(name, path),
      write: async (name, path, content) =>
        oneAtATime(async () => {
          const folderOf = changeable(name);

          // A switch left from a plugin of this id removed by hand would
          // turn the new one on at the next start.
          if (!installedIds.has(name)) {
            deps.switches.set(name, undefined);
          }

          await folderOf.write(name, path, content);
          deps.log("plugin file written", { plugin: name, path });

          return reread(name);
        }),
      build: async (name) =>
        oneAtATime(async () => {
          // The running version's bundles are served from its folder.
          if (running.includes(name)) {
            throw new Error(
              `${name} is running; it builds when the server restarts`,
            );
          }

          await changeable(name).build(name);
          deps.log("plugin built", { plugin: name });

          return reread(name);
        }),
    },
    webPart: (name, file) => {
      const web = webParts.get(name);

      return running.includes(name) &&
        web !== undefined &&
        basename(web) === file
        ? web
        : undefined;
    },
    sessionPart: (name, hash) => {
      const bundle = sessionBundles.get(name);

      return running.includes(name) && bundle?.hash === hash
        ? bundle.path
        : undefined;
    },
    config: (name) => configView(name),
    setConfig: (name, value) => {
      const schema = schemaOf(name);

      if (schema === undefined) {
        return undefined;
      }

      const config = deps.config(name);
      const locked = config.lockedIn();

      if (locked !== undefined) {
        return `${locked} sets ${name}'s config, so it can't change here`;
      }

      const refs = secretRefs(deps.store(name), fromEnv);
      const sealed = sealedConfig(schema, value, refs.seal);

      try {
        configOf(schema, sealed, refs, (_message, fields) => {
          throw new Error(
            `${String(fields?.["path"])} ${String(fields?.["item"])}: ${String(fields?.["error"])}`,
          );
        });
      } catch (error) {
        return messageOf(error);
      }

      config.set(sealed);
      deps.log("plugin config saved", { plugin: name });

      return configView(name);
    },
    sessionPlugins: () => {
      return {
        plugins: running,
        pluginConfig: Object.fromEntries(
          running.flatMap((name) => {
            const schema = schemaOf(name);

            if (schema === undefined) {
              return [];
            }

            try {
              return [
                [
                  name,
                  sessionConfig(schema, deps.config(name).get(), deps.log),
                ],
              ];
            } catch (error) {
              deps.log("plugin config unreadable", {
                plugin: name,
                error: messageOf(error),
              });

              return [];
            }
          }),
        ),
        teamWork: running.filter(inTeamWork),
        installedParts: Object.fromEntries(
          [...sessionBundles]
            .filter(([name]) => running.includes(name))
            .map(([name, { hash }]) => [name, hash]),
        ),
      };
    },
    setTeamWork: (name, on) => {
      const found = manifest(name);

      if (found === undefined) {
        return undefined;
      }

      deps.switches.set(name, { team: on });
      deps.log("plugin team work set", { plugin: name, on });

      return info(listed(name) ?? found);
    },
    profile: (id) => profiles.get(id),
    profileIds: () => [...profiles.keys()],
    tools: (session) => [
      ...[...tools.values()]
        .filter(({ spec }) => servedTool(session, spec.name) !== undefined)
        .map(({ spec, question }) => ({
          ...spec,
          ...(question && { asks: true }),
        })),
      ...(loadsRouteTools(session)
        ? modelTools()
            .filter(({ plugin }) => loadsIn(session, plugin))
            .map(({ spec, asks }) => ({
              ...spec,
              ...(asks && { asks: true }),
            }))
        : []),
    ],
    question: async (session, name, input) => {
      const routed = routedTool(session, name);

      if (routed !== undefined) {
        const onBehalf = ownerOf(session, deps.auth.users());

        return onBehalf && routeToolQuestion(routed, input, onBehalf, deps.api);
      }

      return servedTool(session, name)?.question?.(input, session);
    },
    call: (session, call) => {
      const actor: Actor = `session:${session.id}`;

      deps.events.publish({
        type: "ToolCalled",
        session,
        tool: call.name,
        actor,
      });

      const routed = routedTool(session, call.name);
      const found = servedTool(session, call.name);

      const result = async (): Promise<ToolResult> => {
        if (routed !== undefined) {
          const onBehalf = ownerOf(session, deps.auth.users());

          if (onBehalf === undefined) {
            return nobodyToActAs;
          }

          return runRouteTool(
            routed,
            call.input,
            onBehalf,
            deps.api,
            (action) => {
              deps.sessions.publish(session.id, {
                generation: call.generation,
                events: [{ type: "ui_action", action }],
              });
            },
          );
        }

        return found === undefined
          ? { text: `no tool named ${call.name}`, isError: true }
          : found.run(call.input, session);
      };

      const plugin = routed === undefined ? found?.plugin : routed.plugin;

      void result()
        .catch((error: unknown) => ({ text: String(error), isError: true }))
        .then((reply) => {
          const queued = deps.sessions.enqueue(session.id, {
            kind: "tool_result",
            generation: call.generation,
            call: call.id,
            result: reply,
            ...(plugin !== undefined && { plugin }),
            actor: `plugin:${plugin ?? "kernel"}`,
          });

          if (!queued.ok) {
            deps.log("tool result dropped", {
              sessionId: session.id,
              generation: call.generation,
              tool: call.name,
              callId: call.id,
              reason: queued.reason,
            });
          }
        });
    },
    routeTools: () => modelTools().map(({ spec }) => spec),
    callRouteTool: async (name, input, actor) => {
      const found = modelTools().find(({ spec }) => spec.name === name);

      return found === undefined
        ? { text: `no tool named ${name}`, isError: true }
        : runRouteTool(
            found,
            input,
            { actor, mayAdmin: true, team: false },
            deps.api,
            () => undefined,
          ).catch((error: unknown) => ({ text: String(error), isError: true }));
    },
    offeredModels: (environment, userId) => {
      const offered = offers.map(({ plugin, offer }) =>
        guarded(plugin, "offeredModels", { models: [] }, () =>
          offer(environment, userId),
        ),
      );

      const fallback = offered.find((each) => each.default)?.default;

      const hidden = [...new Set(offered.flatMap((each) => each.hidden ?? []))];

      return {
        models: offered.flatMap((each) => each.models),
        ...(fallback && { default: fallback }),
        ...(hidden.length > 0 && { hidden }),
      };
    },
    startsRunners: (environment) => {
      const found = starters.find(({ plugin, starts }) =>
        guarded(plugin, "startsRunners", false, () => starts(environment)),
      );

      return found && { plugin: found.plugin, ...found.kind };
    },
    replacesServerRunner: () =>
      starters.some(
        ({ replacesServerRunner }) => replacesServerRunner === true,
      ),
    // A Session acting as someone gets only the logins of the plugin it
    // names, so no other plugin's account signs in beside a bot's.
    gitLogins: (owner, session) =>
      gitLogins
        .filter(
          ({ plugin }) =>
            session.actsAs === null || session.actsAs.plugin === plugin,
        )
        .flatMap(({ plugin, of }) =>
          guarded(plugin, "gitCredentials", [], () => of(owner, session)),
        ),
    logins: () => {
      if (signIn === undefined) {
        return [];
      }

      const { plugin, provider } = signIn;

      return guarded(plugin, "signIn", [], () => provider.logins()).map(
        ({ label, path }) => ({
          label,
          path: `/api/ext/${plugin}/${path}`,
        }),
      );
    },
  };
}

interface InstalledPlugins {
  readonly plugins: readonly {
    readonly manifest: PluginManifest;
    readonly on: boolean;
    readonly web?: string;
    readonly session?: { readonly path: string; readonly hash: string };
    readonly error?: string;
    readonly source?: { readonly url: string; readonly pinned: string };
    readonly digest?: string;
  }[];
  readonly install: (
    url: string,
    taken: (id: string) => boolean,
  ) => Promise<InstalledPlugins["plugins"][number]>;
  readonly update: (
    id: string,
  ) => Promise<InstalledPlugins["plugins"][number] | undefined>;
  // The version a plugin's URL points at now, when it can tell.
  readonly latest: (url: string) => Promise<string | undefined>;
  readonly remove: (id: string) => Promise<void>;
  readonly reread: (id: string) => Promise<InstalledPlugins["plugins"][number]>;
  readonly files: (id: string) => Promise<readonly string[]>;
  readonly read: (id: string, path: string) => Promise<string>;
  readonly write: (id: string, path: string, content: string) => Promise<void>;
  readonly build: (id: string) => Promise<void>;
}

function routeOf(route: ExtRoute): Parameters<typeof routeToolsOf>[1] {
  return {
    method: route.method,
    path: route.path,
    query: route.spec.query,
    body: route.spec.body,
    teamTwin: route.teamTwin,
  };
}

function trimmed(path: string): string {
  return path
    .split("/")
    .filter((part) => part !== "")
    .join("/");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Notes the members of its context a server part reaches while it
// registers, which the Plugins page shows (ADR 0069).
function recorded<C extends object>(touched: Set<string>, context: C): C {
  const quiet = new Set(["id", "log", "signal", "clock"]);

  return Object.defineProperties(
    {},
    Object.fromEntries(
      Object.keys(context).map((key) => [
        key,
        {
          enumerable: true,
          get: () => {
            if (!quiet.has(key)) {
              touched.add(key);
            }

            return context[key as keyof C];
          },
        },
      ]),
    ),
  ) as C;
}

// A plugin loads after the ones it requires.
function inOrder(definitions: readonly PluginDefinition[]): PluginDefinition[] {
  const sorted: PluginDefinition[] = [];

  const visit = (
    definition: PluginDefinition,
    seen: readonly string[],
  ): void => {
    if (sorted.includes(definition) || seen.includes(definition.id)) {
      return;
    }

    for (const id of definition.requires ?? []) {
      const required = definitions.find((each) => each.id === id);

      if (required !== undefined) {
        visit(required, [...seen, definition.id]);
      }
    }

    sorted.push(definition);
  };

  for (const definition of definitions) {
    visit(definition, []);
  }

  return sorted;
}

// A meta-session's tools act as the person who started it, never as an admin
// (ADR 0035). An admin's Team assistant changes team setup too, so its
// tools follow the person's role (ADR 0067), and only while everyone who
// steers the Session is an admin.
// Undefined for a Session nobody started, such as a plugin's team work,
// which has no person to act as.
function ownerOf(
  session: Session,
  users: readonly Person[],
): OnBehalf | undefined {
  const person = session.startedBy;
  const { access } = session;

  const steers = (id: string): boolean =>
    id === person ||
    access.kind === "team" ||
    (access.kind === "named" && access.people.includes(id));

  return person === null
    ? undefined
    : {
        actor: `user:${person}`,
        mayAdmin:
          session.ownedBy === "team" &&
          users.some(({ id }) => id === person) &&
          users.every(({ id, admin }) => admin || !steers(id)),
        team: session.ownedBy === "team",
      };
}

// A team Session's call of a route with a team half goes to that half
// (ADR 0067).
function onOwnersHalf(found: RouteTool, session: Session): RouteTool {
  return found.teamTwin === true && session.ownedBy === "team"
    ? {
        ...found,
        request: (input) => {
          const sent = found.request(input);

          return { ...sent, path: `team/${sent.path}` };
        },
      }
    : found;
}

const nobodyToActAs: ToolResult = {
  text: "nobody started this Session, so it can't act as a person",
  isError: true,
};
