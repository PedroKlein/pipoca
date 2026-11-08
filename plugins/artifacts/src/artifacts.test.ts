import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type PluginTest,
  person,
  testPlugin,
  testSession,
} from "@pipoca/testing";
import type { ArtifactSummary, ArtifactView } from "./artifacts";
import { parseCsv } from "./render";
import { server } from "./server";
import { session } from "./session";

const tests: PluginTest[] = [];
const folders: string[] = [];

afterEach(async () => {
  await Promise.all(tests.splice(0).map(async (each) => each.close()));

  await Promise.all(
    folders
      .splice(0)
      .map(async (each) => rm(each, { recursive: true, force: true })),
  );
});

async function setUp() {
  const t = await testPlugin(server, {
    people: [
      { id: "ana", name: "Ana" },
      { id: "bo", name: "Bo" },
      { id: "cy", name: "Cy" },
    ],
  });

  tests.push(t);

  const host = await t.session({ owner: person("ana") });
  const cwd = await mkdtemp(join(tmpdir(), "artifacts-"));

  folders.push(cwd);

  const part = await testSession(session, {
    request: host.api.raw,
    cwd,
    folder: join(cwd, ".artifacts"),
  });

  return { t, host, cwd, part };
}

test("Pi publishes a file as an artifact and adds versions at the same link", async () => {
  const { t, cwd, part } = await setUp();

  await writeFile(join(cwd, "report.md"), "# Sales\n\nUp 4%.\n");

  const first = await part.tool("publish_artifact", {
    path: "report.md",
    title: "Sales report",
  });

  expect(first).toMatchObject({
    isError: false,
    details: { title: "Sales report", version: 1 },
  });

  const { id } = first.details as { id: string };

  await writeFile(join(cwd, "report.md"), "# Sales\n\nUp 5%.\n");

  expect(
    await part.tool("publish_artifact", { path: "report.md", id }),
  ).toMatchObject({ details: { id, version: 2 } });

  const artifact = await t.as("ana").get<ArtifactView>(`artifacts/${id}`);

  expect(artifact).toMatchObject({
    title: "Sales report",
    kind: "markdown",
    versions: 2,
    steers: true,
  });

  const latest = await t.as("ana").raw(`artifacts/${id}/view`, {
    method: "GET",
  });

  // A sandboxed page, which Pipoca's own pages may frame and no one else.
  expect(latest.headers.get("content-security-policy")).toStartWith(
    "sandbox allow-scripts",
  );

  expect(latest.headers.get("content-security-policy")).toEndWith(
    "; frame-ancestors 'self'",
  );

  expect(latest.headers.get("x-frame-options")).toBe("SAMEORIGIN");

  expect(await latest.text()).toContain("<h1>Sales</h1>\n<p>Up 5%.</p>");

  expect(
    await (
      await t.as("ana").raw(`artifacts/${id}/view?v=1`, { method: "GET" })
    ).text(),
  ).toContain("Up 4%.");

  expect(
    await t.as("ana").post(`artifacts/${id}/restore`, { version: 1 }),
  ).toEqual({ version: 3 });

  expect(
    await (
      await t.as("ana").raw(`artifacts/${id}/download`, { method: "GET" })
    ).text(),
  ).toBe("# Sales\n\nUp 4%.\n");
});

test("only files that can be shown are published", async () => {
  const { cwd, part } = await setUp();

  await writeFile(join(cwd, "notes.docx"), "x");

  expect(
    await part.tool("publish_artifact", { path: "notes.docx" }),
  ).toMatchObject({
    isError: true,
    text: expect.stringContaining("HTML, Markdown") as unknown,
  });
});

test("people who don't see the Session open an artifact only once it's shared with them", async () => {
  const { t, cwd, part } = await setUp();

  await writeFile(join(cwd, "page.html"), "<h1>Hi</h1>");

  const { details } = await part.tool("publish_artifact", {
    path: "page.html",
  });

  const { id } = details as { id: string };

  expect(
    (await t.as("bo").raw(`artifacts/${id}`, { method: "GET" })).status,
  ).toBe(404);

  expect(await t.as("bo").get("artifacts")).toEqual({ artifacts: [] });

  await t.as("ana").put(`artifacts/${id}/shares`, {
    shares: [{ name: "Bo", role: "view" }],
  });

  expect(await t.as("bo").get<ArtifactView>(`artifacts/${id}`)).toMatchObject({
    steers: false,
    shares: [{ userId: "bo", name: "Bo", role: "view" }],
  });

  expect(
    (
      await t.as("bo").raw(`artifacts/${id}/shares`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ shares: [{ name: "Cy", role: "view" }] }),
      })
    ).status,
  ).toBe(404);

  expect(
    (await t.as("cy").raw(`artifacts/${id}`, { method: "GET" })).status,
  ).toBe(404);
});

test("Pi finds artifacts by title and reads one back into its folder", async () => {
  const { cwd, part } = await setUp();

  await writeFile(join(cwd, "chart.svg"), "<svg/>");
  await writeFile(join(cwd, "plan.md"), "plan");

  await part.tool("publish_artifact", {
    path: "chart.svg",
    title: "Revenue chart",
  });

  const { details } = await part.tool("publish_artifact", {
    path: "plan.md",
    title: "Launch plan",
  });

  const { id } = details as ArtifactSummary;

  expect(await part.tool("list_artifacts", { query: "plan" })).toMatchObject({
    text: `${id} · Launch plan · markdown · 1 version`,
  });

  const read = await part.tool("read_artifact", { id });
  const path = join(cwd, ".artifacts", id, "v1", "plan.md");

  expect(read).toMatchObject({
    text: `Wrote version 1 of artifact ${id} to ${path}.`,
  });

  expect(await readFile(path, "utf8")).toBe("plan");
});

test("reads CSV fields with quotes, commas and newlines", () => {
  expect(parseCsv('a,b\n"x, y","say ""hi""\nthere"\r\n1,2\n')).toEqual([
    ["a", "b"],
    ["x, y", 'say "hi"\nthere'],
    ["1", "2"],
  ]);
});
