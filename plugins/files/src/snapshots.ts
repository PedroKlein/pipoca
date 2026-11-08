import { execFile } from "node:child_process";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import type { Checkout, SessionContext } from "@pipoca/plugins";
import type { files } from "../plugin";
import { type SnapshotChange, shownChanges } from "./files";

const exec = promisify(execFile);

// The ref a snapshot's commit travels under, in its bundle and after.
const ref = "refs/pipoca/snapshot";

type Context = Pick<
  SessionContext<typeof files>,
  "api" | "blobs" | "config" | "folder" | "log"
>;

interface Saved {
  readonly checkout: string;
  readonly hash: string;
  readonly size: number;
  readonly changes: readonly SnapshotChange[];
  readonly changed: number;
}

const changeOf: Readonly<Record<string, SnapshotChange["change"]>> = {
  A: "new",
  D: "deleted",
};

// On a pod that loses its disk when it exits, each checkout's unfinished
// work, its commits no remote has and its changed and new files that
// .gitignore doesn't exclude, is kept on the server as a git bundle of one
// commit. The next pod's clone has none of it, so it gets the bundle back
// (ADR 0078).
export function snapshots(s: Context): {
  readonly save: (cwd: string, checkouts: readonly Checkout[]) => void;
  readonly restore: (cwd: string, checkouts: readonly Checkout[]) => void;
  readonly restored: () => Promise<void>;
  readonly flush: () => Promise<void>;
} {
  let saving = Promise.resolve();
  let restoring = Promise.resolve();
  let queued = false;

  const git = async (
    path: string,
    args: readonly string[],
    env: Readonly<Record<string, string>> = {},
  ): Promise<string> =>
    (
      await exec("git", ["-C", path, ...args], {
        env: { ...process.env, ...env },
        maxBuffer: 16 * 1024 * 1024,
      })
    ).stdout.trim();

  const keyOf = (cwd: string, checkout: Checkout): string =>
    relative(cwd, checkout.path) || ".";

  // A commit of the working tree on top of HEAD, with the files it changes,
  // or undefined when there's nothing a remote doesn't have.
  const snapshotCommit = async (
    path: string,
  ): Promise<
    | { readonly commit: string; readonly changes: readonly SnapshotChange[] }
    | undefined
  > => {
    const index = join(s.folder, "snapshot.index");
    const env = { GIT_INDEX_FILE: index };

    await mkdir(s.folder, { recursive: true });
    await rm(index, { force: true });
    await git(path, ["read-tree", "HEAD"], env);
    await git(path, ["add", "--all"], env);
    const tree = await git(path, ["write-tree"], env);
    await rm(index, { force: true });

    const changed = tree !== (await git(path, ["rev-parse", "HEAD^{tree}"]));

    const unpushed =
      (await git(path, ["rev-list", "-1", "HEAD", "--not", "--remotes"])) !==
      "";

    if (!changed && !unpushed) {
      return undefined;
    }

    const changes = (
      await git(path, [
        "-c",
        "core.quotePath=false",
        "diff-tree",
        "-r",
        "--name-status",
        "HEAD",
        tree,
      ])
    )
      .split("\n")
      .filter(Boolean)
      .map((line): SnapshotChange => {
        const [status = "", ...name] = line.split("\t");

        return {
          path: name.join("\t"),
          change: changeOf[status.charAt(0)] ?? "changed",
        };
      });

    const commit = await git(
      path,
      ["commit-tree", tree, "-p", "HEAD", "-m", "snapshot"],
      {
        GIT_AUTHOR_NAME: "Pipoca",
        GIT_AUTHOR_EMAIL: "pipoca@localhost",
        GIT_COMMITTER_NAME: "Pipoca",
        GIT_COMMITTER_EMAIL: "pipoca@localhost",
      },
    );

    return { commit, changes };
  };

  const saveAll = async (
    cwd: string,
    checkouts: readonly Checkout[],
  ): Promise<void> => {
    queued = false;
    const limit = s.config.snapshots.maxBytes;
    const saved: Saved[] = [];
    const skipped: { checkout: string; size: number }[] = [];

    for (const each of checkouts) {
      const checkout = keyOf(cwd, each);
      const made = await snapshotCommit(each.path);

      if (made === undefined) {
        continue;
      }

      const { commit, changes } = made;

      const bundle = join(s.folder, "snapshot.bundle");

      await git(each.path, ["update-ref", ref, commit]);

      await git(each.path, [
        "bundle",
        "create",
        bundle,
        ref,
        "--not",
        "--remotes",
      ]);

      const { size } = await stat(bundle);

      if (size > limit) {
        skipped.push({ checkout, size });

        continue;
      }

      const { hash } = await s.blobs.upload(bundle);

      saved.push({
        checkout,
        hash,
        size,
        changes: changes.slice(0, shownChanges),
        changed: changes.length,
      });
    }

    await s.api.put("session/snapshot", { checkouts: saved, skipped });

    s.log("unfinished work saved", {
      saved: saved.length,
      skipped: skipped.length,
    });
  };

  const restoreOne = async (path: string, checkout: string): Promise<void> => {
    const response = await s.api.raw(
      `session/snapshot/file?checkout=${encodeURIComponent(checkout)}`,
    );

    if (!response.ok) {
      throw new Error(`the server answered ${String(response.status)}`);
    }

    const bundle = join(s.folder, "snapshot.bundle");

    await writeFile(bundle, new Uint8Array(await response.arrayBuffer()));
    await git(path, ["fetch", "--quiet", bundle, `${ref}:${ref}`]);
    // The branch takes the snapshot's commits, the working tree its files,
    // and the index stays at the branch, so new files stay untracked.
    await git(path, ["reset", "--quiet", "--hard", `${ref}^`]);
    await git(path, ["read-tree", "-u", "--reset", ref]);
    await git(path, ["reset", "--quiet"]);
  };

  const restoreAll = async (
    cwd: string,
    checkouts: readonly Checkout[],
  ): Promise<void> => {
    const { checkouts: kept } = await s.api.get<{ checkouts: Saved[] }>(
      "session/snapshot",
    );

    for (const each of checkouts) {
      const checkout = keyOf(cwd, each);

      // A checkout that has work of its own kept it, so the snapshot is
      // older than what's there.
      if (
        !kept.some((one) => one.checkout === checkout) ||
        (await snapshotCommit(each.path)) !== undefined
      ) {
        continue;
      }

      try {
        await restoreOne(each.path, checkout);
        s.log("unfinished work restored", { checkout });
      } catch (error) {
        s.log("unfinished work not restored", {
          checkout,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  const failed =
    (what: string) =>
    (error: unknown): void => {
      s.log(what, {
        error: error instanceof Error ? error.message : String(error),
      });
    };

  return {
    save: (cwd, checkouts) => {
      if (queued) {
        return;
      }

      queued = true;

      saving = saving
        .then(async () => restoring)
        .then(async () => saveAll(cwd, checkouts))
        .catch(failed("unfinished work not saved"));
    },
    restore: (cwd, checkouts) => {
      restoring = restoreAll(cwd, checkouts).catch(
        failed("unfinished work not restored"),
      );
    },
    restored: async () => restoring,
    flush: async () => saving,
  };
}
