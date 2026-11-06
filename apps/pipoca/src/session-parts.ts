import type { SessionPart } from "@pipoca/plugins/host";
import type { Assignment } from "@pipoca/protocol";
import { builtInSessions } from "./built-in";
import { provideSdk } from "./bundle";

// The Session parts an assignment names, with their config. An installed
// plugin's part comes from installed, by its bundle's hash.
export async function sessionParts(
  assignment: Pick<
    Assignment,
    "plugins" | "pluginConfig" | "requiredPlugins" | "installedParts"
  >,
  installed: (name: string, hash: string) => Promise<SessionPart>,
): Promise<{
  readonly parts: readonly SessionPart[];
  readonly pluginConfig: Readonly<Record<string, unknown>>;
}> {
  const bundles = Object.entries(assignment.installedParts ?? {}).filter(
    ([name]) => assignment.plugins.includes(name),
  );

  const unknown = (assignment.requiredPlugins ?? []).filter(
    (name) =>
      !builtInSessions.some(({ plugin }) => plugin.id === name) &&
      !bundles.some(([part]) => part === name),
  );

  if (unknown.length > 0) {
    throw new Error(
      `this runner has no ${unknown.join(", ")} plugin, so it needs an update`,
    );
  }

  const fetched = await Promise.all(
    bundles.map(async ([name, hash]) => installed(name, hash)),
  );

  return {
    parts: [
      ...builtInSessions.filter(({ plugin }) =>
        assignment.plugins.includes(plugin.id),
      ),
      ...fetched,
    ],
    pluginConfig: assignment.pluginConfig ?? {},
  };
}

// Loads an installed plugin's Session part from the file the runner fetched
// its bundle into.
export async function installedPart(
  name: string,
  path: string,
): Promise<SessionPart> {
  provideSdk();

  const { session } = (await import(path)) as {
    readonly session?: SessionPart;
  };

  if (session?.plugin.id === name) {
    return session;
  }

  throw new Error(
    `the ${name} plugin's Session part must export a Session part for ${name} as session`,
  );
}
