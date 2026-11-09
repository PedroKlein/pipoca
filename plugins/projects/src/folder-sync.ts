import { createWriteStream } from "node:fs";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebStream } from "node:stream/web";
import type { SessionContext } from "@pipoca/plugins";
import type { projects } from "../plugin";
import type { FolderChange, FolderFile, FolderSync } from "./model";

type Context = Pick<
  SessionContext<typeof projects>,
  "api" | "blobs" | "config" | "folder" | "log" | "timer"
>;

const firstRetryMs = 30_000;
const lastRetryMs = 5 * 60_000;
const maxFiles = 10_000;

// Keeps the runner's project/ and the Project's folder on the server alike
// (ADR 0078). base holds the hash each file had when this runner last
// agreed with the server, so a sync can tell its own changes from others'.
// One sync runs at a time and a sync asked for meanwhile runs once after
// it; a failed one tries again later, longer each time.
export function folderSync(s: Context): {
  readonly dir: string;
  readonly run: () => void;
  readonly synced: () => Promise<void>;
  readonly flush: () => Promise<void>;
} {
  const dir = join(s.folder, "project");
  const incoming = join(s.folder, "project-incoming");
  const basePath = join(s.folder, "project-base.json");
  const hashes = new Map<string, { key: string; hash: string }>();
  let base: Map<string, string> | undefined;
  let running = Promise.resolve();
  let queued = false;
  let wait = firstRetryMs;
  let cancelRetry: (() => void) | undefined;
  let ended = false;

  const loadBase = async (): Promise<Map<string, string>> => {
    base ??= new Map(
      Object.entries(
        await readFile(basePath, "utf8")
          .then((text) => JSON.parse(text) as Record<string, string>)
          .catch(() => ({})),
      ),
    );

    return base;
  };

  const saveBase = async (known: Map<string, string>): Promise<void> => {
    await writeFile(basePath, JSON.stringify(Object.fromEntries(known)));
  };

  const hashOf = async (path: string): Promise<string | undefined> => {
    const full = join(dir, ...path.split("/"));
    const info = await stat(full).catch(() => undefined);

    if (info?.isFile() !== true) {
      return undefined;
    }

    const key = `${String(info.size)}:${String(info.mtimeMs)}`;
    const known = hashes.get(path);

    if (known?.key === key) {
      return known.hash;
    }

    const hash = await s.blobs.hash(full);
    hashes.set(path, { key, hash });

    return hash;
  };

  const scan = async (): Promise<Map<string, string>> => {
    const found = new Map<string, string>();

    const entries = await readdir(dir, {
      recursive: true,
      withFileTypes: true,
    }).catch(() => []);

    for (const entry of entries) {
      if (!entry.isFile() || found.size >= maxFiles) {
        continue;
      }

      const path = relative(dir, join(entry.parentPath, entry.name))
        .split(sep)
        .join("/");

      const info = await stat(join(dir, ...path.split("/"))).catch(
        () => undefined,
      );

      if (info === undefined || info.size > s.config.maxFileBytes) {
        continue;
      }

      const hash = await hashOf(path);

      if (hash !== undefined) {
        found.set(path, hash);
      }
    }

    return found;
  };

  // Sends what changed here since the last sync. A change the server kept
  // as a conflict copy moves to the copy's name here too, so the next pull
  // brings the other Session's version under the original name.
  const push = async (known: Map<string, string>): Promise<void> => {
    const local = await scan();
    const changes: FolderChange[] = [];

    for (const [path, hash] of local) {
      if (known.get(path) !== hash) {
        changes.push({ path, hash, base: known.get(path) ?? null });
      }
    }

    for (const [path, hash] of known) {
      if (!local.has(path)) {
        changes.push({ path, hash: null, base: hash });
      }
    }

    if (changes.length === 0) {
      return;
    }

    const missing = new Set(
      await s.blobs.missing(
        changes.flatMap(({ hash }) => (hash === null ? [] : [hash])),
      ),
    );

    for (const change of changes) {
      if (change.hash !== null && missing.has(change.hash)) {
        await s.blobs.upload(join(dir, ...change.path.split("/")));
        missing.delete(change.hash);
      }
    }

    const answer = await s.api.post<FolderSync>("folder", { changes });
    const server = new Map(answer.files.map((file) => [file.path, file.hash]));

    for (const change of changes) {
      const now = server.get(change.path);

      if (change.hash === null) {
        known.delete(change.path);
      } else if (now === change.hash) {
        known.set(change.path, change.hash);
      }
    }

    for (const { path, copy } of answer.conflicts) {
      const to = join(dir, ...copy.split("/"));

      await mkdir(dirname(to), { recursive: true });
      await rename(join(dir, ...path.split("/")), to);

      known.delete(path);

      const copied = server.get(copy);

      if (copied !== undefined) {
        known.set(copy, copied);
      }
    }
  };

  // Brings what other Sessions and people changed. A file changed here
  // since the last sync stays as it is, for the next push.
  const pull = async (known: Map<string, string>): Promise<void> => {
    const { files } = await s.api.get<{ files: FolderFile[] }>("folder");
    const server = new Map(files.map((file) => [file.path, file.hash]));

    for (const [path, hash] of server) {
      const local = await hashOf(path);

      if (local === hash) {
        known.set(path, hash);
      } else if (local === known.get(path)) {
        await fetched(path, hash, known.get(path));
        known.set(path, hash);
      }
    }

    for (const [path, hash] of known) {
      if (!server.has(path)) {
        const local = await hashOf(path);

        if (local === hash) {
          await rm(join(dir, ...path.split("/")), { force: true });
        }

        if (local === hash || local === undefined) {
          known.delete(path);
        }
      }
    }
  };

  // Downloads beside project/ and moves the file in only if nobody changed
  // it meanwhile.
  const fetched = async (
    path: string,
    hash: string,
    expected: string | undefined,
  ): Promise<void> => {
    const response = await s.api.raw(
      `folder/file?path=${encodeURIComponent(path)}`,
    );

    if (!response.ok || response.body === null) {
      throw new Error(`project/${path}: ${String(response.status)}`);
    }

    const partial = join(incoming, hash);

    await mkdir(incoming, { recursive: true });

    await pipeline(
      Readable.fromWeb(response.body as WebStream<Uint8Array>),
      createWriteStream(partial),
    );

    if ((await hashOf(path)) !== expected) {
      await rm(partial, { force: true });

      return;
    }

    const to = join(dir, ...path.split("/"));

    await mkdir(dirname(to), { recursive: true });
    await rename(partial, to);
  };

  const sync = async (): Promise<void> => {
    queued = false;

    const known = await loadBase();

    try {
      await mkdir(dir, { recursive: true });
      await push(known);
      await pull(known);
      wait = firstRetryMs;
    } catch (error) {
      s.log("project folder not synced", {
        error: error instanceof Error ? error.message : String(error),
      });

      cancelRetry?.();

      if (!ended) {
        cancelRetry = s.timer.after(wait, async () => {
          cancelRetry = undefined;
          schedule();

          return Promise.resolve();
        });

        wait = Math.min(wait * 2, lastRetryMs);
      }
    } finally {
      await saveBase(known).catch((error: unknown) => {
        s.log("project folder state not kept", { error: String(error) });
      });
    }
  };

  const schedule = (): void => {
    if (!queued) {
      queued = true;
      running = running.then(sync);
    }
  };

  return {
    dir,
    run: schedule,
    synced: async () => {
      schedule();
      await running;
    },
    // One last try as the Session ends, with no retry after it.
    flush: async () => {
      cancelRetry?.();
      schedule();
      ended = true;
      await running;
    },
  };
}
