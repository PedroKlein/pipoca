import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type PluginTest,
  person,
  type TestSession,
  testPlugin,
  testSession,
} from "@pipoca/testing";
import { until } from "@pipoca/testing/until";
import type { FolderFile, FolderWrite, ProjectView } from "./model";
import { server } from "./server";
import { session } from "./session";

const people = [
  { id: "ana", name: "ana", admin: true },
  { id: "bo", name: "bo" },
];

// cwd is the workspace, and the plugin's folder for the Session too.
async function part(
  host: TestSession,
  cwd: string,
  asked: string[] = [],
  answer: "once" | "deny" = "once",
) {
  return testSession(session, {
    request: host.api.raw,
    cwd,
    folder: cwd,
    config: { maxFileBytes: 1024 },
    askPermission: async (question) => {
      asked.push(question);

      return Promise.resolve(answer);
    },
  });
}

async function shop(
  t: PluginTest,
): Promise<{ coordinator: TestSession; projectId: string }> {
  const environment = await t.environment({ owner: person("ana") });

  const made = await t.as("ana").post<ProjectView>("projects", {
    name: "Shop",
    repositories: ["https://example.com/shop.git"],
    environment: environment.id,
  });

  return {
    coordinator: await t.attach(made.coordinatorId),
    projectId: made.id,
  };
}

async function threadOf(
  t: PluginTest,
  coordinator: TestSession,
  title: string,
): Promise<TestSession> {
  const answer = await t.tool(
    "start_thread",
    { title, message: `Do ${title}` },
    { session: coordinator },
  );

  return t.attach(/as (\S+)\.$/.exec(answer.text)?.[1] ?? "");
}

const folders: string[] = [];

afterEach(async () => {
  await Promise.all(
    folders
      .splice(0)
      .map(async (each) => rm(each, { recursive: true, force: true })),
  );
});

async function runnerFolder(): Promise<string> {
  const made = await mkdtemp(join(tmpdir(), "projects-folder-"));

  folders.push(made);

  return made;
}

async function contentOf(path: string): Promise<string | undefined> {
  return readFile(path, "utf8").catch(() => undefined);
}

test("Sessions in a Project share its folder, and a change one makes reaches the others before their turn", async () => {
  await using t = await testPlugin(server, { people });
  const { coordinator, projectId } = await shop(t);
  const thread = await threadOf(t, coordinator, "Docs");
  const here = await runnerFolder();
  const there = await runnerFolder();
  const a = await part(coordinator, here);
  const b = await part(thread, there);

  const filesOf = async (): Promise<readonly FolderFile[]> =>
    (
      await t
        .as("ana")
        .get<{ files: FolderFile[] }>(`projects/${projectId}/files`)
    ).files;

  await a.event("session_start");
  await b.event("session_start");
  await mkdir(join(here, "project", "notes"), { recursive: true });
  await writeFile(join(here, "project", "notes", "plan.md"), "one\n");
  await a.event("agent_settled");

  await until(async () => (await filesOf()).length === 1);

  await b.event("before_agent_start");

  expect(
    await until(async () =>
      contentOf(join(there, "project", "notes", "plan.md")),
    ),
  ).toBe("one\n");

  await rm(join(there, "project", "notes", "plan.md"));
  await b.event("agent_settled");
  await until(async () => (await filesOf()).length === 0);
  await a.event("before_agent_start");

  await until(
    async () =>
      (await contentOf(join(here, "project", "notes", "plan.md"))) ===
      undefined,
  );

  expect(await a.tool("list_project_files", { query: "" })).toMatchObject({
    text: "No files match.",
  });

  await a.event("session_shutdown");
  await b.event("session_shutdown");
});

test("a file another Session just shared can be read as soon as list_project_files names it", async () => {
  await using t = await testPlugin(server, { people });
  const { coordinator, projectId } = await shop(t);
  const thread = await threadOf(t, coordinator, "Docs");
  const here = await runnerFolder();
  const there = await runnerFolder();
  const a = await part(coordinator, here);
  const b = await part(thread, there);

  await a.event("session_start");
  await b.event("session_start");
  await mkdir(join(there, "project"), { recursive: true });
  await writeFile(join(there, "project", "report.md"), "found\n");
  await b.event("agent_settled");

  await until(
    async () =>
      (
        await t
          .as("ana")
          .get<{ files: FolderFile[] }>(`projects/${projectId}/files`)
      ).files.length === 1,
  );

  const listed = await a.tool("list_project_files", { query: "report" });

  expect(listed.text).toContain(join(here, "project", "report.md"));
  expect(await contentOf(join(here, "project", "report.md"))).toBe("found\n");

  await a.event("session_shutdown");
  await b.event("session_shutdown");
});

test("when two Sessions change one file, the later one is kept as a copy named after its thread", async () => {
  await using t = await testPlugin(server, { people });
  const { coordinator, projectId } = await shop(t);
  const thread = await threadOf(t, coordinator, "Docs");
  const here = await runnerFolder();
  const there = await runnerFolder();
  const a = await part(coordinator, here);
  const b = await part(thread, there);

  await mkdir(join(here, "project"), { recursive: true });
  await writeFile(join(here, "project", "notes.md"), "one\n");
  await a.event("session_shutdown");

  await b.event("session_start");
  await until(async () => contentOf(join(there, "project", "notes.md")));

  const again = await part(coordinator, here);

  await writeFile(join(here, "project", "notes.md"), "two\n");
  await again.event("session_shutdown");

  await writeFile(join(there, "project", "notes.md"), "three\n");
  await b.event("session_shutdown");

  expect(await contentOf(join(there, "project", "notes.md"))).toBe("two\n");

  expect(await contentOf(join(there, "project", "notes (from Docs).md"))).toBe(
    "three\n",
  );

  const { writes } = await t
    .as("ana")
    .get<{ writes: FolderWrite[] }>(`projects/${projectId}/log`);

  expect(writes[0]).toMatchObject({
    path: "notes (from Docs).md",
    conflict: true,
    actor: `session:${thread.id}`,
    by: "Docs",
  });

  expect(
    await again.tool("list_project_files", { query: "docs" }),
  ).toMatchObject({
    text: `${join(here, "project", "notes (from Docs).md")} (6 B)`,
  });
});

test("only Sessions in a Project get its folder", async () => {
  await using t = await testPlugin(server, { people });
  const elsewhere = await t.session({ owner: person("ana") });
  const outside = await part(elsewhere, await runnerFolder());

  expect(outside.tool("list_project_files", { query: "" })).rejects.toThrow(
    "projects has no tool list_project_files",
  );
});

test("the person's assistant is a Project of their own, outside the Project list", async () => {
  await using t = await testPlugin(server, { people });
  await t.environment({ owner: person("ana") });

  const assistant = await t
    .as("ana")
    .post<ProjectView>("assistant", { text: "What can you do?" });

  expect(assistant).toMatchObject({ assistant: true, repositories: [] });
  expect(await t.as("ana").get("projects")).toEqual([]);

  expect((await t.as("bo").raw("assistant", { method: "GET" })).status).toBe(
    404,
  );

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

async function assistantThread(
  t: PluginTest,
  personId: string,
): Promise<TestSession> {
  await t.environment({ owner: person(personId) });

  const assistant = await t
    .as(personId)
    .post<ProjectView>("assistant", { text: "Build me a plugin" });

  const started = await t.tool(
    "start_thread",
    { title: "Hello plugin", message: "Build a hello plugin" },
    { session: await t.attach(assistant.coordinatorId) },
  );

  return t.attach(/as (\S+)\.$/.exec(started.text)?.[1] ?? "");
}

test("installing asks the person, and only an admin's thread installs a plugin", async () => {
  await using t = await testPlugin(server, { people });
  const folder = await mkdtemp(join(tmpdir(), "projects-install-asks-"));

  try {
    await writeFile(join(folder, "AGENTS.md"), "Be brief.\n");
    const thread = await assistantThread(t, "ana");
    const asked: string[] = [];

    expect(
      await (
        await part(thread, folder, asked)
      ).tool("install_profile", { path: ".", name: "Brief" }),
    ).toMatchObject({ isError: false });

    expect(asked).toEqual(["Install . as a new Profile?"]);

    expect(
      await (
        await part(thread, folder, [], "deny")
      ).tool("install_profile", { path: ".", name: "Denied" }),
    ).toEqual({ text: "The person said no.", isError: true });

    const unasked = await thread.api.raw("install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "profile", files: {}, name: "Unasked" }),
    });

    expect(await unasked.json()).toMatchObject({
      isError: true,
      text: expect.stringContaining("asks the person first") as unknown,
    });

    const profiles = await t
      .as("ana")
      .get<readonly { readonly name: string }[]>("/api/profiles");

    expect(profiles.map(({ name }) => name)).toContain("Brief");
    expect(profiles.map(({ name }) => name)).not.toContain("Denied");
    expect(profiles.map(({ name }) => name)).not.toContain("Unasked");

    const theirs = await part(await assistantThread(t, "bo"), folder);

    expect(
      await theirs.tool("install_plugin", { path: ".", plugin: "hello" }),
    ).toMatchObject({
      isError: true,
      text: expect.stringContaining("Only admins install plugins.") as unknown,
    });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("in the assistant a tool without hints asks first, and Pi's own and hinted tools don't", async () => {
  await using t = await testPlugin(server, { people });
  await t.environment({ owner: person("ana") });
  const folder = await mkdtemp(join(tmpdir(), "projects-hints-"));

  try {
    const assistant = await t
      .as("ana")
      .post<ProjectView>("assistant", { text: "Hi" });

    const asked: string[] = [];
    const coordinator = await t.attach(assistant.coordinatorId);
    const tools = await part(coordinator, folder, asked);

    expect(
      await tools.toolCall({ name: "linear_create_issue" }, { title: "x" }),
    ).toBeUndefined();

    await tools.toolCall({ name: "read" }, { path: "a" });
    await tools.toolCall({ name: "tool_search" }, { query: "a" });

    await tools.toolCall(
      { name: "linear_list", annotations: { readOnlyHint: true } },
      {},
    );

    await tools.toolCall(
      { name: "linear_comment", annotations: { destructiveHint: false } },
      {},
    );

    expect(asked).toEqual(["Let the assistant run “linear create issue”?"]);

    const refused = await part(coordinator, folder, [], "deny");

    expect(
      await refused.toolCall({ name: "linear_create_issue" }, { title: "x" }),
    ).toBe("The person didn't allow linear_create_issue.");

    const { coordinator: ordinary } = await shop(t);
    const outside: string[] = [];

    await (
      await part(ordinary, folder, outside)
    ).toolCall({ name: "linear_create_issue" }, { title: "x" });

    expect(outside).toEqual([]);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
