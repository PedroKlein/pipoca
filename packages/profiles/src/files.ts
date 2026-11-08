import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  packageIdentity,
  type ProfileContent,
  type ProfileFiles,
  profilePath,
} from "@pipoca/protocol";

// Every runner that starts a Session with a Profile downloads its files, so
// a folder this big is refused (ADR 0041).
export const maxProfileBytes = 20 * 1024 * 1024;

export class ProfileTooBig extends Error {}

// A Profile folder's files as runners get them.
export function folderFiles(dir: string, name: string): ProfileFiles {
  const files = new Map<string, Buffer>();
  let bytes = 0;

  for (const { path, size } of folderEntries(dir)) {
    bytes += size;
    if (bytes > maxProfileBytes) {
      throw tooBig(name);
    }

    files.set(path, readFileSync(join(dir, path)));
  }

  return encoded(files);
}

// The paths and sizes of a Profile folder's files, leaving out what machines
// keep. Only regular files count, so a link can't hand runners a file from
// elsewhere on the server.
export function folderEntries(
  dir: string,
): readonly { readonly path: string; readonly size: number }[] {
  const found: { path: string; size: number }[] = [];

  const walk = (relative: string): void => {
    for (const entry of readdirSync(join(dir, relative))) {
      const path = relative === "" ? entry : `${relative}/${entry}`;
      if (!profilePath(path)) {
        continue;
      }

      const stats = lstatSync(join(dir, path));
      if (stats.isDirectory()) {
        walk(path);
      } else if (stats.isFile()) {
        found.push({ path, size: stats.size });
      }
    }
  };

  walk("");

  return found.sort((a, b) => (a.path < b.path ? -1 : 1));
}

export function tooBig(name: string): ProfileTooBig {
  return new ProfileTooBig(
    `Profile ${name} is over ${String(maxProfileBytes / 1024 / 1024)} MB`,
  );
}

// The files a Profile given as content stands for, such as a plugin's.
export function contentFiles(
  content: Omit<ProfileContent, "off">,
): ProfileFiles {
  const settings = {
    ...content.settings,
    ...(content.packages.length > 0 && { packages: content.packages }),
  };

  const texts: [string, string][] = [
    [
      "settings.json",
      Object.keys(settings).length === 0 ? "" : JSON.stringify(settings),
    ],
    ["AGENTS.md", content.agentsMd],
    ["SYSTEM.md", content.systemMd],
    ["APPEND_SYSTEM.md", content.appendSystemMd],
    [
      "mcp.json",
      Object.keys(content.mcpServers).length === 0
        ? ""
        : JSON.stringify({ mcpServers: content.mcpServers }),
    ],
  ];

  return encoded(
    new Map(
      texts
        .filter(([, text]) => text !== "")
        .map(([path, text]) => [path, Buffer.from(text)]),
    ),
  );
}

// A plugin's Profile over only the extensions and packages of the admin's
// base Profile, which add model providers. The base's skills, context, MCP
// servers and other settings stay out.
export function overBaseExtensions(
  base: ProfileFiles,
  own: ProfileFiles,
): ProfileFiles {
  const kept = new Map(
    [...decoded(base)].filter(([path]) => path.startsWith("extensions/")),
  );

  const settings = base.files["settings.json"];

  const packages =
    settings === undefined
      ? undefined
      : objectIn(Buffer.from(settings, "base64"))?.["packages"];

  if (Array.isArray(packages) && packages.length > 0) {
    kept.set("settings.json", Buffer.from(JSON.stringify({ packages })));
  }

  return layered(encoded(kept), own);
}

// A Profile's files over the admin's base Profile, layered as Pi layers its
// global and project config (ADR 0044).
export function layered(base: ProfileFiles, own: ProfileFiles): ProfileFiles {
  return stacked([
    { id: ":base", files: base, off: [] },
    { id: ":own", files: own, off: [] },
  ]);
}

// One layer of a Session's Pi agent folder: the base, My defaults or a
// Profile, and what it turned off below it (ADR 0074).
export interface Layer {
  readonly id: string;
  readonly files: ProfileFiles;
  readonly off: readonly string[];
}

// Text files every layer adds to, the lowest first.
const joined = ["AGENTS.md", "APPEND_SYSTEM.md"] as const;

// Pi's resource lists, which add up across layers as Pi adds up its global
// and project ones.
const resources = ["extensions", "skills", "prompts", "themes"] as const;

// Layers from the bottom up, each over the ones below it with what it turned
// off left out (ADR 0074).
export function stacked(layers: readonly Layer[]): ProfileFiles {
  const files = new Map<string, Buffer>();

  const parts = new Map<string, { layer: string; text: string }[]>(
    joined.map((path) => [path, []]),
  );

  for (const layer of layers) {
    for (const entry of layer.off) {
      turnOff(files, parts, entry);
    }

    for (const [path, content] of decoded(layer.files)) {
      const texts = parts.get(path);
      if (texts) {
        texts.push({ layer: layer.id, text: content.toString() });
        continue;
      }

      const below = files.get(path);
      const merge = merges[path];

      files.set(
        path,
        below && merge ? mergedJson(below, content, merge) : content,
      );
    }
  }

  for (const [path, texts] of parts) {
    if (texts.length > 0) {
      files.set(path, Buffer.from(texts.map(({ text }) => text).join("\n\n")));
    }
  }

  return encoded(files);
}

const merges: Readonly<
  Record<string, (under: Settings, over: Settings) => Settings>
> = {
  "settings.json": (under, over) => {
    const packages = packagesOver(under["packages"], over["packages"]);
    const { packages: _, ...merged } = deepMerge(under, over);

    for (const key of resources) {
      const below = under[key];
      const above = over[key];

      if (Array.isArray(below) && Array.isArray(above)) {
        merged[key] = [
          ...new Set([...(below as unknown[]), ...(above as unknown[])]),
        ];
      }
    }

    return { ...merged, ...(packages.length > 0 && { packages }) };
  },
  "mcp.json": deepMerge,
};

// Pi reports a file it can't read when the Session starts, so when either
// isn't a JSON object the nearer one is taken as it is.
function mergedJson(
  under: Buffer,
  over: Buffer,
  merge: (under: Settings, over: Settings) => Settings,
): Buffer {
  const a = objectIn(under);
  const b = objectIn(over);

  return a && b ? Buffer.from(JSON.stringify(merge(a, b))) : over;
}

// What a layer turns off below it: a package by its source, an MCP server by
// its name, one layer's AGENTS.md or APPEND_SYSTEM.md text, or a file or
// folder by its path, such as skills/review.
function turnOff(
  files: Map<string, Buffer>,
  parts: ReadonlyMap<string, { layer: string; text: string }[]>,
  entry: string,
): void {
  const [kind = "", ...rest] = entry.split(":");
  const name = rest.join(":");

  const texts = parts.get(kind);
  if (texts && name !== "") {
    texts.splice(
      0,
      texts.length,
      ...texts.filter(({ layer }) => layer !== name),
    );

    return;
  }

  if (kind === "package" || kind === "mcp") {
    const path = kind === "package" ? "settings.json" : "mcp.json";
    const json = files.get(path);
    const value = json && objectIn(json);
    if (value) {
      files.set(path, Buffer.from(JSON.stringify(without(value, kind, name))));
    }

    return;
  }

  for (const path of [...files.keys()]) {
    if (path === entry || path.startsWith(`${entry}/`)) {
      files.delete(path);
    }
  }
}

function without(value: Settings, kind: string, name: string): Settings {
  if (kind === "mcp") {
    const { [name]: _, ...servers } = isObject(value["mcpServers"])
      ? value["mcpServers"]
      : {};

    return { ...value, mcpServers: servers };
  }

  const packages = Array.isArray(value["packages"])
    ? (value["packages"] as unknown[]).filter(
        (pkg) => identityOf(pkg) !== packageIdentity(name),
      )
    : [];

  const { packages: _, ...rest } = value;

  return { ...rest, ...(packages.length > 0 && { packages }) };
}

type Settings = Record<string, unknown>;

function decoded(files: ProfileFiles): Map<string, Buffer> {
  return new Map(
    Object.entries(files.files).map(([path, content]) => [
      path,
      Buffer.from(content, "base64"),
    ]),
  );
}

function objectIn(content: Buffer): Settings | undefined {
  try {
    const value: unknown = JSON.parse(content.toString());

    return isObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

// Pi's own merge of its global and project settings.
function deepMerge(under: Settings, over: Settings): Settings {
  const merged = { ...under };

  for (const [key, value] of Object.entries(over)) {
    const below = under[key];

    merged[key] =
      isObject(below) && isObject(value) ? deepMerge(below, value) : value;
  }

  return merged;
}

// Packages from both load, and a Profile's entry for a source replaces the
// base's.
function packagesOver(under: unknown, over: unknown): unknown[] {
  const listed = (value: unknown): unknown[] =>
    Array.isArray(value) ? (value as unknown[]) : [];

  const own = new Set(listed(over).map(identityOf));

  return [
    ...listed(under).filter((pkg) => !own.has(identityOf(pkg))),
    ...listed(over),
  ];
}

function identityOf(pkg: unknown): unknown {
  const source = isObject(pkg) ? pkg["source"] : pkg;

  return typeof source === "string" ? packageIdentity(source) : source;
}

function isObject(value: unknown): value is Settings {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Files by path with the hash runners compare their copy with.
export function encoded(files: ReadonlyMap<string, Buffer>): ProfileFiles {
  const paths = [...files.keys()].sort((a, b) => (a < b ? -1 : 1));
  const hash = createHash("sha256");

  for (const path of paths) {
    const content = files.get(path) ?? Buffer.alloc(0);
    hash.update(`${path}\0${String(content.length)}\0`);
    hash.update(content);
  }

  return {
    hash: hash.digest("hex"),
    files: Object.fromEntries(
      paths.map((path) => [
        path,
        (files.get(path) ?? Buffer.alloc(0)).toString("base64"),
      ]),
    ),
  };
}
