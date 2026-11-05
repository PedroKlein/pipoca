import {
  type SessionPart,
  type SessionPlugin,
  settingValues,
} from "@pipoca/plugins";
import type { Assignment, PluginSettings } from "@pipoca/protocol";
import { builtInSessions } from "./built-in";
import { provideSdk } from "./bundle";

type Loaded = SessionPlugin | SessionPart;

// The Session parts an assignment names, each with its settings or config.
// A server from before settings sends none, so they take their defaults. An
// installed plugin's part comes from installed, by its bundle's hash.
export async function sessionParts(
  assignment: Pick<
    Assignment,
    | "plugins"
    | "pluginSettings"
    | "pluginConfig"
    | "requiredPlugins"
    | "installedParts"
  >,
  installed: (name: string, hash: string) => Promise<Loaded>,
): Promise<{
  readonly plugins: readonly SessionPlugin[];
  readonly pluginSettings: Readonly<Record<string, PluginSettings>>;
  readonly parts: readonly SessionPart[];
  readonly pluginConfig: Readonly<Record<string, unknown>>;
}> {
  const bundles = Object.entries(assignment.installedParts ?? {}).filter(
    ([name]) => assignment.plugins.includes(name),
  );

  const unknown = (assignment.requiredPlugins ?? []).filter(
    (name) =>
      !builtInSessions.some(({ id }) => id === name) &&
      !bundles.some(([part]) => part === name),
  );

  if (unknown.length > 0) {
    throw new Error(
      `this runner has no ${unknown.join(", ")} plugin, so it needs an update`,
    );
  }

  const builtIn = builtInSessions.filter(({ id }) =>
    assignment.plugins.includes(id),
  );

  const fetched = await Promise.all(
    bundles.map(async ([name, hash]) => installed(name, hash)),
  );

  const fetchedPlugins = fetched.filter(
    (part): part is SessionPlugin => !isPart(part),
  );

  const defined = builtIn.flatMap(({ part }) =>
    part === undefined ? [] : [part],
  );

  return {
    plugins: [
      ...builtIn.flatMap(({ plugin }) =>
        plugin === undefined ? [] : [plugin],
      ),
      ...fetchedPlugins,
    ],
    parts: [...defined, ...fetched.filter(isPart)],
    pluginSettings: Object.fromEntries<PluginSettings>([
      ...builtIn.flatMap(({ id, plugin, manifest }) =>
        plugin === undefined
          ? []
          : [
              [
                id,
                settingValues(
                  manifest?.settings,
                  assignment.pluginSettings?.[id],
                ),
              ] as const,
            ],
      ),
      ...fetchedPlugins.map(({ name }): [string, PluginSettings] => [
        name,
        assignment.pluginSettings?.[name] ?? {},
      ]),
    ]),
    pluginConfig: assignment.pluginConfig ?? {},
  };
}

// Loads an installed plugin's Session part from the file the runner fetched
// its bundle into.
export async function installedPart(
  name: string,
  path: string,
): Promise<Loaded> {
  provideSdk();

  const { default: plugin, session } = (await import(path)) as {
    readonly default?: SessionPlugin;
    readonly session?: SessionPart;
  };

  const part: Loaded | undefined = session ?? plugin;

  if (
    part !== undefined &&
    (isPart(part) ? part.plugin.id : part.name) === name
  ) {
    return part;
  }

  throw new Error(
    `the ${name} plugin's Session part must export a Session part for ${name} as session`,
  );
}

function isPart(part: Loaded): part is SessionPart {
  return "setup" in part;
}
