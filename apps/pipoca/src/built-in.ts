import type {
  PluginDefinition,
  ServerPlugin,
  SessionPart,
  SessionPlugin,
} from "@pipoca/plugins";
import type { PluginManifest } from "@pipoca/protocol";
import { serverRegistry } from "./registry-server";
import { sessionRegistry } from "./registry-session";

type Module = Readonly<Record<string, unknown>>;

interface Entry {
  readonly id: string;
  readonly manifest?: unknown;
  readonly server?: Module;
  readonly session?: Module;
  readonly definition?: PluginDefinition;
}

const servers: readonly Entry[] = serverRegistry;
const sessions: readonly Entry[] = sessionRegistry;

// What a v1 server part that starts runners on this machine is made with.
export interface Runtime {
  readonly command: readonly string[];
  readonly server: () => string;
  readonly dataDir: string;
  readonly seed?: {
    readonly environmentId: string;
    readonly folders: readonly string[];
  };
}

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
  ({ manifest, definition }) =>
    definition === undefined
      ? (manifest as PluginManifest)
      : definedManifest(definition),
);

export const builtInDefinitions: readonly PluginDefinition[] = servers.flatMap(
  ({ definition }) => (definition === undefined ? [] : [definition]),
);

// A v1 server module exports its part, or a function of the runtime that
// makes it.
export function builtInServers(runtime: () => Runtime): ServerPlugin[] {
  return servers.flatMap(({ id, server }) => {
    if (server === undefined) {
      return [];
    }

    const values = Object.values(server);
    const part = values.find((value) => named(value, id));

    if (part !== undefined) {
      return [part as ServerPlugin];
    }

    const [make, ...others] = values.filter(
      (value) => typeof value === "function",
    );

    if (make === undefined || others.length > 0) {
      throw new Error(`the ${id} server module exports no server part`);
    }

    return [(make as (runtime: () => Runtime) => ServerPlugin)(runtime)];
  });
}

export const builtInSessions: readonly {
  readonly id: string;
  readonly manifest?: PluginManifest;
  readonly plugin?: SessionPlugin;
  readonly definition?: PluginDefinition;
}[] = sessions.map(({ id, manifest, session, definition }) => {
  if (definition !== undefined) {
    return { id, definition };
  }

  const plugin = Object.values(session ?? {}).find((value) => named(value, id));

  if (plugin === undefined) {
    throw new Error(`the ${id} session module exports no Session part`);
  }

  return {
    id,
    manifest: manifest as PluginManifest,
    plugin: plugin as SessionPlugin,
  };
});

export async function definedSession(
  definition: PluginDefinition,
): Promise<SessionPart> {
  const part = (await definition.session?.())?.default as
    SessionPart | undefined;

  if (part?.plugin !== definition) {
    throw new Error(
      `the Session part of ${definition.id} isn't one defineSession made for it`,
    );
  }

  return part;
}

function named(value: unknown, id: string): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { readonly name?: unknown }).name === id
  );
}
