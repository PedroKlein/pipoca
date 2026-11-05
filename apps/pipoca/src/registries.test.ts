import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { builtInPlugins } from "./built-in";
import { registryFiles } from "./registries";

const root = resolve(import.meta.dirname, "..", "..", "..");

test("the registries are the ones plugins/ makes now", async () => {
  for (const [path, content] of await registryFiles(root)) {
    expect(await readFile(join(root, path), "utf8"), path).toBe(content);
  }
});

test("the registry lists every plugin folder once", async () => {
  const folders = (
    await readdir(join(root, "plugins"), { withFileTypes: true })
  )
    .filter((entry) => entry.isDirectory())
    .map(({ name }) => name)
    .sort();

  expect(builtInPlugins.map(({ id }) => id)).toEqual(folders);
});

test("a defined plugin loads through its definition, and the web app imports its web part", async () => {
  const at = await mkdtemp(join(tmpdir(), "pipoca-registries-"));
  const folder = join(at, "plugins", "notes");
  await mkdir(join(folder, "web"), { recursive: true });

  await writeFile(
    join(folder, "package.json"),
    JSON.stringify({ pipoca: { entry: "plugin.ts" } }),
  );

  await writeFile(
    join(folder, "plugin.ts"),
    `export const notes = {
  id: "notes",
  title: "Notes",
  description: "Keeps notes",
  web: async () => import("./web/part"),
};
`,
  );

  await writeFile(join(folder, "web", "part.tsx"), "");

  const files = await registryFiles(at);

  expect(files.get("apps/pipoca/src/registry-server.ts")).toContain(
    'import { notes } from "../../../plugins/notes/plugin";',
  );

  expect(files.get("apps/pipoca/src/registry-session.ts")).not.toContain(
    "notes",
  );

  expect(files.get("apps/web/src/registry.ts")).toContain(
    'import * as notesWeb from "../../../plugins/notes/web/part";',
  );
});
