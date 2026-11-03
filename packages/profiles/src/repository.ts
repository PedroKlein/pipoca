import { execFile } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, normalize, sep } from "node:path";
import { promisify } from "node:util";
import type { ManifestEntry } from "@pipoca/protocol";
import { isRecord } from "./folders";
import { folderEntries } from "./files";
import { InvalidProfile } from "./invalid";

// The file at a repository's root that lists what it shares (ADR 0063).
export const manifestFile = "pipoca.json";

const gitTimeoutMs = 60_000;
const maxManifestBytes = 256 * 1024;
const run = promisify(execFile);

export interface Clone {
  readonly dir: string;
  readonly commit: string;
}

// The server clones with its own git setup, so only remote https and ssh
// URLs are taken, with no stored credentials. The clone is removed after use.
export async function withClone<T>(
  url: string,
  work: (clone: Clone) => Promise<T> | T,
): Promise<T> {
  if (!/^(https:\/\/|ssh:\/\/)[^\s]+$/.test(url)) {
    throw new InvalidProfile("url must be an https:// or ssh:// git URL");
  }

  const dir = await mkdtemp(join(tmpdir(), "pipoca-profile-"));
  try {
    const git = async (args: readonly string[]): Promise<string> =>
      (
        await run(
          "git",
          [
            "-c",
            "protocol.allow=never",
            "-c",
            "protocol.https.allow=always",
            "-c",
            "protocol.ssh.allow=always",
            "-c",
            "credential.helper=",
            ...args,
          ],
          {
            timeout: gitTimeoutMs,
            env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
          },
        )
      ).stdout;

    await git(["clone", "--depth", "1", "--", url, dir]).catch(() => {
      throw new InvalidProfile(`could not clone ${url}`);
    });

    const commit = (await git(["-C", dir, "rev-parse", "HEAD"])).trim();

    return await work({ dir, commit });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// What a clone's pipoca.json lists of one kind, or nothing without one.
// Throws InvalidProfile for a manifest that isn't valid.
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
    throw new InvalidProfile(`${manifestFile} must be a small file`);
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new InvalidProfile(`${manifestFile} is not JSON`);
  }

  const entries = isRecord(manifest) ? manifest[kind] : undefined;

  if (entries === undefined) {
    return [];
  }

  if (!Array.isArray(entries)) {
    throw new InvalidProfile(`${kind} in ${manifestFile} must be a list`);
  }

  return entries.map((entry: unknown) => {
    if (
      !isRecord(entry) ||
      typeof entry["name"] !== "string" ||
      entry["name"].trim() === "" ||
      typeof entry["path"] !== "string"
    ) {
      throw new InvalidProfile(
        `each entry of ${kind} in ${manifestFile} needs a name and a path`,
      );
    }

    return { name: entry["name"].trim(), path: folderPath(entry["path"]) };
  });
}

// The files of a folder in the clone, which must stay inside it.
export function folderFiles(
  dir: string,
  path: string,
): ReadonlyMap<string, Buffer> {
  const root = realpathSync(dir);
  const folder = join(root, folderPath(path));
  const info = lstatSync(folder, { throwIfNoEntry: false });

  if (
    info?.isDirectory() !== true ||
    !(realpathSync(folder) + sep).startsWith(root + sep)
  ) {
    throw new InvalidProfile(`${path} is not a folder in the repository`);
  }

  return new Map(
    folderEntries(folder).map(({ path: file }) => [
      file,
      readFileSync(join(folder, file)),
    ]),
  );
}

// A small file in the clone, which must stay inside it.
export function repositoryFile(dir: string, path: string): string {
  const root = realpathSync(dir);
  const file = join(root, folderPath(path));
  const info = lstatSync(file, { throwIfNoEntry: false });

  if (
    info?.isFile() !== true ||
    info.size > maxManifestBytes ||
    !realpathSync(file).startsWith(root + sep)
  ) {
    throw new InvalidProfile(`${path} is not a small file in the repository`);
  }

  return readFileSync(file, "utf8");
}

function folderPath(path: string): string {
  const relative = normalize(path.trim()).replace(/\/+$/, "") || ".";

  if (isAbsolute(relative) || relative.split(sep).includes("..")) {
    throw new InvalidProfile(`${path} must be a folder inside the repository`);
  }

  return relative;
}
