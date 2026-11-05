import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { HttpError, type PluginConfig } from "@pipoca/plugins";
import type { Log } from "@pipoca/protocol";

// The config folder's pipoca.json, a key per plugin (ADR 0039). People edit
// it by hand and plugins through their UI, so it is read again whenever it
// changes on disk. A plugin key in the locked file, such as one Helm writes,
// wins over the folder's and can't be changed from Settings (ADR 0063).
export function configFolder(
  dir: string,
  log: Log,
  locked?: string,
): (plugin: string) => PluginConfig {
  const file = join(dir, "pipoca.json");

  const own = watched(file, log);
  const fixed = locked === undefined ? undefined : watched(locked, log);

  const lockedIn = (plugin: string): string | undefined =>
    fixed !== undefined && Object.hasOwn(fixed.values(), plugin)
      ? locked
      : undefined;

  return (plugin) => ({
    dir: join(dir, plugin),
    get: () => {
      const all =
        lockedIn(plugin) === undefined ? own.values() : fixed?.values();

      return all !== undefined && Object.hasOwn(all, plugin)
        ? all[plugin]
        : undefined;
    },
    set: (value) => {
      const lockedFile = lockedIn(plugin);

      if (lockedFile !== undefined) {
        throw new HttpError(
          409,
          `${plugin} is set in ${lockedFile}, so it can't change here`,
          "config_locked",
        );
      }

      if (own.broken()) {
        throw new Error(`fix ${file} first: it isn't a JSON object`);
      }

      const others = Object.fromEntries(
        Object.entries(own.values()).filter(([key]) => key !== plugin),
      );

      const next =
        value === undefined ? others : { ...others, [plugin]: value };

      replace(dir, file, `${JSON.stringify(next, null, 2)}\n`);
      own.wrote(next);
    },
    lockedIn: () => lockedIn(plugin),
  });
}

// A JSON object file, read again once it changes. Readers keep the last
// values that parsed until a broken file is fixed.
function watched(
  file: string,
  log: Log,
): {
  readonly values: () => Readonly<Record<string, unknown>>;
  readonly broken: () => boolean;
  readonly wrote: (values: Readonly<Record<string, unknown>>) => void;
} {
  let values: Readonly<Record<string, unknown>> = {};
  let version: string | undefined;
  let broken = false;

  const current = (): Readonly<Record<string, unknown>> => {
    const seen = versionOf(file);
    if (seen === version) {
      return values;
    }

    version = seen;

    if (seen === undefined) {
      values = {};
      broken = false;

      return values;
    }

    try {
      values = parsed(file);
      broken = false;
    } catch (error) {
      broken = true;

      log("config file unreadable", {
        file,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return values;
  };

  return {
    values: current,
    broken: () => {
      current();

      return broken;
    },
    wrote: (next) => {
      values = next;
      version = versionOf(file);
    },
  };
}

// The config folder's files as text, for admins who edit them in Settings
// (ADR 0063): pipoca.json and the shared Profiles. People's own folders stay
// out. The locked file is listed by its own path and only read.
export interface ConfigFiles {
  readonly root: string;
  readonly list: () => readonly ConfigEntry[];
  readonly read: (name: string) => ConfigText | undefined;
  // Why the text wasn't written, or undefined once it was. The version is
  // the one read, so an edit never overwrites a change made since.
  readonly write: (
    name: string,
    text: string,
    version: string | null,
  ) => ConfigRefusal | undefined;
}

export interface ConfigEntry {
  readonly name: string;
  readonly locked: boolean;
}

export interface ConfigText extends ConfigEntry {
  readonly text: string;
  readonly version: string | null;
}

export interface ConfigRefusal {
  readonly changed: boolean;
  readonly reason: string;
}

const editableFolders = ["profiles", "base"];
const largestFile = 256 * 1024;

export function configFiles(dir: string, locked?: string): ConfigFiles {
  const pathOf = (name: string): string | undefined => {
    const path = join(dir, name);
    const inside = relative(dir, path);

    if (
      inside === "pipoca.json" ||
      editableFolders.some((folder) => inside.startsWith(`${folder}/`))
    ) {
      return path;
    }

    return undefined;
  };

  const textOf = (path: string): string | undefined => {
    const stats = statSync(path, { throwIfNoEntry: false });

    if (stats?.isFile() !== true || stats.size > largestFile) {
      return undefined;
    }

    const text = readFileSync(path, "utf8");

    return text.includes("\0") ? undefined : text;
  };

  return {
    root: dir,
    list: () => [
      { name: "pipoca.json", locked: false },
      ...editableFolders.flatMap((folder) =>
        filesIn(join(dir, folder))
          .filter((path) => textOf(path) !== undefined)
          .map((path) => ({ name: relative(dir, path), locked: false })),
      ),
      ...(locked !== undefined && existsSync(locked)
        ? [{ name: locked, locked: true }]
        : []),
    ],
    read: (name) => {
      if (locked !== undefined && name === locked) {
        const text = textOf(locked);

        return text === undefined
          ? undefined
          : { name, locked: true, text, version: versionOf(locked) ?? null };
      }

      const path = pathOf(name);

      if (path === undefined) {
        return undefined;
      }

      if (name === "pipoca.json" && !existsSync(path)) {
        return { name, locked: false, text: "{}\n", version: null };
      }

      const text = textOf(path);

      return text === undefined
        ? undefined
        : { name, locked: false, text, version: versionOf(path) ?? null };
    },
    write: (name, text, version) => {
      const path = pathOf(name);

      if (path === undefined) {
        return { changed: false, reason: `${name} can't be edited here` };
      }

      if ((versionOf(path) ?? null) !== version) {
        return {
          changed: true,
          reason:
            "the file changed since you opened it; reload to see the change",
        };
      }

      if (path.endsWith(".json")) {
        const refused = jsonRefusal(text, name === "pipoca.json");

        if (refused !== undefined) {
          return refused;
        }
      }

      replace(dirname(path), path, text.endsWith("\n") ? text : `${text}\n`);

      return undefined;
    },
  };
}

function jsonRefusal(
  text: string,
  keyPerPlugin: boolean,
): ConfigRefusal | undefined {
  let value: unknown;

  try {
    value = JSON.parse(text);
  } catch (error) {
    return {
      changed: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  if (
    keyPerPlugin &&
    (typeof value !== "object" || value === null || Array.isArray(value))
  ) {
    return {
      changed: false,
      reason: "it must hold an object with a key per plugin",
    };
  }

  return undefined;
}

function filesIn(folder: string): readonly string[] {
  if (!existsSync(folder)) {
    return [];
  }

  return readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.endsWith(".tmp"))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

// A rename replaces the file whole, so a crash never leaves half of it.
function replace(dir: string, file: string, text: string): void {
  mkdirSync(dir, { recursive: true });
  const written = `${file}.${String(process.pid)}.tmp`;
  writeFileSync(written, text);
  renameSync(written, file);
}

function versionOf(file: string): string | undefined {
  const stats = statSync(file, { throwIfNoEntry: false });

  return stats && `${String(stats.mtimeMs)}:${String(stats.size)}`;
}

function parsed(file: string): Readonly<Record<string, unknown>> {
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("it must hold an object with a key per plugin");
  }

  return value as Record<string, unknown>;
}
