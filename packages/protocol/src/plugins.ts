import { Type } from "typebox";
import { anyMap, strings, type Wire } from "./wire";

const settingValue = Type.Union([
  Type.String(),
  Type.Number(),
  Type.Boolean(),
  strings,
]);

export type SettingValue = Wire<typeof settingValue>;

export const pluginSettings = Type.Record(Type.String(), settingValue);

export type PluginSettings = Wire<typeof pluginSettings>;

const described = {
  title: Type.String(),
  description: Type.Optional(Type.String()),
};

// A setting a plugin declares in its manifest (ADR 0036).
export const settingSpec = Type.Union([
  Type.Object({
    ...described,
    type: Type.Literal("string"),
    default: Type.String(),
  }),
  Type.Object({
    ...described,
    type: Type.Literal("number"),
    default: Type.Number(),
    min: Type.Optional(Type.Number()),
    max: Type.Optional(Type.Number()),
  }),
  Type.Object({
    ...described,
    type: Type.Literal("boolean"),
    default: Type.Boolean(),
  }),
  Type.Object({
    ...described,
    type: Type.Literal("choice"),
    options: strings,
    default: Type.String(),
  }),
  Type.Object({
    ...described,
    type: Type.Literal("strings"),
    default: strings,
  }),
]);

export type SettingSpec = Wire<typeof settingSpec>;

// What a plugin's server part may reach on its context besides its own
// store, settings, signal and log, built-in or installed alike (ADR 0022).
export const capabilities = [
  "tools",
  "toolsets",
  "events",
  "sessions",
  "environments",
  "profiles",
  "routes",
  "models",
  "people",
  "transcript",
] as const;

export type Capability = (typeof capabilities)[number];

// The plugin interface an installed plugin is written for. It changes only
// when something a plugin can reach goes away or changes meaning (ADR 0036).
export const pluginEngine = 1;

const eventSpec = Type.Object({
  ...described,
  // A JSON Schema of the event's fields.
  fields: anyMap,
});

export type EventSpec = Wire<typeof eventSpec>;

// A plugin event an enabled plugin declares, by its full type.
export const declaredEvent = Type.Object({
  ...eventSpec.properties,
  type: Type.TemplateLiteral("${string}.${string}"),
});

export type DeclaredEvent = Wire<typeof declaredEvent>;

export const pluginWork = Type.Enum(["personal", "team"]);

export type PluginWork = Wire<typeof pluginWork>;

// The pipoca field of a plugin's package.json (ADR 0022, ADR 0036).
export const pluginManifest = Type.Object({
  id: Type.String(),
  title: Type.String(),
  description: Type.String(),
  settings: Type.Optional(Type.Record(Type.String(), settingSpec)),
  version: Type.Optional(Type.String()),
  engine: Type.Optional(Type.Number()),
  // Paths inside the plugin's folder.
  parts: Type.Optional(
    Type.Object({
      server: Type.Optional(Type.String()),
      web: Type.Optional(Type.String()),
      session: Type.Optional(Type.String()),
    }),
  ),
  capabilities: Type.Optional(Type.Array(Type.Enum(capabilities))),
  // An installed plugin's Session part loads only in the Sessions its server
  // part owns. A built-in says so on its Session part instead.
  ownSessionsOnly: Type.Optional(Type.Boolean()),
  // The events the plugin publishes, by name without the plugin's prefix,
  // such as routines' triggers offer (ADR 0059).
  events: Type.Optional(
    Type.Record(Type.String({ pattern: "^[a-z][a-z0-9_]*$" }), eventSpec),
  ),
  // Where it works. Without "team" its parts never load in team work
  // (ADR 0067).
  works: Type.Optional(Type.Array(pluginWork)),
});

export type PluginManifest = Wire<typeof pluginManifest>;

// A plugin as the Plugins page shows it. A failed plugin's server part threw
// while it loaded or registered, so the plugin is off until the server
// restarts. turnedOn is whether it will be on after the next restart.
export const pluginInfo = Type.Object({
  ...pluginManifest.properties,
  source: Type.Enum(["built-in", "installed"]),
  state: Type.Enum(["on", "off", "failed"]),
  turnedOn: Type.Boolean(),
  error: Type.Optional(Type.String()),
  // It failed because its tables can't be used, which resetting its data
  // fixes (ADR 0068).
  resettable: Type.Optional(Type.Boolean()),
  values: pluginSettings,
  // Where the shell loads an installed plugin's web part from.
  webPart: Type.Optional(Type.String()),
  // The git repository or tarball it was installed from, and the commit or
  // SHA-256 of the version fetched.
  installedFrom: Type.Optional(
    Type.Object({ url: Type.String(), pinned: Type.String() }),
  ),
  // A newer version was fetched, which runs when the server restarts.
  updated: Type.Optional(Type.Boolean()),
  // Where it was installed from has a newer version than it has.
  updateAvailable: Type.Optional(Type.Boolean()),
  // Of the manifest shown, so turning the plugin on can say which one the
  // user trusted.
  digest: Type.String(),
  // Its parts load in team Sessions: it works in team work and admins
  // leave it on there (ADR 0067).
  teamWork: Type.Boolean(),
});

export type PluginInfo = Wire<typeof pluginInfo>;

export const pluginInstall = Type.Object({ url: Type.String() });

// A file that fixes the plugin's key, such as one Helm mounts, makes it
// read-only (ADR 0063).
export const pluginConfig = Type.Object({
  value: Type.Unknown(),
  lockedIn: Type.Optional(Type.String()),
});

// Settings are checked against the plugin's own declared settings.
export const pluginUpdate = Type.Object({
  settings: Type.Optional(Type.Unknown()),
  // Only an installed plugin can be turned on or off, or updated, here.
  enabled: Type.Optional(Type.Boolean()),
  digest: Type.Optional(Type.String()),
  update: Type.Optional(Type.Boolean()),
  teamWork: Type.Optional(Type.Boolean()),
});

export type PluginUpdate = Wire<typeof pluginUpdate>;

export const pluginFileWrite = Type.Object({
  path: Type.String({
    description: "Relative to the plugin's folder, such as server.ts",
  }),
  content: Type.String(),
});

export const pluginFileContent = Type.Pick(pluginFileWrite, ["content"]);

// How the model reaches a tool, as Pi's tool exposure has it: deferred and
// codemode tools are found through tool_search and codemode scripts.
const toolExposure = Type.Enum(["direct", "deferred", "codemode"]);

export type ToolExposure = Wire<typeof toolExposure>;

// A group of related tools, as Pi's tool namespaces have it.
const toolNamespace = Type.Object({
  name: Type.String(),
  description: Type.Optional(Type.String()),
  instructions: Type.Optional(Type.String()),
});

export type ToolNamespace = Wire<typeof toolNamespace>;

// Hints about what a tool does, with the meaning of MCP tool annotations.
// A missing hint takes the unsafe value.
const toolAnnotations = Type.Object({
  readOnlyHint: Type.Optional(Type.Boolean()),
  destructiveHint: Type.Optional(Type.Boolean()),
  idempotentHint: Type.Optional(Type.Boolean()),
  openWorldHint: Type.Optional(Type.Boolean()),
});

export type ToolAnnotations = Wire<typeof toolAnnotations>;

export const toolSpec = Type.Object({
  name: Type.String(),
  label: Type.Optional(Type.String()),
  description: Type.String(),
  parameters: anyMap,
  exposure: Type.Optional(toolExposure),
  namespace: Type.Optional(toolNamespace),
  annotations: Type.Optional(toolAnnotations),
  // The Session asks the server what to ask the person before each call.
  asks: Type.Optional(Type.Boolean()),
  prompt: Type.Optional(
    Type.Object({
      snippet: Type.String(),
      guidelines: Type.Optional(Type.Array(Type.String())),
    }),
  ),
  sequential: Type.Optional(Type.Boolean()),
});

export type ToolSpec = Wire<typeof toolSpec>;
