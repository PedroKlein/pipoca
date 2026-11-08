import {
  packageIdentity,
  type PiPackage,
  type ProfileContent,
} from "@pipoca/protocol";
import type { Folder } from "./folder";

// One layer a Profile's page shows, from the Server base up to the one open
// (ADR 0074).
export interface StackLayer {
  // What a turned-off text names it by: :base, :defaults or a Profile id.
  readonly id: string;
  readonly name: string;
  readonly kind: "base" | "defaults" | "profile";
  readonly folder: Folder;
  readonly content: ProfileContent;
  readonly paths: readonly string[];
}

// An item the open layer gets from a layer below it.
export interface Inherited<T> {
  readonly key: string;
  readonly item: T;
  readonly from: StackLayer;
  // The open layer turned it off.
  readonly off: boolean;
}

// Items by key from the layers below, bottom up, the nearer one replacing
// the one below. What a layer between turned off is gone, as it is for Pi.
export function inherited<T>(
  below: readonly StackLayer[],
  own: StackLayer,
  itemsOf: (layer: StackLayer) => readonly (readonly [string, T])[],
): readonly Inherited<T>[] {
  const found = new Map<string, { item: T; from: StackLayer }>();

  for (const layer of below) {
    for (const key of [...found.keys()]) {
      if (turnsOff(layer, key)) {
        found.delete(key);
      }
    }

    for (const [key, item] of itemsOf(layer)) {
      found.set(key, { item, from: layer });
    }
  }

  return [...found].map(([key, { item, from }]) => ({
    key,
    item,
    from,
    off: turnsOff(own, key),
  }));
}

function turnsOff(layer: StackLayer, key: string): boolean {
  return layer.content.off.some(
    (entry) => entry === key || key.startsWith(`${entry}/`),
  );
}

export function sourceOf(pkg: PiPackage): string {
  return typeof pkg === "string" ? pkg : pkg.source;
}

export const offKeys = {
  agents: (layer: StackLayer) => `AGENTS.md:${layer.id}`,
  append: (layer: StackLayer) => `APPEND_SYSTEM.md:${layer.id}`,
  package: (source: string) => `package:${packageIdentity(source)}`,
  mcp: (name: string) => `mcp:${name}`,
} as const;

type Items<T> = readonly (readonly [string, T])[];

export const itemsOf = {
  agents: (layer: StackLayer): Items<string> =>
    layer.content.agentsMd.trim() === ""
      ? []
      : [[offKeys.agents(layer), layer.content.agentsMd] as const],
  append: (layer: StackLayer): Items<string> =>
    layer.content.appendSystemMd.trim() === ""
      ? []
      : [[offKeys.append(layer), layer.content.appendSystemMd] as const],
  packages: (layer: StackLayer): Items<PiPackage> =>
    layer.content.packages.map(
      (pkg) => [offKeys.package(sourceOf(pkg)), pkg] as const,
    ),
  mcp: (
    layer: StackLayer,
  ): Items<{ readonly name: string; readonly config: unknown }> =>
    Object.entries(layer.content.mcpServers).map(
      ([name, config]) => [offKeys.mcp(name), { name, config }] as const,
    ),
  prompts: (layer: StackLayer): Items<string> =>
    layer.paths.flatMap((path) => {
      const name = /^prompts\/([^/]+)\.md$/.exec(path)?.[1];

      return name === undefined ? [] : [[path, name] as const];
    }),
};

// The off list with one key turned on or off.
export function withOff(
  off: readonly string[],
  key: string,
  on: boolean,
): readonly string[] {
  const kept = off.filter((entry) => entry !== key);

  return on ? kept : [...kept, key];
}

// Copies a file or folder from a layer below into the open one, where it
// replaces the one below.
export async function copyInto(
  from: Folder,
  to: Folder,
  key: string,
): Promise<void> {
  const paths = (await from.list())
    .map(({ path }) => path)
    .filter((path) => path === key || path.startsWith(`${key}/`));

  for (const path of paths) {
    await to.write(path, await from.read(path));
  }
}
