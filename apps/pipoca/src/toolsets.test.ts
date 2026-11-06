import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  definePlugin,
  defineServer,
  type ServerContext,
} from "@pipoca/plugins";
import type { ServerPart } from "@pipoca/plugins/host";
import type {
  PluginInfo,
  Prompt,
  Session,
  SessionEvent,
  UiAction,
} from "@pipoca/protocol";
import type { ServeOptions } from "./serve";
import { builtInParts } from "./built-in";
import { readSse } from "@pipoca/protocol";
import { json, testServer, type TestServer } from "./testdata/harness";
import { until } from "@pipoca/testing/until";

let root: string;
let faux: ReturnType<typeof fauxProvider>;
let server: TestServer;
let runtime: ModelRuntime;

// The assistant's chat, the coordinator of a Project of the person's own
// (ADR 0052).
const projectsPart = builtInParts.filter(
  ({ plugin }) => plugin.id === "projects",
);

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "pipoca-toolsets-")));
  faux = fauxProvider();

  runtime = await ModelRuntime.create({
    authPath: join(root, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  });

  runtime.registerNativeProvider(faux.provider);
  start();
});

function probe(register: (context: ServerContext) => void): ServerPart {
  return defineServer(
    definePlugin({ id: "probe", title: "Probe", description: "" }),
    register,
  );
}

function start(
  servers?: readonly ServerPart[],
  installed?: ServeOptions["installed"],
): void {
  server = testServer({
    ...(servers && {
      builtIns: false,
      servers: [...projectsPart, ...servers],
    }),
    ...(installed && { installed }),
    runners: { pollWaitMs: 100, offlineAfterMs: 1000 },
    agent: {
      provider: "local",
      dataDir: join(root, "local"),
      extensionPaths: [],
      folders: [root],
      models: { runtime, model: faux.getModel() },
    },
    disabledPlugins: ["subagents"],
  });
}

afterEach(async () => {
  await server.close();
  await rm(root, { recursive: true, force: true });
});

async function environmentReady(): Promise<void> {
  await until(
    async () =>
      (await json<unknown[]>(server.api("/api/environments"))).length > 0,
  );
}

// Each call asks the person's assistant, whose coordinator is the Session
// that answers.
async function startMeta(text: string): Promise<Session> {
  await environmentReady();

  const { coordinatorId } = await json<{ coordinatorId: string }>(
    server.api("/api/ext/projects/assistant", { body: { text } }),
  );

  return json<Session>(server.api(`/api/sessions/${coordinatorId}`));
}

async function follow(
  sessionId: string,
  done: (events: readonly SessionEvent[]) => boolean,
): Promise<SessionEvent[]> {
  const events: SessionEvent[] = [];
  for await (const event of readSse(
    await server.api(`/api/sessions/${sessionId}/events`),
  )) {
    events.push(event as SessionEvent);
    if (done(events)) {
      break;
    }
  }

  return events;
}

const entriesInclude =
  (text: string) =>
  (events: readonly SessionEvent[]): boolean =>
    events.some((e) => e.type === "entry" && e.entry.includes(text));

const prompts = (events: readonly SessionEvent[]): Prompt[] =>
  events.flatMap((e) =>
    e.type === "live" && e.event.type === "prompt" ? [e.event.prompt] : [],
  );

const transcriptOf = (events: readonly SessionEvent[]): string =>
  events.flatMap((e) => (e.type === "entry" ? [e.entry] : [])).join("\n");

const call = (
  name: string,
  input: Parameters<typeof fauxToolCall>[1],
): ReturnType<typeof fauxAssistantMessage> =>
  fauxAssistantMessage([fauxToolCall(name, input)], { stopReason: "toolUse" });

async function allowNext(sessionId: string): Promise<Prompt> {
  const [asked] = prompts(
    await follow(sessionId, (all) => prompts(all).length > 0),
  );

  if (asked === undefined) {
    throw new Error("no prompt");
  }

  await server.api(`/api/sessions/${sessionId}/commands`, {
    body: {
      type: "answer",
      id: asked.id,
      value: "once",
    },
  });

  return asked;
}

test("starts a Session from a meta-session through the Sessions route without asking", async () => {
  faux.setResponses([
    call("sessions_start", { workspace: { kind: "folder", path: root } }),
    fauxAssistantMessage([fauxText("started it")]),
  ]);

  const metaSession = await startMeta("Start a Session in my folder");
  const events = await follow(metaSession.id, entriesInclude("started it"));

  const [started] = await json<Session[]>(server.api("/api/sessions"));

  const profiles = await json<{ id: string; isDefault: boolean }[]>(
    server.api("/api/profiles"),
  );

  expect(prompts(events)).toEqual([]);
  expect(started?.workspace).toEqual({ kind: "folder", path: root });

  expect(started?.profileId).toBe(
    profiles.find(({ isDefault }) => isDefault)?.id,
  );

  expect(transcriptOf(events)).toContain(started?.id ?? "missing");
});

test("hands the route's own validation error back to the model", async () => {
  faux.setResponses([
    call("sessions_start", {
      workspace: { kind: "clone", repository: "https://me:secret@host/r.git" },
    }),
    fauxAssistantMessage([fauxText("that failed")]),
  ]);

  const metaSession = await startMeta("Start a Session");
  const events = await follow(metaSession.id, entriesInclude("that failed"));

  expect(transcriptOf(events)).toContain(
    "workspace.repository can't hold credentials",
  );

  expect(await json<Session[]>(server.api("/api/sessions"))).toEqual([]);
});

test("finds deferred tools through tool_search, and asks before changing an Environment", async () => {
  await environmentReady();

  const [environment] = await json<{ id: string }[]>(
    server.api("/api/environments"),
  );

  const update = { id: environment?.id ?? "", setupScript: "echo ready" };

  faux.setResponses([
    call("environments_update", update),
    call("tool_search", { query: "change an Environment setup script" }),
    call("environments_update", update),
    fauxAssistantMessage([fauxText("changed it")]),
  ]);

  const metaSession = await startMeta("Set up my Environment");
  const asked = await allowNext(metaSession.id);
  const events = await follow(metaSession.id, entriesInclude("changed it"));

  const [changed] = await json<{ setupScript: string }[]>(
    server.api("/api/environments"),
  );

  expect(asked.title).toBe("Change the Environment “local”?");
  expect(transcriptOf(events)).toContain("Tool environments_update not found");
  expect(changed?.setupScript).toBe("echo ready");
});

test("keeps an Environment's new key out of the meta-session", async () => {
  faux.setResponses([
    call("tool_search", { query: "create an Environment" }),
    call("environments_create", { name: "lab" }),
    fauxAssistantMessage([fauxText("created it")]),
  ]);

  const metaSession = await startMeta("Create an Environment called lab");
  const events = await follow(metaSession.id, entriesInclude("created it"));

  const names = (
    await json<{ name: string }[]>(server.api("/api/environments"))
  ).map(({ name }) => name);

  expect(names).toContain("lab");
  expect(transcriptOf(events)).toContain("Replace key");
  expect(transcriptOf(events)).not.toContain("pck_");
});

test("creates a Project through the Projects plugin's route", async () => {
  faux.setResponses([
    call("projects_create", {
      name: "Shop",
      goal: "Sell more shoes",
      repositories: ["https://example.com/shop.git"],
    }),
    fauxAssistantMessage([fauxText("created the Project")]),
  ]);

  const metaSession = await startMeta("Make a Project for my shop");

  const events = await follow(
    metaSession.id,
    entriesInclude("created the Project"),
  );

  const projects = await json<{ id: string; name: string }[]>(
    server.api("/api/ext/projects/projects"),
  );

  const project = await json<{ goal: string; coordinatorId: string }>(
    server.api(`/api/ext/projects/projects/${projects[0]?.id ?? ""}`),
  );

  const coordinator = await json<Session>(
    server.api(`/api/sessions/${project.coordinatorId}`),
  );

  const { user } = await json<{ user: { id: string } }>(
    server.api("/api/auth"),
  );

  expect(prompts(events)).toEqual([]);
  expect(projects.map(({ name }) => name)).toEqual(["Shop"]);
  expect(project.goal).toBe("Sell more shoes");
  expect(coordinator.startedBy).toBe(user.id);
});

test("never acts as an admin from a meta-session, even one an admin started", async () => {
  await environmentReady();

  const [shared] = await json<{ id: string; name: string }[]>(
    server.api("/api/profiles"),
  );

  const id = shared?.id ?? "";

  faux.setResponses([
    call("tool_search", { query: "change a Profile" }),
    call("profiles_update", { id, name: "Renamed" }),
    fauxAssistantMessage([fauxText("tried it")]),
  ]);

  const metaSession = await startMeta("Rename the shared Profile");
  await allowNext(metaSession.id);
  const events = await follow(metaSession.id, entriesInclude("tried it"));

  const after = await json<{ name: string }>(server.api(`/api/profiles/${id}`));

  expect(transcriptOf(events)).toContain("admin_only");
  expect(after.name).toBe(shared?.name ?? "");
});

test("changes a Project's goal from a meta-session", async () => {
  await environmentReady();

  // On an Environment without runners, so its coordinator takes no turn.
  const environment = await json<{ id: string }>(
    server.api("/api/environments", { body: { name: "nowhere" } }),
  );

  const { id } = await json<{ id: string }>(
    server.api("/api/ext/projects/projects", {
      body: {
        name: "Shop",
        repositories: ["https://example.com/shop.git"],
        environment: environment.id,
      },
    }),
  );

  faux.setResponses([
    call("tool_search", { query: "change a Project's settings" }),
    call("projects_update", { id, goal: "Sell boots too" }),
    fauxAssistantMessage([fauxText("changed the goal")]),
  ]);

  const metaSession = await startMeta("Add boots to the shop's goal");
  const asked = await allowNext(metaSession.id);
  await follow(metaSession.id, entriesInclude("changed the goal"));

  const project = await json<{ goal: string }>(
    server.api(`/api/ext/projects/projects/${id}`),
  );

  expect(asked.title).toBe("Change the settings of “Shop”?");
  expect(project.goal).toBe("Sell boots too");
});

test("gives an ordinary Session none of the toolsets", async () => {
  faux.setResponses([
    call("sessions_list", {}),
    fauxAssistantMessage([fauxText("all done")]),
  ]);

  await environmentReady();

  const session = await json<Session>(
    server.api("/api/sessions", {
      body: {
        workspace: { kind: "folder", path: root },
        firstMessage: "List the Sessions",
      },
    }),
  );

  const events = await follow(session.id, entriesInclude("all done"));

  expect(transcriptOf(events)).toContain("Tool sessions_list not found");
});

test("runs the person's assistant as a Project of their own, on the assistant's Profiles", async () => {
  const seen = { coordinator: "", thread: "" };

  faux.setResponses([
    (context) => {
      seen.coordinator = JSON.stringify(context);

      return call("start_thread", {
        title: "Build a Profile",
        message: "Build it",
      });
    },
    fauxAssistantMessage([fauxText("thread started")]),
    (context) => {
      seen.thread = JSON.stringify(context);

      return fauxAssistantMessage([fauxText("built")]);
    },
    fauxAssistantMessage([fauxText("noted")]),
    fauxAssistantMessage([fauxText("second ask")]),
  ]);

  await environmentReady();

  const assistant = await json<{
    id: string;
    coordinatorId: string;
    assistant: boolean;
    repositories: string[];
  }>(
    server.api("/api/ext/projects/assistant", {
      body: {
        text: "Build me a Profile",
      },
    }),
  );

  expect(assistant.assistant).toBe(true);
  expect(assistant.repositories).toEqual([]);

  await follow(assistant.coordinatorId, entriesInclude("thread started"));

  expect(seen.coordinator).toContain("You are Pipoca's assistant.");
  expect(seen.coordinator).toContain("coordinator of their assistant Project");
  expect(seen.coordinator).toContain('{"name":"sessions_list"');
  expect(seen.coordinator).not.toContain('{"name":"bash"');

  const [thread] = (
    await json<{ threads: { sessionId: string }[] }>(
      server.api(`/api/ext/projects/projects/${assistant.id}`),
    )
  ).threads;

  await follow(thread?.sessionId ?? "", entriesInclude("built"));

  expect(seen.thread).toContain("thread of the person's Pipoca assistant");
  expect(seen.thread).toContain('{"name":"bash"');
  expect(seen.thread).toContain('{"name":"sessions_list"');

  expect(
    await json<unknown[]>(server.api("/api/ext/projects/projects")),
  ).toEqual([]);

  const again = await json<{ id: string }>(
    server.api("/api/ext/projects/assistant", {
      body: { text: "And another" },
    }),
  );

  expect(again.id).toBe(assistant.id);
}, 20_000);

test("shows a Profile's MCP servers by name only", async () => {
  await server.api("/api/profiles", {
    body: {
      name: "With MCP",
      mcpServers: { github: { env: { GITHUB_TOKEN: "token-in-env" } } },
    },
  });

  faux.setResponses([
    call("tool_search", { query: "list Profiles" }),
    call("profiles_list", {}),
    fauxAssistantMessage([fauxText("listed them")]),
  ]);

  const metaSession = await startMeta("Which Profiles do I have?");
  const events = await follow(metaSession.id, entriesInclude("listed them"));

  expect(transcriptOf(events)).toContain('\\"mcpServers\\":[\\"github\\"]');
  expect(transcriptOf(events)).not.toContain("token-in-env");
});

test("keeps a plugin's tool inside the plugin's own routes", async () => {
  await server.close();

  start([
    probe(({ routes }) => {
      routes.get(
        "items/:id",
        {
          auth: "person",
          tool: {
            name: "probe_run",
            description: "Runs an item",
            exposure: "direct",
            annotations: { readOnlyHint: true },
          },
        },
        ({ params }) => ({ reached: params.id }),
      );

      routes.get(
        "text",
        {
          auth: "person",
          tool: {
            name: "probe_text",
            description: "Answers in plain text",
            exposure: "direct",
            annotations: { readOnlyHint: true },
          },
        },
        () => new Response("plain words"),
      );
    }),
  ]);

  faux.setResponses([
    call("probe_run", { id: "../../../profiles" }),
    call("probe_text", {}),
    fauxAssistantMessage([fauxText("tried them")]),
  ]);

  const metaSession = await startMeta("Run the items");

  const transcript = transcriptOf(
    await follow(metaSession.id, entriesInclude("tried them")),
  );

  expect(transcript).toContain(String.raw`\"reached\":\"../../../profiles\"`);
  expect(transcript).not.toContain("isDefault");
  expect(transcript).toMatch(/"plain words".*"isError":false/);
});

const uiActions = (events: readonly SessionEvent[]): UiAction[] =>
  events.flatMap((e) =>
    e.type === "live" && e.event.type === "ui_action" ? [e.event.action] : [],
  );

test("opens what a tool started or asked for in the browsers watching, once", async () => {
  faux.setResponses([
    call("sessions_start", { workspace: { kind: "folder", path: root } }),
    call("projects_create", {
      name: "Shop",
      repositories: ["https://example.com/shop.git"],
    }),
    fauxAssistantMessage([fauxText("all opened")]),
  ]);

  const metaSession = await startMeta("Start things");
  const answered = new Set<string>();

  const events = await follow(metaSession.id, (all) => {
    for (const prompt of prompts(all).filter(({ id }) => !answered.has(id))) {
      answered.add(prompt.id);

      void server.api(`/api/sessions/${metaSession.id}/commands`, {
        body: {
          type: "answer",
          id: prompt.id,
          value: true,
        },
      });
    }

    return entriesInclude("all opened")(all);
  });

  const [started] = await json<Session[]>(server.api("/api/sessions"));

  const [project] = await json<{ id: string }[]>(
    server.api("/api/ext/projects/projects"),
  );

  expect(uiActions(events)).toEqual([
    { kind: "open", route: started?.id ?? "", label: "the new Session" },
    {
      kind: "open",
      route: `plugin/projects/${project?.id ?? ""}`,
      label: "“Shop”",
    },
  ]);

  const replayed = await follow(metaSession.id, entriesInclude("all opened"));

  expect(uiActions(replayed)).toEqual([]);

  const transcript = transcriptOf(replayed);

  expect(transcript).toContain(
    JSON.stringify({
      opened: {
        kind: "open",
        route: started?.id ?? "",
        label: "the new Session",
      },
    }),
  );
});

test("opens a Session on request without asking, and only routes of the app", async () => {
  await server.close();

  start([
    probe(({ routes }) => {
      routes.get(
        "x",
        {
          auth: "person",
          tool: {
            name: "probe_escape",
            description: "Opens a route outside the app",
            exposure: "direct",
            annotations: { readOnlyHint: true },
            opens: () => ({ route: "../../elsewhere", label: "elsewhere" }),
          },
        },
        () => ({}),
      );
    }),
  ]);

  await environmentReady();

  const target = await json<Session>(
    server.api("/api/sessions", {
      body: { workspace: { kind: "folder", path: root } },
    }),
  );

  faux.setResponses([
    call("probe_escape", {}),
    call("sessions_open", { id: target.id }),
    fauxAssistantMessage([fauxText("opened it")]),
  ]);

  const metaSession = await startMeta("Show me that Session");
  const events = await follow(metaSession.id, entriesInclude("opened it"));

  expect(prompts(events)).toEqual([]);

  expect(uiActions(events)).toEqual([
    { kind: "open", route: target.id, label: "the Session" },
  ]);
});

test("lets the assistant read files but not run commands or change files", async () => {
  let declared = "";

  faux.setResponses([
    (context) => {
      declared = JSON.stringify(context);

      return fauxAssistantMessage([fauxText("looked")]);
    },
  ]);

  const metaSession = await startMeta("What can you do?");
  await follow(metaSession.id, entriesInclude("looked"));

  expect(declared).toContain('{"name":"sessions_list"');

  for (const tool of ["read", "grep", "find", "ls", "install_profile"]) {
    expect(declared).toContain(`{"name":"${tool}"`);
  }

  for (const tool of ["bash", "edit", "write"]) {
    expect(declared).not.toContain(`{"name":"${tool}"`);
  }
});

test("runs Pi's own tools without asking", async () => {
  faux.setResponses([
    call("ls", { path: root }),
    call("read", { path: join(root, "auth.json") }),
    fauxAssistantMessage([fauxText("looked around")]),
  ]);

  const metaSession = await startMeta("What's in there?");
  const events = await follow(metaSession.id, entriesInclude("looked around"));

  expect(prompts(events)).toEqual([]);
});

test("keeps the tools that installs use away from the model", async () => {
  await server.close();
  start(undefined, { root: join(root, "plugins"), plugins: [] });

  faux.setResponses([
    call("tool_search", { query: "write a plugin file" }),
    call("plugins_write_file", {
      plugin: "hello",
      path: "package.json",
      content: "{}",
    }),
    fauxAssistantMessage([fauxText("tried")]),
  ]);

  const metaSession = await startMeta("Write a plugin file");
  const events = await follow(metaSession.id, entriesInclude("tried"));

  const transcript = transcriptOf(events);

  expect(transcript).not.toContain("- plugins_write_file:");
  expect(transcript).toContain("Tool plugins_write_file not found");
});

test("installs an in-place plugin from a folder after asking, and leaves turning it on to the user", async () => {
  await server.close();
  start(undefined, { root: join(root, "plugins"), plugins: [] });

  const folder = join(root, "work", "hello");
  await mkdir(join(folder, "node_modules", "left-out"), { recursive: true });

  await writeFile(
    join(folder, "package.json"),
    JSON.stringify({
      description: "Says hi.",
      pipoca: { id: "hello", entry: "plugin.ts" },
    }),
  );

  await writeFile(
    join(folder, "plugin.ts"),
    `import { definePlugin } from "@pipoca/plugins";

export const plugin = definePlugin({
  id: "hello",
  title: "Hello",
  description: "Says hi.",
});
`,
  );

  await writeFile(join(folder, "node_modules", "left-out", "index.js"), "");

  faux.setResponses([
    call("install_plugin", { path: folder, plugin: "hello" }),
    fauxAssistantMessage([fauxText("built it")]),
  ]);

  const metaSession = await startMeta("Make me a hello plugin");
  const asked = await allowNext(metaSession.id);
  const events = await follow(metaSession.id, entriesInclude("built it"));

  const hello = (await json<PluginInfo[]>(server.api("/api/plugins"))).find(
    ({ id }) => id === "hello",
  );

  expect(asked.title).toBe(
    `Install the plugin “hello” from ${folder}? It stays off until an admin turns it on.`,
  );

  expect(transcriptOf(events)).toContain("It builds.");
  expect(hello).toMatchObject({ state: "off", turnedOn: false });

  expect(
    (await stat(join(root, "plugins", "hello", ".build"))).isDirectory(),
  ).toBe(true);

  expect(
    await json<unknown>(server.api("/api/plugins/hello/files")),
  ).not.toContainEqual(expect.stringContaining("node_modules"));
});

test("installs a folder as a new Profile without asking, leaving out what isn't the Profile's", async () => {
  const folder = join(root, "work", "dotfiles");
  await mkdir(join(folder, "skills", "review"), { recursive: true });
  await mkdir(join(folder, ".git"), { recursive: true });
  await writeFile(join(folder, "AGENTS.md"), "Be brief.");
  await writeFile(join(folder, "skills", "review", "SKILL.md"), "# Review");
  await writeFile(join(folder, ".git", "HEAD"), "ref: main");

  faux.setResponses([
    call("install_profile", { path: folder }),
    fauxAssistantMessage([fauxText("installed it")]),
  ]);

  const metaSession = await startMeta("Make a Profile from my dotfiles");
  const events = await follow(metaSession.id, entriesInclude("installed it"));

  const profile = (
    await json<{ id: string; name: string }[]>(server.api("/api/profiles"))
  ).find(({ name }) => name === "dotfiles");

  expect(prompts(events)).toEqual([]);
  expect(profile).toBeDefined();

  expect(transcriptOf(events)).toContain(
    `"opened":{"kind":"open","route":"profiles/${profile?.id ?? ""}","label":"dotfiles"}`,
  );

  const files = JSON.stringify(
    await json<unknown>(server.api(`/api/profiles/${profile?.id ?? ""}/files`)),
  );

  expect(files).toContain("AGENTS.md");
  expect(files).toContain("skills/review/SKILL.md");
  expect(files).not.toContain(".git");
});
