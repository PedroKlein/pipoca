import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fetchSnapshot,
  InvalidRepository,
  latestCommit,
  listedIn,
  picked,
  repositoryFile,
  repositoryFolder,
  syncFollowers,
  withClone,
} from "./index";
import { gitHost } from "./testdata/git-host";

let root: string;
let repository: string;
let url: string;

function git(...args: string[]): string {
  return execFileSync("git", ["-C", repository, ...args], {
    encoding: "utf8",
  }).trim();
}

async function commit(
  files: Readonly<Record<string, string>>,
): Promise<string> {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(repository, path, ".."), { recursive: true });
    await writeFile(join(repository, path), text);
  }

  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "c");

  return git("rev-parse", "HEAD");
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "repositories-"));
  repository = join(root, "kit");
  url = `file://${repository}`;
  await mkdir(repository);
  git("init", "-q", "-b", "main");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("clones only https and ssh URLs without credentials, and file URLs where local sources are allowed", async () => {
  await commit({ "README.md": "hi" });

  for (const refused of [
    repository,
    "-u",
    "http://example.com/kit.git",
    "https://me:token@example.com/kit.git",
    url,
  ]) {
    expect(withClone(refused, () => undefined)).rejects.toBeInstanceOf(
      InvalidRepository,
    );
  }

  expect(
    await withClone(url, ({ dir }) => existsSync(join(dir, "README.md")), {
      local: true,
    }),
  ).toBe(true);
});

// A redirect would reach a host the server never checked.
test("doesn't follow a git host's redirect", async () => {
  await commit({ "README.md": "hi" });
  const served = join(root, "served");
  await mkdir(served);

  execFileSync("git", [
    "clone",
    "-q",
    "--bare",
    repository,
    join(served, "kit.git"),
  ]);

  const host = gitHost(served, { old: "kit" });

  try {
    expect(await withClone(host.url("kit"), () => "cloned")).toBe("cloned");

    expect(
      await withClone(host.url("old"), () => "cloned").catch(
        (error: unknown) => error,
      ),
    ).toBeInstanceOf(InvalidRepository);
  } finally {
    await host.stop();
  }
});

test("reads what a repository's manifest lists, and only folders inside it", async () => {
  const head = await commit({
    "pipoca.json": JSON.stringify({
      profiles: [{ name: " Web ", path: "profiles/web/" }],
      templates: [{ name: "Small", path: "../outside.json" }],
    }),
    "profiles/web/AGENTS.md": "be nice",
  });

  await withClone(
    url,
    ({ dir, commit: cloned }) => {
      const listed = listedIn(dir, "profiles");

      expect(cloned).toBe(head);
      expect(listed).toEqual([{ name: "Web", path: "profiles/web" }]);
      expect(picked(listed, ["profiles/web"])).toEqual(listed);
      expect(() => picked(listed, ["other"])).toThrow("doesn't list other");
      expect(() => listedIn(dir, "templates")).toThrow(InvalidRepository);
      expect(repositoryFile(dir, "profiles/web/AGENTS.md")).toBe("be nice");
      expect(repositoryFolder(dir, "profiles/web")).toEndWith("profiles/web");
      expect(() => repositoryFolder(dir, "profiles/web/AGENTS.md")).toThrow();
    },
    { local: true },
  );
});

test("fetches a snapshot at a ref, pinned to its commit, without history or links", async () => {
  const first = await commit({ "index.ts": "1" });
  git("tag", "v1");
  await commit({ "index.ts": "2" });

  const into = join(root, "snapshot");
  const pinned = await fetchSnapshot(`${url}#v1`, into);

  expect(pinned).toBe(first);
  expect(await readFile(join(into, "index.ts"), "utf8")).toBe("1");
  expect(existsSync(join(into, ".git"))).toBe(false);
  expect(await latestCommit(`${url}#v1`)).toBe(first);
  expect(await latestCommit(`${url}#nope`)).toBeUndefined();
  expect(await latestCommit("https://example.com/plugin.tgz")).toBeUndefined();

  await symlink("/etc/passwd", join(repository, "sneaky"));
  await commit({});

  expect(fetchSnapshot(url, join(root, "linked"))).rejects.toThrow(
    "holds a link, sneaky",
  );
});

test("syncs each follower whose repository moved on, one clone per repository", async () => {
  const old = await commit({ "a.txt": "1" });
  const head = await commit({ "a.txt": "2" });
  const served = join(root, "served");
  await mkdir(served);

  execFileSync("git", [
    "clone",
    "-q",
    "--bare",
    repository,
    join(served, "kit.git"),
  ]);

  const host = gitHost(served);
  const logs: string[] = [];
  const updates: string[] = [];

  const follower = (id: string, commitOf: string, path = "a.txt") => ({
    id,
    source: { url: host.url("kit"), path, commit: commitOf },
  });

  try {
    await syncFollowers(
      [
        follower("behind", old),
        follower("current", head),
        follower("broken", old, "missing.txt"),
        { id: "own", source: null },
        {
          id: "gone",
          source: { url: host.url("gone"), path: ".", commit: old },
        },
      ],
      {
        kind: "template",
        log: (message, fields) => {
          logs.push(`${message} ${JSON.stringify(fields)}`);
        },
        update: (each, { dir }, source) => {
          updates.push(
            `${each.id} ${repositoryFile(dir, source.path)} ${source.commit}`,
          );
        },
      },
    );
  } finally {
    await host.stop();
  }

  expect(updates).toEqual([`behind 2 ${head}`]);
  expect(logs[0]).toBe('templates syncing {"templates":4,"repositories":2}');

  expect(logs.at(-1)).toBe(
    'templates synced {"checked":4,"changed":1,"failed":2}',
  );
});
