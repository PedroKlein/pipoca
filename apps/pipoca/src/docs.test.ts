import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionDocs } from "./docs";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "docs-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const text = (content: string | undefined): string =>
  Buffer.from(content ?? "", "base64").toString();

test("holds Pipoca's and Pi's docs, and each plugin's own docs by its id", async () => {
  const folder = join(root, "deploys");
  await mkdir(join(folder, "docs", "howto"), { recursive: true });
  await writeFile(join(folder, "docs", "howto", "deploy.md"), "# Deploying");
  await writeFile(join(folder, "docs", "notes.txt"), "not docs");
  await writeFile(join(root, "secret.md"), "server secret");
  await symlink(join(root, "secret.md"), join(folder, "docs", "linked.md"));

  const { files, hash } = sessionDocs([
    { id: "deploys", folder },
    { id: "bare", folder: join(root, "bare") },
  ]);

  expect(text(files["pipoca/guide.md"])).toContain("Pipoca");
  expect(files["pi/README.md"]).toBeDefined();
  expect(files["pipoca/open-questions.md"]).toBeUndefined();
  expect(text(files["plugins/deploys/howto/deploy.md"])).toBe("# Deploying");

  expect(
    Object.keys(files).filter((path) => path.startsWith("plugins/")),
  ).toEqual(["plugins/deploys/howto/deploy.md"]);

  expect(sessionDocs([]).hash).not.toBe(hash);
});
