import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, normalize, sep } from "node:path";
import type { ManifestEntry } from "@pipoca/protocol";

// A repository, or what it holds, that the server won't take.
export class InvalidRepository extends Error {}

// The file at a repository's root that lists what it shares (ADR 0063).
const manifestFile = "pipoca.json";

const maxManifestBytes = 256 * 1024;

// What a clone's pipoca.json lists of one kind, or nothing without one.
export function listedIn(
  dir: string,
  kind: "profiles" | "templates",
): readonly ManifestEntry[] {
  const file = join(dir, manifestFile);
  const info = lstatSync(file, { throwIfNoEntry: false });

  if (info === undefined) {
    return [];
  }

  if (!info.isFile() || info.size > maxManifestBytes) {
    throw new InvalidRepository(`${manifestFile} must be a small file`);
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new InvalidRepository(`${manifestFile} is not JSON`);
  }

  const entries = isRecord(manifest) ? manifest[kind] : undefined;

  if (entries === undefined) {
    return [];
  }

  if (!Array.isArray(entries)) {
    throw new InvalidRepository(`${kind} in ${manifestFile} must be a list`);
  }

  return entries.map((entry: unknown) => {
    if (
      !isRecord(entry) ||
      typeof entry["name"] !== "string" ||
      entry["name"].trim() === "" ||
      typeof entry["path"] !== "string"
    ) {
      throw new InvalidRepository(
        `each entry of ${kind} in ${manifestFile} needs a name and a path`,
      );
    }

    return { name: entry["name"].trim(), path: insidePath(entry["path"]) };
  });
}

// The entries of the manifest the paths name, each of which it must list.
export function picked(
  listed: readonly ManifestEntry[],
  paths: readonly string[],
): readonly ManifestEntry[] {
  return paths.map((path) => {
    const found = listed.find((each) => each.path === path);

    if (!found) {
      throw new InvalidRepository(`${manifestFile} doesn't list ${path}`);
    }

    return found;
  });
}

// The real path of a folder in the clone, which must stay inside it.
export function repositoryFolder(dir: string, path: string): string {
  const root = realpathSync(dir);
  const folder = join(root, insidePath(path));
  const info = lstatSync(folder, { throwIfNoEntry: false });

  if (
    info?.isDirectory() !== true ||
    !(realpathSync(folder) + sep).startsWith(root + sep)
  ) {
    throw new InvalidRepository(`${path} is not a folder in the repository`);
  }

  return folder;
}

// A small file in the clone, which must stay inside it.
export function repositoryFile(dir: string, path: string): string {
  const root = realpathSync(dir);
  const file = join(root, insidePath(path));
  const info = lstatSync(file, { throwIfNoEntry: false });

  if (
    info?.isFile() !== true ||
    info.size > maxManifestBytes ||
    !realpathSync(file).startsWith(root + sep)
  ) {
    throw new InvalidRepository(
      `${path} is not a small file in the repository`,
    );
  }

  return readFileSync(file, "utf8");
}

function insidePath(path: string): string {
  const relative = normalize(path.trim()).replace(/\/+$/, "") || ".";

  if (isAbsolute(relative) || relative.split(sep).includes("..")) {
    throw new InvalidRepository(
      `${path} must be a folder inside the repository`,
    );
  }

  return relative;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
