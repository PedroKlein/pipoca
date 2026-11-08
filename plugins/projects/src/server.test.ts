import { expect, test } from "bun:test";
import { definePlugin, defineServer } from "@pipoca/plugins";
import { blobRoutes } from "@pipoca/protocol";
import {
  type PluginTest,
  person,
  type TestSession,
  testPlugin,
  until,
} from "@pipoca/testing";
import type { FolderWrite, ProjectView } from "./model";
import { server } from "./server";

const people = [
  { id: "ana", name: "ana", admin: true },
  { id: "bo", name: "bo" },
];

const repository = "https://example.com/shop.git";

interface Started {
  readonly t: PluginTest;
  readonly project: ProjectView;
  readonly coordinator: TestSession;
}

async function started(o: { team?: boolean } = {}): Promise<Started> {
  const t = await testPlugin(server, { people });
  const owner = o.team === true ? "team" : person("ana");
  const environment = await t.environment({ owner });

  const project = await t
    .as("ana")
    .post<ProjectView>(o.team === true ? "team/projects" : "projects", {
      name: "Shop",
      repositories: [repository],
      environment: environment.id,
      ...(o.team === true && { profile: "projects.builder" }),
    });

  return { t, project, coordinator: await t.attach(project.coordinatorId) };
}

async function threadOf(
  { t, coordinator }: Started,
  title: string,
): Promise<TestSession> {
  const answer = await t.tool(
    "start_thread",
    { title, message: `Do ${title}` },
    { session: coordinator },
  );

  const id = /as (\S+)\.$/.exec(answer.text)?.[1] ?? "";

  return t.attach(id);
}

const reply = (text: string): unknown => ({
  type: "message",
  message: { role: "assistant", content: [{ type: "text", text }] },
});

const asked = (text: string): unknown => ({
  type: "message",
  message: { role: "user", content: text },
});

test("a Project starts its coordinator, which starts threads with the brief as its own", async () => {
  const s = await started();
  await using _ = s.t;

  expect(s.project).toMatchObject({
    name: "Shop",
    repositories: [repository],
    team: false,
    assistant: false,
    threads: [],
  });

  const thread = await threadOf(s, "Docs");

  expect(thread.delivered()).toEqual([
    {
      text: "Do Docs",
      turn: true,
      notice: {
        kind: "coordinator_message",
        plugin: "projects",
        data: { text: "Do Docs" },
      },
    },
  ]);

  expect(
    (await s.t.as("ana").get<ProjectView>(`projects/${s.project.id}`)).threads,
  ).toMatchObject([{ sessionId: thread.id, title: "Docs" }]);

  expect(
    (await s.t.as("bo").raw(`projects/${s.project.id}`, { method: "GET" }))
      .status,
  ).toBe(404);

  expect(await s.t.as("bo").get("projects")).toEqual([]);
});

test("thread reports reach an offline coordinator in order once it is back", async () => {
  const s = await started();
  await using _ = s.t;
  const thread = await threadOf(s, "Docs");

  await s.coordinator.online(false);

  await thread.turn([asked("Do Docs"), reply("Wrote the docs.")]);

  await s.t.tool(
    "set_status",
    { state: "review_ready", note: "Ready." },
    { session: thread },
  );

  await s.t.tool(
    "message_coordinator",
    { text: "Should I add a changelog?" },
    { session: thread },
  );

  await s.coordinator.online(true);

  expect(
    s.coordinator
      .delivered()
      .map(({ text, turn }) => [text.split("\n")[0], turn]),
  ).toEqual([
    [
      `[Project notice] Thread "Docs" (${thread.id}) finished a turn. Run state: idle. Work state: in_progress.`,
      true,
    ],
    [
      `[Project notice] Thread "Docs" (${thread.id}) set its work state to review_ready: Ready. Run state: idle. Work state: review_ready.`,
      false,
    ],
    [`[Thread "Docs" (${thread.id})] Should I add a changelog?`, true],
  ]);

  expect(s.coordinator.delivered()[0]?.text).toContain(
    "Its last reply: Wrote the docs.",
  );
});

test("a turn report waits for the thread's transcript to hold the whole turn", async () => {
  const s = await started();
  await using _ = s.t;
  const thread = await threadOf(s, "Docs");

  await thread.turn([asked("Do Docs"), reply("Late reply.")], {
    uploaded: false,
  });

  await s.t.clock.advance("2s");

  expect(s.coordinator.delivered()).toEqual([]);

  await thread.transcript([asked("Do Docs"), reply("Late reply.")]);
  await s.t.clock.advance("2s");

  await until(() => s.coordinator.delivered().length === 1);

  expect(s.coordinator.delivered()[0]?.text).toContain(
    "Its last reply: Late reply.",
  );
});

test("a thread's later message never overtakes its waiting turn report", async () => {
  const s = await started();
  await using _ = s.t;
  const thread = await threadOf(s, "Docs");

  await thread.turn([asked("Do Docs"), reply("Half done.")], {
    uploaded: false,
  });

  await s.t.tool(
    "message_coordinator",
    { text: "Which branch?" },
    { session: thread },
  );

  await until(() => s.coordinator.delivered().length === 2);

  const [report, message] = s.coordinator.delivered();

  expect(report?.text).toContain("finished a turn");
  expect(message?.text).toContain("Which branch?");

  await s.t.clock.advance("2s");

  expect(s.coordinator.delivered()).toHaveLength(2);
});

test("a thread that messaged the coordinator reports its turn as context", async () => {
  const s = await started();
  await using _ = s.t;
  const thread = await threadOf(s, "Docs");

  await thread.turn([
    asked("Do Docs"),
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "c1",
            name: "message_coordinator",
            arguments: {},
          },
        ],
      },
    },
    reply("Asked."),
  ]);

  await until(() => s.coordinator.delivered().length === 1);

  expect(s.coordinator.delivered()[0]?.turn).toBe(false);
});

test("memory writes go on top of the revision they read", async () => {
  const s = await started();
  await using _ = s.t;
  const thread = await threadOf(s, "Docs");

  expect(
    await s.t.tool(
      "memory_write",
      { name: "MEMORY.md", content: "one" },
      { session: thread },
    ),
  ).toMatchObject({ text: "Wrote MEMORY.md.", isError: false });

  expect(
    await s.t.tool(
      "memory_write",
      { name: "MEMORY.md", content: "two" },
      { session: s.coordinator },
    ),
  ).toMatchObject({
    isError: true,
    text: "MEMORY.md is at revision 1: read it, then write your change on top of what it says now",
  });

  await s.t.tool(
    "memory_write",
    { name: "MEMORY.md", content: "two", revision: 1 },
    { session: s.coordinator },
  );

  expect(
    await s.t.tool("memory_read", { name: "MEMORY.md" }, { session: thread }),
  ).toMatchObject({ text: "MEMORY.md, revision 2:\n\ntwo" });
});

test("coordinator tools stay out of threads, and thread tools out of the coordinator", async () => {
  const s = await started();
  await using _ = s.t;
  const thread = await threadOf(s, "Docs");

  expect(
    s.t.tool("start_thread", { title: "x", message: "y" }, { session: thread }),
  ).rejects.toThrow("start_thread isn't offered in this Session");

  expect(
    s.t.tool("set_status", { state: "done" }, { session: s.coordinator }),
  ).rejects.toThrow("set_status isn't offered in this Session");

  const other = await s.t.session({ owner: person("ana") });

  expect(s.t.tool("memory_list", {}, { session: other })).rejects.toThrow(
    "memory_list isn't offered in this Session",
  );
});

test("a fresh coordinator takes over with a handoff once Pi compacts", async () => {
  const s = await started();
  await using _ = s.t;

  await s.coordinator.turn([
    asked("Plan the shop"),
    { type: "compaction", summary: "We planned the shop." },
    reply("Planned."),
  ]);

  const project = await until(async () => {
    const found = await s.t
      .as("ana")
      .get<ProjectView>(`projects/${s.project.id}`);

    return found.coordinatorId === s.project.coordinatorId ? undefined : found;
  });

  expect(project?.formerCoordinators).toEqual([s.project.coordinatorId]);
  expect(project?.coordinatorState).not.toBe("archived");
});

test("a team Project has no owner and every person sees it", async () => {
  const s = await started({ team: true });
  await using _ = s.t;

  expect(s.project.team).toBe(true);

  expect(
    s.t.store.get<{ owner_user_id: string | null }>(
      "select owner_user_id from projects_projects where id = ?",
      s.project.id,
    ),
  ).toEqual({ owner_user_id: null });

  expect(await s.t.as("bo").get("team/projects")).toMatchObject([
    { id: s.project.id, team: true },
  ]);

  expect(await s.t.as("bo").get("projects")).toEqual([]);

  expect(
    (await s.t.as("bo").get<ProjectView>(`projects/${s.project.id}`)).name,
  ).toBe("Shop");
});

test("the Team assistant's route tools act on the team's half", async () => {
  await using t = await testPlugin(server, { people });
  const environment = await t.environment({ owner: "team" });

  const assistant = await t
    .as("ana")
    .post<ProjectView>("team/assistant", { text: "Start a shop project" });

  const coordinator = await t.attach(assistant.coordinatorId);

  const made = await t.tool(
    "projects_create",
    {
      name: "Shop",
      repositories: [repository],
      environment: environment.id,
      profile: "projects.builder",
    },
    { session: coordinator },
  );

  expect(made).toMatchObject({ isError: false });

  expect(
    t.store.all<{ owner_user_id: string | null }>(
      "select owner_user_id from projects_projects where name = 'Shop'",
    ),
  ).toEqual([{ owner_user_id: null }]);

  expect(await t.as("bo").get("team/projects")).toMatchObject([
    { name: "Shop", team: true },
  ]);
});

test("the Team assistant gets and changes team Projects, never a person's", async () => {
  const s = await started({ team: true });
  await using _ = s.t;
  const { t } = s;
  const environment = await t.environment({ owner: person("ana") });

  const own = await t.as("ana").post<ProjectView>("projects", {
    name: "Diary",
    repositories: [repository],
    environment: environment.id,
  });

  const personal = await t
    .as("ana")
    .post<ProjectView>("assistant", { text: "Hello" });

  const assistant = await t
    .as("ana")
    .post<ProjectView>("team/assistant", { text: "Rename the shop" });

  const coordinator = await t.attach(assistant.coordinatorId);
  const on = { session: coordinator, answer: "allow" } as const;

  expect(await t.tool("projects_get", { id: s.project.id }, on)).toMatchObject({
    isError: false,
    text: expect.stringContaining('"name":"Shop"') as unknown,
  });

  expect(
    await t.tool("projects_update", { id: s.project.id, goal: "Sell" }, on),
  ).toMatchObject({ isError: false });

  expect(
    (await t.as("bo").get<ProjectView>(`projects/${s.project.id}`)).goal,
  ).toBe("Sell");

  for (const id of [own.id, personal.id]) {
    expect(await t.tool("projects_get", { id }, on)).toMatchObject({
      isError: true,
    });

    expect(
      await t.tool("projects_update", { id, goal: "Leak" }, on),
    ).toMatchObject({ isError: true });

    expect(
      (await t.as("ana").raw(`team/projects/${id}`, { method: "GET" })).status,
    ).toBe(404);
  }

  expect((await t.as("ana").get<ProjectView>(`projects/${own.id}`)).goal).toBe(
    "",
  );
});

test("archiving the coordinator archives the Project's threads", async () => {
  const s = await started();
  await using _ = s.t;
  const thread = await threadOf(s, "Docs");

  await s.coordinator.archive();

  await until(async () => {
    const found = await s.t
      .as("ana")
      .get<ProjectView>(`projects/${s.project.id}`);

    return found.threads[0]?.runState === "archived" ? found : undefined;
  });

  expect(thread.id).not.toBe("");
});

test("people add files to the Project's folder, and earlier versions stay downloadable", async () => {
  const s = await started();
  await using _ = s.t;
  const ana = s.t.as("ana");
  const base = `projects/${s.project.id}`;

  const upload = async (id: string, text: string): Promise<string> => {
    await ana.raw(`${blobRoutes.browserUpload.replace(":id", id)}?offset=0`, {
      method: "PUT",
      body: text,
    });

    return (
      await ana.post<{ hash: string }>(
        blobRoutes.browserFinish.replace(":id", id),
        {},
      )
    ).hash;
  };

  await ana.post(`${base}/files`, {
    path: "docs/brief.txt",
    hash: await upload("u1", "the brief\n"),
  });

  await ana.post(`${base}/files`, {
    path: "docs/brief.txt",
    hash: await upload("u2", "the new brief\n"),
  });

  const file = `${base}/file?path=${encodeURIComponent("docs/brief.txt")}`;

  expect(await (await ana.raw(file, { method: "GET" })).text()).toBe(
    "the new brief\n",
  );

  const { writes } = await ana.get<{ writes: FolderWrite[] }>(`${base}/log`);

  expect(writes).toMatchObject([
    { path: "docs/brief.txt", size: 14, actor: "user:ana", by: "ana" },
    { path: "docs/brief.txt", size: 10, actor: "user:ana", by: "ana" },
  ]);

  expect(
    await (
      await ana.raw(`${base}/log/${writes[1]?.id ?? ""}`, { method: "GET" })
    ).text(),
  ).toBe("the brief\n");

  expect((await s.t.as("bo").raw(file, { method: "GET" })).status).toBe(404);

  expect(
    (
      await ana.raw(`${base}/files`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path: "../escape",
          hash: await upload("u3", "x"),
        }),
      })
    ).status,
  ).toBe(400);

  await ana.delete(file);

  expect(await ana.get(`${base}/files`)).toEqual({
    files: [],
    perProjectBytes: 5_368_709_120,
  });
});

// A route that says whether its caller acts as an admin, as a route tool.
const probe = definePlugin({
  id: "probe",
  title: "Probe",
  description: "Says whether its caller is an admin.",
  works: ["personal", "team"],
});

const probeServer = defineServer(probe, ({ routes, tools }) => {
  routes.get("admin", { auth: "person", team: true }, ({ caller }) => ({
    admin: caller.person.admin,
  }));

  tools.fromRoute("GET", "admin", {
    name: "probe_admin",
    description: "Says whether you act as an admin.",
    annotations: { readOnlyHint: true },
  });
});

test("an admin's Team assistant thread acts as an admin only while only admins steer it", async () => {
  await using t = await testPlugin(server, {
    people,
    plugins: [probeServer],
  });

  await t.environment({ owner: "team" });

  const assistant = await t
    .as("ana")
    .post<ProjectView>("team/assistant", { text: "Build a plugin" });

  const coordinator = await t.attach(assistant.coordinatorId);

  const begun = await t.tool(
    "start_thread",
    { title: "Hello plugin", message: "Build a hello plugin" },
    { session: coordinator },
  );

  const thread = await t.attach(/as (\S+)\.$/.exec(begun.text)?.[1] ?? "");

  expect(await t.tool("probe_admin", {}, { session: thread })).toMatchObject({
    text: expect.stringContaining('"admin":true') as unknown,
  });

  const shared = await t.as("ana").raw(`/api/sessions/${thread.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      access: { kind: "team" },
    }),
  });

  expect(shared.status).toBe(200);

  expect(await t.tool("probe_admin", {}, { session: thread })).toMatchObject({
    text: expect.stringContaining('"admin":false') as unknown,
  });
});

test("a turn report whose transcript never arrives goes after a minute with what there is", async () => {
  const s = await started();
  await using _ = s.t;
  const thread = await threadOf(s, "Docs");

  await thread.turn([asked("Do Docs"), reply("Lost reply.")], {
    uploaded: false,
  });

  await s.t.clock.advance("59s");

  expect(s.coordinator.delivered()).toEqual([]);

  await s.t.clock.advance("2s");
  await until(() => s.coordinator.delivered().length === 1);

  expect(s.coordinator.delivered()[0]?.text).toContain("finished a turn");

  await s.t.clock.advance("5s");

  expect(s.coordinator.delivered()).toHaveLength(1);
});
