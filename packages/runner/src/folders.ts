import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GitLogin, Log, SessionStart } from "@pipoca/protocol";
import { syncFolder, syncProfile } from "@pipoca/sessionhost";
import { gitCredentials } from "@pipoca/workspaces";
import { fetchFolder } from "./client";
import type { MachineModels } from "./models";
import { type Binary, installPackageApart } from "./session-process";

export interface ProfileFolders {
  readonly dirs: () => Promise<readonly string[]>;
  // Brings the assignment's Profile folder up to date and gives it.
  readonly sync: (
    assignment: SessionStart,
    gitLogins: readonly GitLogin[],
    log: Log,
  ) => Promise<string>;
  // Every Profile that still exists. A deleted one's folder goes once no
  // Session uses it.
  readonly keep: (
    ids: readonly string[],
    inUse: (id: string) => boolean,
  ) => void;
}

// Agents of other servers may share the data directory, so only the server
// that first wrote Profile folders there deletes them.
export async function profileFolders(options: {
  readonly dataDir: string;
  readonly server: string;
  readonly binary: Binary;
  readonly models: MachineModels;
  readonly log: Log;
}): Promise<ProfileFolders> {
  const { models, log } = options;
  const root = join(options.dataDir, "profiles");
  const owned = await claimProfiles(root, options.server);

  // Sessions on one Profile share its folder, so its syncs run one at a time.
  const syncs = new Map<string, Promise<unknown>>();
  let kept: ReadonlySet<string> = new Set();
  let pruning: Promise<void> | undefined;

  const ids = async (): Promise<readonly string[]> =>
    (await readdir(root).catch(() => [])).filter((id) => !id.startsWith("."));

  const prune = async (deleted: (id: string) => boolean): Promise<void> => {
    let removed = 0;

    for (const id of await ids()) {
      if (!deleted(id)) {
        continue;
      }

      const dir = join(root, id);
      models.forget(dir);
      await rm(dir, { recursive: true, force: true });
      removed++;
      log("deleted profile folder removed", { profileId: id });
    }

    if (removed > 0) {
      void models.relist();
    }
  };

  return {
    dirs: async () => (await ids()).map((id) => join(root, id)),
    sync: async (assignment, gitLogins, sessionLog) => {
      const { profile } = assignment;
      const dir = join(root, profile.id);

      const synced = (syncs.get(profile.id) ?? Promise.resolve())
        .catch(() => undefined)
        .then(async () =>
          syncProfile(
            dir,
            profile.hash,
            async () => fetchFolder(options.server, assignment, "profile"),
            sessionLog,
            async (into, source) =>
              installPackageApart(options.binary, into, source, {
                ...process.env,
                ...gitCredentials(gitLogins, process.env),
              }).catch((error: unknown) => {
                throw new Error(
                  unconnectedHint(String(error), source, gitLogins),
                );
              }),
          ),
        );

      syncs.set(profile.id, synced);
      await synced;

      if (models.add(dir)) {
        void models.relist();
      }

      return dir;
    },
    keep: (existing, inUse) => {
      kept = new Set(existing);
      if (!owned || pruning) {
        return;
      }

      pruning = prune((id) => !kept.has(id) && !inUse(id))
        .catch((error: unknown) => {
          log("profile folders not pruned", { error: String(error) });
        })
        .finally(() => {
          pruning = undefined;
        });
    },
  };
}

// Every Session gets the server's docs (ADR 0052). They share one folder, so
// its syncs run one at a time.
export function docsFolder(
  dataDir: string,
  server: string,
): (assignment: SessionStart, log: Log) => Promise<string | undefined> {
  const dir = join(dataDir, "docs");
  let syncing: Promise<unknown> = Promise.resolve();

  return async (assignment, log) => {
    const { docs } = assignment;

    if (docs === undefined) {
      return undefined;
    }

    const synced = syncing
      .catch(() => undefined)
      .then(async () =>
        syncFolder(
          dir,
          docs,
          async () => fetchFolder(server, assignment, "docs"),
          log,
        ),
      );

    syncing = synced;
    await synced;

    return dir;
  };
}

async function claimProfiles(dir: string, server: string): Promise<boolean> {
  const marker = join(dir, ".server");

  const owner = await readFile(marker, "utf8").catch(async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(marker, server, { flag: "wx" }).catch(() => undefined);

    return readFile(marker, "utf8");
  });

  return owner === server;
}

// Pi reads a git package as git:host/path, an https or ssh URL, or
// git@host:path.
function unconnectedHint(
  error: string,
  source: string,
  logins: readonly GitLogin[],
): string {
  const host =
    /^(?:git:(?:git@)?|(?:https?|ssh):\/\/(?:[^@/]+@)?|git@)([^/:]+)/.exec(
      source,
    )?.[1];

  return host === undefined || logins.some((login) => login.host === host)
    ? error
    : `${error}. If the repository is private, connect ${host} in Settings, or for team work have an admin choose a bot for it in Git hosts`;
}
