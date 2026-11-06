import type { PluginDefinition } from "@pipoca/plugins";
import type { ServerPart, SessionPart } from "@pipoca/plugins/host";
import type { PluginManifest } from "@pipoca/protocol";
import { serverRegistry } from "./registry-server";
import { sessionRegistry } from "./registry-session";

const servers: readonly {
  readonly definition: PluginDefinition;
  readonly server?: ServerPart;
}[] = serverRegistry;

export function definedManifest(definition: PluginDefinition): PluginManifest {
  const { id, title, description, works } = definition;

  return {
    id,
    title,
    description,
    ...(works !== undefined && { works: [...works] }),
  };
}

// The plugins built into this binary (ADR 0015), in the order of their
// folders.
export const builtInPlugins: readonly PluginManifest[] = servers.map(
  ({ definition }) => definedManifest(definition),
);

export const builtInDefinitions: readonly PluginDefinition[] = servers.map(
  ({ definition }) => definition,
);

export const builtInParts: readonly ServerPart[] = servers.flatMap(
  ({ server }) => (server === undefined ? [] : [server]),
);

export const builtInSessions: readonly SessionPart[] = sessionRegistry.map(
  ({ session }) => session,
);
