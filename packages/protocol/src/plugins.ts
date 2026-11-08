import { Type } from "typebox";
import { anyMap, strings, type Wire } from "./wire";

const described = {
  title: Type.String(),
  description: Type.Optional(Type.String()),
};

const eventSpec = Type.Object({
  ...described,
  // A JSON Schema of the event's fields.
  fields: anyMap,
});

// A plugin event an enabled plugin declares, by its full type.
export const declaredEvent = Type.Object({
  ...eventSpec.properties,
  type: Type.TemplateLiteral("${string}.${string}"),
});

export type DeclaredEvent = Wire<typeof declaredEvent>;

const pluginPart = Type.Enum(["server", "session", "web"]);

// A plugin as its definition, or before an installed one runs, its folder
// says (ADR 0069).
const pluginManifest = Type.Object({
  id: Type.String(),
  title: Type.String(),
  description: Type.String(),
  parts: Type.Optional(Type.Array(pluginPart)),
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
  // Why it can't be turned on or off here: a deploy file sets the switches,
  // or a plugin it requires isn't installed.
  switchLocked: Type.Optional(Type.String()),
  // The plugins it can't run without, and the ones it uses when they are on,
  // as seen while it runs (ADR 0077).
  requires: Type.Optional(strings),
  worksWith: Type.Optional(
    Type.Array(
      Type.Object({
        plugin: Type.String(),
        through: Type.Array(Type.Enum(["events", "technical users"])),
      }),
    ),
  ),
  error: Type.Optional(Type.String()),
  // It failed because its tables can't be used, which resetting its data
  // fixes (ADR 0068).
  resettable: Type.Optional(Type.Boolean()),
  // The members of its context its server part reached, such as routes,
  // and what it provides the kernel, such as runners (ADR 0069).
  uses: Type.Optional(strings),
  provides: Type.Optional(strings),
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

// The plugins that switch with one (ADR 0077): turning it off turns off
// those that require it, and turning it on turns on those it requires.
export function switchingWith(
  plugins: readonly {
    readonly id: string;
    readonly requires?: readonly string[];
  }[],
  id: string,
  on: boolean,
  isOn: (id: string) => boolean,
): string[] {
  const found: string[] = [];

  const next = (from: string): readonly string[] =>
    on
      ? (plugins.find((each) => each.id === from)?.requires ?? []).filter(
          (each) => !isOn(each),
        )
      : plugins
          .filter(
            (each) => isOn(each.id) && (each.requires ?? []).includes(from),
          )
          .map((each) => each.id);

  const visit = (from: string): void => {
    for (const each of next(from)) {
      if (each !== id && !found.includes(each)) {
        found.push(each);
        visit(each);
      }
    }
  };

  visit(id);

  return found;
}

export const pluginInstall = Type.Object({ url: Type.String() });

// A file that fixes the plugin's key, such as one Helm mounts, makes it
// read-only (ADR 0063).
export const pluginConfig = Type.Object({
  value: Type.Unknown(),
  lockedIn: Type.Optional(Type.String()),
});

export const pluginUpdate = Type.Object({
  // Only an installed plugin can be updated here.
  enabled: Type.Optional(Type.Boolean()),
  digest: Type.Optional(Type.String()),
  update: Type.Optional(Type.Boolean()),
  teamWork: Type.Optional(Type.Boolean()),
});

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

// A plugin's stored bytes, named by their SHA-256 (ADR 0078), and the routes
// its Session part and people's browsers upload them through when the plugin
// accepts uploads. A browser's upload is named by the browser and hashed on
// the server.
export const blobHash = /^[0-9a-f]{64}$/;

export const uploadId = /^[A-Za-z0-9_-]{1,64}$/;

export const blobRoutes = {
  missing: "_blobs/missing",
  upload: "_blobs/uploads/:id",
  finish: "_blobs/uploads/:id/finish",
  browserUpload: "_blobs/browser/:id",
  browserFinish: "_blobs/browser/:id/finish",
} as const;
