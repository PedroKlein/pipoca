import type { Log } from "@pipoca/protocol";
import {
  type Dirent,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  type PiPackage,
  type Profile,
  type ProfileContent,
  type ProfileFiles,
  type RepositorySource,
  emptyProfile,
  profilePath,
} from "@pipoca/protocol";
import {
  contentFiles,
  folderEntries,
  folderFiles,
  type Layer,
  maxProfileBytes,
  stacked,
  tooBig,
} from "./files";
import { InvalidProfile } from "./invalid";

export type StoredProfile = Omit<Profile, "isDefault">;

// Every user has this shared Profile. Until an admin edits it, its folder
// doesn't exist and it is plain Pi (ADR 0041).
export const defaultProfileId = "default";

// Pipoca's own fields, next to Pi's files (ADR 0041).
const metaFile = "profile.json";

const ids = /^[a-z0-9][a-z0-9._-]{0,63}$/;

// How many Profiles a Profile may build on, one on top of the next.
export const maxBuildsOn = 4;

interface Meta {
  readonly name: string;
  readonly description?: string;
  // No owner means the Profile is shared with every user.
  readonly owner?: string;
  // The Profile this one builds on (ADR 0063).
  readonly buildsOn?: string;
  // The repository folder the Profile follows (ADR 0063).
  readonly source?: RepositorySource;
  readonly createdAt: string;
  // What the Profile turned off of the layers below it (ADR 0074).
  readonly off?: readonly string[];
}

// The Profiles in the server's config folder, one Pi agent folder each
// (ADR 0041). They are read from disk every time, so edits by hand count
// right away.
export class ProfileFolders {
  readonly #root: string;
  readonly #log: Log;
  readonly #base: ProfileLayer | undefined;
  readonly #people: string | undefined;

  // The admin's base Profile (ADR 0044) and each person's My defaults
  // (ADR 0063) live outside root, so nobody picks them for a Session.
  constructor(root: string, log: Log, baseDir?: string, peopleDir?: string) {
    this.#root = root;
    this.#log = log;
    this.#people = peopleDir;

    this.#base =
      baseDir === undefined ? undefined : new ProfileLayer(baseDir, log);
  }

  get base(): ProfileLayer | undefined {
    return this.#base;
  }

  // The person's My defaults, under every Profile of theirs.
  defaults(ownerId: string): ProfileLayer | undefined {
    return this.#people === undefined || !ids.test(ownerId)
      ? undefined
      : new ProfileLayer(join(this.#people, ownerId, "defaults"), this.#log);
  }

  ids(): readonly string[] {
    const found = entries(this.#root)
      .filter((entry) => entry.isDirectory() && ids.test(entry.name))
      .map(({ name }) => name);

    return [...new Set([defaultProfileId, ...found])];
  }

  read(id: string): StoredProfile | undefined {
    if (!ids.test(id)) {
      return undefined;
    }

    const dir = join(this.#root, id);
    const stats = statSync(dir, { throwIfNoEntry: false });

    if (stats?.isDirectory() !== true) {
      return id === defaultProfileId
        ? {
            id,
            name: nameOf(id),
            description: "",
            ownerId: null,
            buildsOn: null,
            source: null,
            createdAt: new Date(0).toISOString(),
            packages: [],
            agentsMd: "",
            systemMd: "",
            appendSystemMd: "",
            mcpServers: {},
            settings: {},
            off: [],
          }
        : undefined;
    }

    const meta = this.#json(join(dir, metaFile));
    const { packages, ...settings } = this.#json(join(dir, "settings.json"));
    const { mcpServers } = this.#json(join(dir, "mcp.json"));

    return {
      id,
      name:
        typeof meta["name"] === "string" && meta["name"] !== ""
          ? meta["name"]
          : nameOf(id),
      description:
        typeof meta["description"] === "string" ? meta["description"] : "",
      ownerId: typeof meta["owner"] === "string" ? meta["owner"] : null,
      buildsOn: typeof meta["buildsOn"] === "string" ? meta["buildsOn"] : null,
      source: sourceOf(meta["source"]),
      createdAt:
        typeof meta["createdAt"] === "string"
          ? meta["createdAt"]
          : stats.mtime.toISOString(),
      packages: Array.isArray(packages) ? (packages as PiPackage[]) : [],
      agentsMd: text(join(dir, "AGENTS.md")),
      systemMd: text(join(dir, "SYSTEM.md")),
      appendSystemMd: text(join(dir, "APPEND_SYSTEM.md")),
      mcpServers: isRecord(mcpServers) ? mcpServers : {},
      settings,
      off: offOf(meta["off"]),
    };
  }

  // What runners download for a Session of the owner's: the base, their My
  // defaults, the Profiles this one builds on and its own files, the nearer
  // layer winning. Throws ProfileTooBig for a folder runners shouldn't get.
  files(id: string, ownerId?: string): ProfileFiles | undefined {
    const own = this.#ownLayer(id);
    if (!own) {
      return undefined;
    }

    const below = this.buildsOn(id).flatMap(
      (under) => this.#ownLayer(under) ?? [],
    );

    return stacked([...this.#layers(ownerId), ...below.reverse(), own]);
  }

  // The base and the owner's My defaults, which sit under every Profile.
  layers(ownerId?: string): ProfileFiles | undefined {
    const layers = this.#layers(ownerId);

    return layers.length === 0 ? undefined : stacked(layers);
  }

  #layers(ownerId?: string): readonly Layer[] {
    const defaults = ownerId === undefined ? undefined : this.defaults(ownerId);

    return [
      this.#base?.layer(baseLayer),
      defaults?.layer(defaultsLayer),
    ].flatMap((layer) => layer ?? []);
  }

  #ownLayer(id: string): Layer | undefined {
    const files = this.ownFiles(id);

    return files && { id, files, off: this.read(id)?.off ?? [] };
  }

  // The Profiles under this one, nearest first. A missing Profile, a loop or
  // more than maxBuildsOn ends the walk there.
  buildsOn(id: string): readonly string[] {
    const found: string[] = [];
    let next = this.read(id)?.buildsOn;

    while (
      typeof next === "string" &&
      next !== id &&
      !found.includes(next) &&
      found.length < maxBuildsOn
    ) {
      const under = this.read(next);
      if (!under) {
        break;
      }

      found.push(next);
      next = under.buildsOn;
    }

    return found;
  }

  // The folder's files without the base Profile, as an export holds them.
  ownFiles(id: string): ProfileFiles | undefined {
    const profile = this.read(id);
    if (!profile) {
      return undefined;
    }

    const dir = join(this.#root, id);

    return statSync(dir, { throwIfNoEntry: false })?.isDirectory() === true
      ? folderFiles(dir, profile.name)
      : contentFiles(profile);
  }

  entries(
    id: string,
  ): readonly { readonly path: string; readonly size: number }[] {
    return this.#exists(id) ? folderEntries(join(this.#root, id)) : [];
  }

  // A file's content, or undefined for one the Profile doesn't hold.
  file(id: string, path: string): Buffer | undefined {
    return this.entries(id).some((entry) => entry.path === path)
      ? readFileSync(join(this.#root, id, path))
      : undefined;
  }

  // Writes files into the folder, which must stay small enough for runners.
  // Throws InvalidProfile for a path a Profile can't hold, and ProfileTooBig.
  writeFiles(id: string, files: ReadonlyMap<string, Buffer>): void {
    const profile = this.read(id);
    if (!profile) {
      return;
    }

    const dir = join(this.#root, id);

    // Writing through a link could reach outside the folder.
    for (const path of files.keys()) {
      const parts = path.split("/");

      const linked = parts.some(
        (_part, n) =>
          lstatSync(join(dir, ...parts.slice(0, n + 1)), {
            throwIfNoEntry: false,
          })?.isSymbolicLink() === true,
      );

      if (!profilePath(path) || linked) {
        throw new InvalidProfile(`a Profile can't hold ${path}`);
      }
    }

    const kept = this.entries(id)
      .filter(({ path }) => !files.has(path))
      .reduce((total, { size }) => total + size, 0);

    const added = [...files.values()].reduce(
      (total, content) => total + content.length,
      0,
    );

    if (kept + added > maxProfileBytes) {
      throw tooBig(profile.name);
    }

    for (const [path, content] of files) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      replace(join(dir, path), content);
    }
  }

  // Makes the folder hold exactly these files, besides profile.json.
  // Throws ProfileTooBig before changing anything.
  replaceFiles(id: string, files: ReadonlyMap<string, Buffer>): void {
    const size = [...files.values()].reduce(
      (total, content) => total + content.length,
      0,
    );

    if (size > maxProfileBytes) {
      throw tooBig(this.read(id)?.name ?? id);
    }

    for (const { path } of this.entries(id)) {
      if (!files.has(path)) {
        rmSync(join(this.#root, id, path));
      }
    }

    this.writeFiles(id, files);
  }

  deleteFile(id: string, path: string): boolean {
    if (this.file(id, path) === undefined) {
      return false;
    }

    rmSync(join(this.#root, id, path));

    return true;
  }

  #exists(id: string): boolean {
    return (
      ids.test(id) &&
      statSync(join(this.#root, id), {
        throwIfNoEntry: false,
      })?.isDirectory() === true
    );
  }

  // A free id made from the name, such as work-2 when work is taken.
  freeId(name: string): string {
    const base =
      name
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "-")
        .replace(/^[^a-z0-9]+|-+$/g, "")
        .slice(0, 56) || "profile";

    const taken = new Set(this.ids());
    let id = base;
    for (let n = 2; taken.has(id); n++) {
      id = `${base}-${String(n)}`;
    }

    return id;
  }

  // Writes the fields given and leaves the Profile's other files alone, so
  // what people put there by hand stays.
  write(
    id: string,
    meta: Omit<
      StoredProfile,
      "id" | "buildsOn" | "source" | keyof ProfileContent
    > & {
      readonly buildsOn?: string | null;
      readonly source?: RepositorySource | null;
    },
    content: Partial<ProfileContent>,
  ): void {
    const dir = join(this.#root, id);
    mkdirSync(dir, { recursive: true });

    const off = offOf(this.#json(join(dir, metaFile))["off"]);

    replace(
      join(dir, metaFile),
      json({
        name: meta.name,
        ...(meta.description !== "" && { description: meta.description }),
        ...(meta.ownerId !== null && { owner: meta.ownerId }),
        ...(typeof meta.buildsOn === "string" && { buildsOn: meta.buildsOn }),
        ...(meta.source && { source: meta.source }),
        createdAt: meta.createdAt,
        ...(off.length > 0 && { off }),
      } satisfies Meta),
    );

    this.writeContent(id, content);
  }

  writeContent(id: string, content: Partial<ProfileContent>): void {
    const dir = join(this.#root, id);
    mkdirSync(dir, { recursive: true });

    if (content.settings !== undefined || content.packages !== undefined) {
      const { packages: old, ...settings } = this.#json(
        join(dir, "settings.json"),
      );

      const packages =
        content.packages ?? (Array.isArray(old) ? (old as PiPackage[]) : []);

      const next = {
        ...(content.settings ?? settings),
        ...(packages.length > 0 && { packages }),
      };

      replace(
        join(dir, "settings.json"),
        Object.keys(next).length === 0 ? "" : json(next),
      );
    }

    const texts = [
      ["AGENTS.md", content.agentsMd],
      ["SYSTEM.md", content.systemMd],
      ["APPEND_SYSTEM.md", content.appendSystemMd],
    ] as const;

    for (const [file, value] of texts) {
      if (value !== undefined) {
        replace(join(dir, file), value);
      }
    }

    if (content.mcpServers !== undefined) {
      replace(
        join(dir, "mcp.json"),
        Object.keys(content.mcpServers).length === 0
          ? ""
          : json({ mcpServers: content.mcpServers }),
      );
    }

    if (content.off !== undefined) {
      const { off: _, ...meta } = this.#json(join(dir, metaFile));

      const next = {
        ...meta,
        ...(content.off.length > 0 && { off: content.off }),
      };

      replace(
        join(dir, metaFile),
        Object.keys(next).length === 0 ? "" : json(next),
      );
    }
  }

  remove(id: string): void {
    rmSync(join(this.#root, id), { recursive: true, force: true });
  }

  #json(path: string): Record<string, unknown> {
    let source: string;
    try {
      source = readFileSync(path, "utf8");
    } catch {
      return {};
    }

    try {
      const value: unknown = JSON.parse(source);
      if (isRecord(value)) {
        return value;
      }
    } catch {
      // Logged below, as is a file that holds something other than an object.
    }

    this.#log("profile file unreadable", { file: path });

    return {};
  }
}

// A layer under Profiles, the admin's base or a person's My defaults: a Pi
// agent folder like a Profile's, with no owner or name of its own, that
// starts empty.
export class ProfileLayer {
  readonly #dir: string;
  readonly #folder: ProfileFolders;
  readonly #id: string;

  constructor(dir: string, log: Log) {
    this.#dir = dir;
    this.#folder = new ProfileFolders(dirname(dir), log);
    this.#id = basename(dir);
  }

  read(): ProfileContent {
    const {
      packages,
      agentsMd,
      systemMd,
      appendSystemMd,
      mcpServers,
      settings,
      off,
    } = this.#folder.read(this.#id) ?? emptyProfile;

    return {
      packages,
      agentsMd,
      systemMd,
      appendSystemMd,
      mcpServers,
      settings,
      off,
    };
  }

  layer(id: string): Layer | undefined {
    const files = this.files();

    return files && { id, files, off: this.read().off };
  }

  write(content: Partial<ProfileContent>): void {
    this.#folder.writeContent(this.#id, content);
  }

  files(): ProfileFiles | undefined {
    return this.#folder.files(this.#id);
  }

  entries(): readonly { readonly path: string; readonly size: number }[] {
    return this.#folder.entries(this.#id);
  }

  file(path: string): Buffer | undefined {
    return this.#folder.file(this.#id, path);
  }

  // Throws InvalidProfile for a path a Profile can't hold, and ProfileTooBig.
  writeFiles(files: ReadonlyMap<string, Buffer>): void {
    mkdirSync(this.#dir, { recursive: true });
    this.#folder.writeFiles(this.#id, files);
  }

  deleteFile(path: string): boolean {
    return this.#folder.deleteFile(this.#id, path);
  }
}

// How a Profile names the layers under every Profile when it turns off one's
// AGENTS.md or APPEND_SYSTEM.md. No Profile id starts with a colon.
export const baseLayer = ":base";
export const defaultsLayer = ":defaults";

const maxOff = 500;

function offOf(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value
        .filter((entry): entry is string => typeof entry === "string")
        .slice(0, maxOff)
    : [];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nameOf(id: string): string {
  return id === defaultProfileId ? "Default" : id;
}

function entries(dir: string): readonly Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function text(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

// An empty text removes the file. Otherwise the new file replaces the old one
// in one rename, so a reader never sees it half written.
function replace(path: string, content: string | Buffer): void {
  if (content === "") {
    rmSync(path, { force: true });

    return;
  }

  const temporary = `${path}.${String(process.pid)}.tmp`;
  writeFileSync(temporary, content);
  renameSync(temporary, path);
}

function sourceOf(value: unknown): RepositorySource | null {
  return isRecord(value) &&
    typeof value["url"] === "string" &&
    typeof value["path"] === "string" &&
    typeof value["commit"] === "string"
    ? { url: value["url"], path: value["path"], commit: value["commit"] }
    : null;
}
