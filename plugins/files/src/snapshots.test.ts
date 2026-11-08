import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type PluginTest,
  person,
  testPlugin,
  testSession,
} from "@pipoca/testing";
import { until } from "@pipoca/testing/until";
import { server } from "./server";
import { session } from "./session";

const tests: PluginTest[] = [];

beforeEach(() => {
  process.env["PIPOCA_WORKSPACE"] = "pod";
});

afterEach(async () => {
  delete process.env["PIPOCA_WORKSPACE"];
  await Promise.all(tests.splice(0).map(async (each) => each.close()));
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Ana",
      GIT_AUTHOR_EMAIL: "ana@example.com",
      GIT_COMMITTER_NAME: "Ana",
      GIT_COMMITTER_EMAIL: "ana@example.com",
    },
  }).trimEnd();
}

// A remote with one commit, and the Session's host.
async function setUp(config: Readonly<Record<string, unknown>> = {}) {
  const t = await testPlugin(server, {
    people: [{ id: "ana", name: "Ana" }],
    config,
  });

  tests.push(t);
  const host = await t.session({ owner: person("ana") });
  const remote = await mkdtemp(join(tmpdir(), "remote-"));
  const seed = await mkdtemp(join(tmpdir(), "seed-"));

  git(remote, "init", "--quiet", "--bare", "--initial-branch=main");
  git(seed, "clone", "--quiet", remote, ".");
  await writeFile(join(seed, ".gitignore"), "node_modules/\n");
  await writeFile(join(seed, "README.md"), "hello\n");
  await writeFile(join(seed, "old.txt"), "old\n");
  git(seed, "add", ".");
  git(seed, "commit", "--quiet", "-m", "first");
  git(seed, "push", "--quiet", "origin", "main");

  // A pod: a fresh clone and the Session part on it.
  const pod = async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pod-"));

    git(cwd, "clone", "--quiet", remote, ".");

    const part = await testSession(session, {
      cwd,
      config,
      checkouts: [{ path: cwd, base: git(cwd, "rev-parse", "HEAD") }],
      request: async (path, init) => host.api.raw(path, init),
    });

    const pi = { sessionManager: { getBranch: () => [] } };

    const start = async () => {
      await part.event("session_start", {}, pi);
      await part.event("before_agent_start", {}, pi);
    };

    return { cwd, part, start };
  };

  return { host, pod };
}

test("a new pod gets back the unfinished work the last one had", async () => {
  const { pod } = await setUp();
  const first = await pod();

  await first.start();
  await writeFile(join(first.cwd, "README.md"), "hello, world\n");
  git(first.cwd, "commit", "--quiet", "-am", "not pushed");
  await writeFile(join(first.cwd, "new.txt"), "new\n");
  await rm(join(first.cwd, "old.txt"));
  await writeFile(join(first.cwd, "README.md"), "hello, world!\n");
  await mkdir(join(first.cwd, "node_modules"));
  await writeFile(join(first.cwd, "node_modules", "dep.js"), "ignored\n");
  await first.part.event("agent_settled");
  await first.part.event("session_shutdown");

  const second = await pod();

  await second.start();

  expect(git(second.cwd, "log", "-1", "--format=%s")).toBe("not pushed");

  expect(await readFile(join(second.cwd, "README.md"), "utf8")).toBe(
    "hello, world!\n",
  );

  expect(await readFile(join(second.cwd, "new.txt"), "utf8")).toBe("new\n");

  expect(git(second.cwd, "status", "--porcelain").split("\n").sort()).toEqual(
    [" D old.txt", " M README.md", "?? new.txt"].sort(),
  );

  expect(
    await readFile(join(second.cwd, "node_modules", "dep.js"), "utf8").catch(
      () => null,
    ),
  ).toBeNull();
});

test("a checkout with nothing unfinished leaves no snapshot", async () => {
  const { pod } = await setUp();
  const first = await pod();

  await first.start();
  await writeFile(join(first.cwd, "new.txt"), "new\n");
  await first.part.event("agent_settled");
  await rm(join(first.cwd, "new.txt"));
  await first.part.event("session_shutdown");

  const second = await pod();

  await second.start();

  expect(git(second.cwd, "status", "--porcelain")).toBe("");
});

test("a snapshot over the limit isn't kept, and the Session says why", async () => {
  const { host, pod } = await setUp({ snapshots: { maxBytes: 10 } });
  const first = await pod();

  await first.start();
  await writeFile(join(first.cwd, "new.txt"), "new\n");
  await first.part.event("session_shutdown");
  await until(() => host.delivered().length === 1);

  expect(host.delivered()[0]?.text).toContain(
    "more than the 10 B kept when a pod exits",
  );

  const second = await pod();

  await second.start();

  expect(git(second.cwd, "status", "--porcelain")).toBe("");
});

test("off a pod, the work stays where it is and isn't sent", async () => {
  delete process.env["PIPOCA_WORKSPACE"];
  const { pod } = await setUp();
  const first = await pod();

  await first.start();
  await writeFile(join(first.cwd, "new.txt"), "new\n");
  await first.part.event("session_shutdown");
  process.env["PIPOCA_WORKSPACE"] = "pod";

  const second = await pod();

  await second.start();

  expect(git(second.cwd, "status", "--porcelain")).toBe("");
});
