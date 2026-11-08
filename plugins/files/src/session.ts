import { createWriteStream } from "node:fs";
import { lstat, mkdir, readdir, rename, stat } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebStream } from "node:stream/web";
import { defineSession, type SessionContext, Type } from "@pipoca/plugins";
import { noticeType } from "@pipoca/protocol";
import { files } from "../plugin";
import {
  bytes,
  type FilesState,
  type SessionFile,
  uploadNotice,
} from "./files";

const firstRetryMs = 30_000;
const lastRetryMs = 5 * 60_000;
const maxOutputs = 10_000;

// Saves outputs/ on the server after every turn and brings the files people
// gave the Session into uploads/, on whichever runner it is on (ADR 0078).
// Both live in the plugin's folder for the Session, outside the workspace,
// so they never show in a repository's changes.
export const session = defineSession(files, (s) => {
  const outputsDir = join(s.folder, "outputs");
  const uploadsDir = join(s.folder, "uploads");

  s.tools.define({
    name: "list_files",
    label: "List files",
    description:
      "Finds files kept for this Session: what you saved for the person and what people uploaded. Returns at most 20 matches with their full paths.",
    params: Type.Object({
      query: Type.String({
        description:
          "Words in the file's path, such as 'invoice pdf'; empty lists them all",
      }),
    }),
    annotations: { readOnly: true },
    // Its guidelines tell Pi where to save, so they stay in the prompt.
    exposure: "direct",
    prompt: {
      snippet: "List the files saved for this Session",
      guidelines: [
        `Write files the person should keep, such as a report or an export, in ${outputsDir}. They're saved on the server after each turn, with downloads beside the Session.`,
        `Files people give you arrive in ${uploadsDir}.`,
      ],
    },
    run: async ({ query }) => {
      const answer = await s.api.get<{
        files: SessionFile[];
        more: number;
      }>(`session/files?query=${encodeURIComponent(query)}`);

      if (answer.files.length === 0) {
        return "No files match.";
      }

      const lines = answer.files.map(
        ({ place, path, size }) =>
          `${join(s.folder, place, ...path.split("/"))} (${bytes(size)})`,
      );

      return answer.more > 0
        ? [...lines, `and ${String(answer.more)} more`].join("\n")
        : lines.join("\n");
    },
  });

  s.extension((pi) => {
    const outputs = outputSync(s);
    const uploads = uploadInbox(s);

    pi.on("session_start", (_event, ctx) => {
      outputs.run(s.folder);
      uploads.noticed(ctx.sessionManager.getBranch());
      uploads.copy(s.folder);
    });

    // Pi reads an upload only once it's in the workspace.
    pi.on("before_agent_start", async (_event, ctx) => {
      if (uploads.noticed(ctx.sessionManager.getBranch())) {
        uploads.copy(s.folder);
      }

      await uploads.copied();
    });

    pi.on("agent_settled", () => {
      outputs.run(s.folder);
    });

    pi.on("session_shutdown", async () => {
      await outputs.flush();
    });
  });
});

interface Scanned {
  readonly path: string;
  readonly hash: string;
  readonly size: number;
}

type Context = Pick<
  SessionContext<typeof files>,
  "api" | "blobs" | "config" | "log" | "publish" | "timer"
>;

// One sync at a time; a turn that ends during one queues one more. A sync
// that fails tries again later, longer each time, so outputs/ is the outbox.
function outputSync(s: Context): {
  readonly run: (cwd: string) => void;
  readonly flush: () => Promise<void>;
} {
  const hashes = new Map<string, { key: string; hash: string }>();
  let running = Promise.resolve();
  let queued: string | undefined;
  let lastCwd: string | undefined;
  let wait = firstRetryMs;
  let cancelRetry: (() => void) | undefined;
  let ended = false;

  const scan = async (
    root: string,
  ): Promise<{ files: Scanned[]; skipped: string[] }> => {
    const found: Scanned[] = [];
    const skipped: string[] = [];
    const limit = s.config.maxFileBytes;

    const entries = await readdir(root, {
      recursive: true,
      withFileTypes: true,
    }).catch(() => []);

    for (const entry of entries) {
      if (!entry.isFile() || found.length >= maxOutputs) {
        continue;
      }

      const full = join(entry.parentPath, entry.name);
      const path = relative(root, full).split(sep).join("/");
      const info = await stat(full).catch(() => undefined);

      if (info === undefined) {
        continue;
      }

      if (info.size > limit) {
        skipped.push(path);

        continue;
      }

      const key = `${String(info.size)}:${String(info.mtimeMs)}`;
      let hash = hashes.get(path)?.key === key ? hashes.get(path)?.hash : "";

      if (hash === "" || hash === undefined) {
        // Pi may remove the file between stat and read.
        hash = await s.blobs.hash(full).catch(() => undefined);

        if (hash === undefined) {
          continue;
        }

        hashes.set(path, { key, hash });
      }

      found.push({ path, hash, size: info.size });
    }

    return { files: found, skipped };
  };

  const sync = async (cwd: string): Promise<void> => {
    queued = undefined;
    const root = join(cwd, "outputs");
    const { files: found, skipped } = await scan(root);

    const tooLarge =
      skipped.length === 0
        ? undefined
        : `${skipped.join(", ")} ${skipped.length === 1 ? "is" : "are"} larger than this server keeps.`;

    let unsaved = [...found];

    try {
      const missing = new Set(
        await s.blobs.missing(found.map(({ hash }) => hash)),
      );

      unsaved = found.filter(({ hash }) => missing.has(hash));

      for (const file of unsaved.slice()) {
        await s.blobs.upload(join(root, file.path));
        unsaved = unsaved.filter((each) => each !== file);
      }

      await s.api.put("session/outputs", { files: found });

      wait = firstRetryMs;
      s.publish("files", state([], tooLarge));
    } catch (error) {
      const problem = error instanceof Error ? error.message : String(error);

      s.log("outputs not saved", { files: unsaved.length, error: problem });

      s.publish(
        "files",
        state(
          unsaved.map(({ path }) => path),
          tooLarge === undefined ? problem : `${problem} ${tooLarge}`,
        ),
      );

      cancelRetry?.();

      if (ended) {
        return;
      }

      cancelRetry = s.timer.after(wait, async () => {
        cancelRetry = undefined;
        schedule(cwd);

        return Promise.resolve();
      });

      wait = Math.min(wait * 2, lastRetryMs);
    }
  };

  const schedule = (cwd: string): void => {
    lastCwd = cwd;

    if (queued === undefined) {
      queued = cwd;
      running = running.then(async () => sync(cwd));
    }
  };

  return {
    run: schedule,
    // One last try as the Session ends, with no retry after it, so a
    // runner that lost the server can still stop.
    flush: async () => {
      cancelRetry?.();

      if (lastCwd !== undefined) {
        schedule(lastCwd);
      }

      ended = true;
      await running;
    },
  };
}

function state(unsaved: readonly string[], problem?: string): FilesState {
  return { unsaved, ...(problem !== undefined && { problem }) };
}

// What noticed reads of Pi's session entries.
interface Entry {
  readonly type: string;
  readonly id: string;
  readonly customType?: string;
  readonly details?: unknown;
}

// Uploads live on the server, and each runner the Session lands on copies
// them into uploads/: when it starts, and when a person adds one, which Pi
// hears about from the server's notice.
function uploadInbox(s: Context): {
  readonly copy: (cwd: string) => void;
  readonly copied: () => Promise<void>;
  readonly noticed: (entries: readonly Entry[]) => boolean;
} {
  const handled = new Set<string>();
  let copying = Promise.resolve();

  const copyAll = async (cwd: string): Promise<void> => {
    const { files: kept } = await s.api.get<{ files: SessionFile[] }>(
      "session/uploads",
    );

    for (const file of kept) {
      const to = join(cwd, "uploads", ...file.path.split("/"));
      const there = await lstat(to).catch(() => undefined);

      if (there === undefined) {
        await fetched(s, file.path, to);
      }
    }
  };

  return {
    copy: (cwd) => {
      copying = copying.then(async () =>
        copyAll(cwd).catch((error: unknown) => {
          s.log("uploads not copied", { error: String(error) });
        }),
      );
    },
    copied: async () => copying,
    noticed: (entries) => {
      let found = false;

      for (const entry of entries) {
        if (
          entry.type === "custom_message" &&
          entry.customType === noticeType &&
          (entry.details as { kind?: unknown } | undefined)?.kind ===
            uploadNotice &&
          !handled.has(entry.id)
        ) {
          handled.add(entry.id);
          found = true;
        }
      }

      return found;
    },
  };
}

async function fetched(s: Context, path: string, to: string): Promise<void> {
  const response = await s.api.raw(
    `session/files/uploads?path=${encodeURIComponent(path)}`,
  );

  if (!response.ok || response.body === null) {
    throw new Error(`uploads/${path}: ${String(response.status)}`);
  }

  const partial = `${to}.part`;

  await mkdir(dirname(to), { recursive: true });

  await pipeline(
    Readable.fromWeb(response.body as WebStream<Uint8Array>),
    createWriteStream(partial),
  );

  await rename(partial, to);
}
