import type { Profile } from "./browser";
import type { PluginInfo, ToolNamespace } from "./plugins";
import type { Session } from "./session";

type Input = Readonly<Record<string, unknown>>;

const pluginInstructions = `An in-place plugin is a folder in the server's plugins folder, named by its id (lowercase letters, digits and dashes). Write its files in a folder of your workspace, then install it with install_plugin, which writes them and builds the plugin. You never turn a plugin on: tell the user to turn it on on the Plugins page and restart the server, since its code then runs in the server and on runners. A plugin that is turned on can't be changed until the user turns it off. After installing, tell the user in a sentence what you wrote, whether it builds, and that they turn it on on the Plugins page; if a tool refuses, say why.

Its package.json has "type": "module", a "description", any npm "dependencies" its parts import, and "pipoca": { "id": <the folder's name>, "entry": "plugin.ts" }.

plugin.ts exports definePlugin({ id, title, description, config?, schema?, events?, requires? }) from @pipoca/plugins, and nothing that runs. config is built with Config.object, Config.string, Config.number and Secret, and admins edit it on the Plugins page. schema is its SQLite tables, named <id>_<table>, STRICT, with times as integer milliseconds. requires lists the plugins it needs, which start first. It imports only @pipoca/plugins, @pipoca/plugins/web, @pipoca/protocol and @pipoca/ui, which come from the running server, and reads the time through ctx.clock and waits through ctx.timer, never Date.now or setTimeout.

Each part is a file by convention, with a named export:
- src/server.ts exports server = defineServer(plugin, (ctx) => { ... }), registered synchronously. ctx.routes.get/post/put/patch/delete(path, { auth: "person" | "admin" | "public", body?: a TypeBox schema built with Type, changes?: [names], tool? }, ({ caller, params, body, query }) => value) answers /api/ext/<id>/<path>; a value is sent as JSON, a Response as it is, and HttpError, BadRequest and NotFound answer with their status. tool: { name, description } also makes the route a tool. ctx.tools.define({ name, description, params, run }) adds a tool to Sessions. ctx.store is its database (all, run, transaction). ctx.config.get() reads its config. ctx.sessions starts and messages Sessions, ctx.events.on/emit hears and sends events, ctx.schedule runs work later, ctx.provide.* gives the kernel models, runners or profiles, and ctx.log logs.
- src/session.ts exports session = defineSession(plugin, (s) => { ... }), which runs in each Session: s.tools.define, s.extension(pi => ...) for Pi's extension API, s.api.get/post(path, body?) to call its own routes, s.publish(key, data) to share a value with the Session's watchers, and s.config. It can't import files other than code.
- web/index.tsx exports web = defineWeb(plugin, { pages?: [{ path, label, Page, nav? }], settings?: { group, form: "auto" }, setup?, panels?, slots? }). useApi(plugin) is a client of its routes, and of the server's API for a path that starts with /; useLoaded(load, key, { changes }) loads data again when one of its routes' changes happens. It imports react and @pipoca/ui from the page, can't import CSS, and styles itself with @pipoca/ui components.`;

export const sessionTools: ToolNamespace = {
  name: "sessions",
  description: "List, start, open and archive Pipoca Sessions.",
};

export const environmentTools: ToolNamespace = {
  name: "environments",
  description:
    "List, create and change Environments, where Sessions run (ADR 0032).",
  instructions:
    "Secret values can't be set here, since tool calls are kept in the transcript: ask the user to add secrets on the Environments page.",
};

export const profileTools: ToolNamespace = {
  name: "profiles",
  description:
    "List, create and change Profiles: the Pi packages, instructions and settings a Session starts with (ADR 0031).",
};

export const pluginTools: ToolNamespace = {
  name: "plugins",
  description:
    "List plugins and read their files. In-place plugins are installed with install_plugin (ADR 0052).",
  instructions: pluginInstructions,
};

export function at(path: string, input: Input): string {
  return path.replace(/:(\w+)/g, (_match, name: string) =>
    encodeURIComponent(textIn(input, name)),
  );
}

export function sessionSummary(session: Session): Record<string, unknown> {
  return {
    id: session.id,
    title: session.title,
    status: session.status,
    waiting: session.waiting,
    environmentId: session.environmentId,
    profileId: session.profileId,
    workspace: session.workspace.kind,
    model: session.model,
    createdAt: session.createdAt,
  };
}

export function titleOf({ title }: Session): string {
  return title === null || title === "" ? "the Session" : `“${title}”`;
}

// A new Environment without its runner key, which a transcript keeps.
export function withoutKey(body: unknown): unknown {
  if (!isObject(body)) {
    return body;
  }

  const { key: _key, ...environment } = body;

  return environment;
}

// MCP server entries usually hold tokens in their env and headers, so the
// model sees only their names.
export function profileView(profile: Profile): Record<string, unknown> {
  const { mcpServers, ...rest } = profile;

  return { ...rest, mcpServers: Object.keys(mcpServers) };
}

export function pluginSummary(plugin: PluginInfo): Record<string, unknown> {
  return {
    id: plugin.id,
    title: plugin.title,
    source: plugin.source,
    state: plugin.state,
    turnedOn: plugin.turnedOn,
    ...(plugin.error !== undefined && { error: plugin.error }),
    ...(plugin.installedFrom !== undefined && {
      installedFrom: plugin.installedFrom.url,
    }),
  };
}

// The thing a call changes by its name, found by id in a list or as the
// reply itself: the Environment “Dev”.
export function named(
  found: unknown,
  input: Input,
  kind: string,
  unnamed: string,
): string {
  const one = Array.isArray(found)
    ? (found as unknown[]).find(
        (each) => isObject(each) && each["id"] === input["id"],
      )
    : found;

  const name = isObject(one) ? one["name"] : undefined;

  return typeof name === "string" && name !== ""
    ? `${kind} “${name}”`
    : unnamed;
}

function textIn(input: Input, key: string): string {
  const value = input[key];

  return typeof value === "string" ? value : "";
}

function isObject(value: unknown): value is Input {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
