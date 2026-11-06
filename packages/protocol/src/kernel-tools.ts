import type { Profile } from "./browser";
import type { PluginInfo, ToolNamespace } from "./plugins";
import type { Session } from "./session";

type Input = Readonly<Record<string, unknown>>;

const pluginInstructions = `An in-place plugin is a folder in the server's plugins folder, named by its id (lowercase letters, digits and dashes). Write its files in a folder of your workspace, then install it with install_plugin, which writes them and builds the plugin. You never turn a plugin on: tell the user to turn it on on the Plugins page and restart the server, since its code then runs in the server and on runners. A plugin that is turned on can't be changed until the user turns it off. After installing, tell the user in a sentence what you wrote, whether it builds, and that they turn it on on the Plugins page; if a tool refuses, say why.

Its package.json has "type": "module", any npm "dependencies" its parts import, and a "pipoca" field:
- id (the folder's name), title, description, engine: 1, and an optional version;
- capabilities: the parts of the server context its server part uses, some of tools, toolsets, events, sessions, environments, profiles, routes, models;
- parts: server, web and session, each a TypeScript or JavaScript file, all optional;
- ownSessionsOnly: true to load its Session part only in the Sessions its server part owns;
- works: ["personal", "team"] for a plugin that works in team work; without "team" its tools and Session and web parts never load in team Sessions, and admins turn it on there in Team setup;
- settings: optional, by name, each { type: "string" | "number" | "boolean" | "choice" | "strings", title, description?, default, options? for choice, min?/max? for number }.

Type each part with types from @pipoca/plugins (ServerPlugin, SessionPlugin) or @pipoca/plugins/web (WebPlugin) and check its default export with satisfies. The server and Session parts import @pipoca/plugins from the running server, so it needs no dependency: HttpError(status, message, code?), BadRequest and NotFound, thrown from a route, answer with that status and { error: code, message }, where code is a snake_case string that defaults to one for the status, such as bad_request or not_found; requireAdmin(caller, message) throws a 403 unless the caller is an admin; readBody(request, schema) reads a JSON body that fits a TypeBox schema built with Type, or throws a 422 that names the field (a 400 when the body isn't JSON).

The server part's default export is a ServerPlugin { name: <id>, register(context) }. Reaching a context member whose capability isn't declared fails the plugin when it registers.
- context.routes.handle((request, path, caller) => Response | Promise<Response>) answers /api/ext/<id>/<path>, so it needs no web framework such as Express. caller is { kind: "user", actor, admin } for a signed-in user, also through a toolset tool (admin is false from a meta-session), or { kind: "session", session, actor } when its Session part sent the request. A route acts as its caller: a Session it starts for a user takes actor: caller.actor. A route that changes config every user shares calls requireAdmin(caller, message) first. A route that returns records checks canSee(caller, owner) from @pipoca/plugins, where owner is "person:<user id>" or "team", and a Session's is session.ownedBy. The method says what a route does: GET reads, POST adds or changes, DELETE removes, so DELETE items/<id> rather than POST items/<id>/remove.
- context.store is its SQLite database: exec(sql), all(sql, ...params), run(sql, ...params), and seal(text, context)/open(sealed, context) for secrets. Name its tables <id>_<table>.
- context.settings.get() returns its settings, which sit in its key in the server's pipoca.json. context.config.get() and set(value) read and replace that key, keeping its settings when set keeps their fields, and context.config.dir is a folder of its own.
- context.changes.publish(name) tells open pages that something changed; they hear the topic "<id>.<name>".
- context.tools, toolsets, events, sessions, environments, profiles and models each need their capability: they register tools, meta toolsets and event listeners, start and message Sessions, give runners tokens, provide Profiles, and offer models.
- context.signal (aborted when the server stops) and context.log(message, fields?) need no capability.
The web part's default export is a WebPlugin { name: <id>, nav?: { label, Page, Items?, fills? }, Home?, sessionPath?, SessionPanel?, SessionHeader?, EnvironmentSection?, TemplateSection?, SettingsSection?, settingsGroup?: "you" | "workspace" | "server" | "integrations", settingsParts?: { General?, Accounts? }, tools?, widgets?, notices?, links?, repositories? }. Page gets { context, path }: context.request(path, init?) is fetch for its own routes, or for the server's API when path starts with /, and context.settings holds its settings. useLoaded(load, key, { topics, everyMs }) from @pipoca/plugins/web loads data and loads it again when a topic such as "<id>.<name>" changes. It imports react, react-dom, @pipoca/ui and @pipoca/plugins/web from the page, can't import CSS or other files, and styles itself with @pipoca/ui components.
The Session part's default export is a SessionPlugin { name: <id>, extension?: (cloud) => Pi extension factory, packages?: Pi packages, tools?: (cloud) => Pi tool definitions }. cloud.request(path, init?) calls its own routes as the Session, cloud.settings holds its settings when the Session started, cloud.publish(key, data) shares a value with everyone watching the Session, and cloud.log(message, fields?) logs. It can't import files other than code.`;

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
