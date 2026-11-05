import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpError, type TypedClient } from "@pipoca/plugins";
import {
  type PluginTest,
  person,
  type TestSession,
  testPlugin,
  testSession,
} from "@pipoca/testing";
import type { ProjectView } from "./model";
import { server } from "./server";
import { session } from "./session";

const people = [
  { id: "ana", name: "ana", admin: true },
  { id: "bo", name: "bo" },
];

// The Session part's requests, answered by the plugin's real routes.
function routed(api: TypedClient) {
  return async (path: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET";

    const body: unknown =
      typeof init?.body === "string" ? JSON.parse(init.body) : undefined;

    try {
      const answer: unknown = await (method === "GET"
        ? api.get(path)
        : api[method === "PUT" ? "put" : "post"](path, body));

      return Response.json(answer ?? null);
    } catch (error) {
      if (error instanceof HttpError) {
        return Response.json(
          { message: error.message },
          { status: error.status },
        );
      }

      throw error;
    }
  };
}

async function part(host: TestSession, cwd: string) {
  return testSession(session, {
    request: routed(host.api),
    cwd,
    config: { fileLimitMb: 1 },
    askPermission: async () => Promise.resolve("once" as const),
  });
}

async function project(t: PluginTest): Promise<TestSession> {
  const environment = await t.environment({ owner: person("ana") });

  const made = await t.as("ana").post<ProjectView>("projects", {
    name: "Shop",
    repositories: ["https://example.com/shop.git"],
    environment: environment.id,
  });

  return t.attach(made.coordinatorId);
}

test("Sessions in a Project share files through its library, and others get no file tools", async () => {
  await using t = await testPlugin(server, { people });
  const folder = await mkdtemp(join(tmpdir(), "projects-library-"));

  try {
    const coordinator = await project(t);
    const inProject = await part(coordinator, folder);

    await writeFile(join(folder, "notes.md"), "# Notes\n");

    expect(
      await inProject.tool("publish_file", { path: "notes.md" }),
    ).toMatchObject({
      text: "Published notes.md as notes.md (8 bytes).",
      isError: false,
    });

    expect(await inProject.tool("list_library", {})).toMatchObject({
      text: expect.stringContaining(
        `notes.md · 8 bytes · session:${coordinator.id}`,
      ) as unknown,
    });

    expect(
      await inProject.tool("fetch_file", {
        name: "notes.md",
        path: "copy/n.md",
      }),
    ).toMatchObject({ isError: false });

    expect(await readFile(join(folder, "copy/n.md"), "utf8")).toBe("# Notes\n");

    expect(
      await inProject.tool("publish_file", { path: "notes.md", name: "a/b" }),
    ).toMatchObject({
      isError: true,
      text: expect.stringContaining("file names") as unknown,
    });

    const elsewhere = await t.session({ owner: person("ana") });
    const outside = await part(elsewhere, folder);

    expect(outside.tool("list_library", {})).rejects.toThrow(
      "projects has no tool list_library",
    );
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("the person's assistant is a Project of their own, outside the Project list", async () => {
  await using t = await testPlugin(server, { people });
  await t.environment({ owner: person("ana") });

  const assistant = await t
    .as("ana")
    .post<ProjectView>("assistant", { text: "What can you do?" });

  expect(assistant).toMatchObject({ assistant: true, repositories: [] });
  expect(await t.as("ana").get("projects")).toEqual([]);
  expect((await t.as("bo").raw("GET", "assistant")).status).toBe(404);

  const again = await t
    .as("ana")
    .post<ProjectView>("assistant", { text: "And more?" });

  expect(again.id).toBe(assistant.id);

  const coordinator = await t.attach(assistant.coordinatorId);

  expect(coordinator.delivered().map(({ text }) => text)).toContain(
    "And more?",
  );
});

test("assistant threads load route tools and install what they built", async () => {
  await using t = await testPlugin(server, { people });
  await t.environment({ owner: person("ana") });
  const folder = await mkdtemp(join(tmpdir(), "projects-install-"));

  try {
    const assistant = await t
      .as("ana")
      .post<ProjectView>("assistant", { text: "Build me a plugin" });

    const coordinator = await t.attach(assistant.coordinatorId);

    const started = await t.tool(
      "start_thread",
      { title: "Hello plugin", message: "Build a hello plugin" },
      { session: coordinator },
    );

    const thread = await t.attach(/as (\S+)\.$/.exec(started.text)?.[1] ?? "");

    expect(
      await t.tool("projects_get", { id: assistant.id }, { session: thread }),
    ).toMatchObject({
      isError: false,
      text: expect.stringContaining(assistant.id) as unknown,
    });

    await writeFile(join(folder, "AGENTS.md"), "Be brief.\n");

    const tools = await part(thread, folder);

    expect(
      await tools.tool("install_profile", { path: ".", name: "Brief" }),
    ).toMatchObject({
      isError: false,
      text: "Wrote 1 files into the Profile brief.",
    });

    const plugin = await tools.tool("install_plugin", {
      path: ".",
      plugin: "hello",
    });

    // It reached the kernel's plugin routes as the person; a test server
    // has no folder to write plugins into.
    expect(plugin).toMatchObject({
      isError: true,
      text: expect.stringMatching(
        /^AGENTS\.md: .*no plugins folder/,
      ) as unknown,
    });

    const ordinary = await t.attach(
      (
        await t.as("ana").post<ProjectView>("projects", {
          name: "Shop",
          repositories: ["https://example.com/shop.git"],
          environment: (await t.environment({ owner: person("ana") })).id,
        })
      ).coordinatorId,
    );

    const outside = await part(ordinary, folder);

    expect(
      outside.tool("install_profile", { path: ".", name: "Brief" }),
    ).rejects.toThrow("projects has no tool install_profile");
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
