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
import { meta } from "@pipoca/meta/server";
import type { ServerPlugin } from "@pipoca/plugins";
import type {
  PluginInfo,
  Prompt,
  Session,
  SessionEvent,
  UiAction,
} from "@pipoca/protocol";
import { serve, type ServeOptions } from "./serve";
import { builtInPlugins } from "./session-parts";
import { firstUser } from "./testdata/sign-in";
import { readSse } from "./sse";

let root: string;
let faux: ReturnType<typeof fauxProvider>;
let server: ReturnType<typeof serve>;
let signedIn: () => Promise<string>;
let runtime: ModelRuntime;

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

function start(
  plugins?: ServeOptions["plugins"],
  installed?: ServeOptions["installed"],
): void {
  const logs: string[] = [];

  server = serve({
    ...(plugins && {
      plugins,
      manifests: plugins.map(
        ({ name }) =>
          builtInPlugins.find(({ id }) => id === name) ?? {
            id: name,
            title: name,
            description: "",
            capabilities: ["toolsets", "routes"],
          },
      ),
    }),
    ...(installed && { installed }),
    port: 0,
    database: ":memory:",
    sessions: { pollWaitMs: 100, offlineAfterMs: 1000 },
    agent: {
      provider: "local",
      dataDir: join(root, "local"),
      extensionPaths: [],
      folders: [root],
      models: { runtime, model: faux.getModel() },
    },
    disabledPlugins: ["subagents"],
    log: (message, fields) => {
      logs.push(`${message} ${JSON.stringify(fields)}`);
    },
  });

  signedIn = firstUser(server, logs);
}

afterEach(async () => {
  await server.stop();
  await rm(root, { recursive: true, force: true });
});

async function api(path: string, body?: unknown): Promise<Response> {
  return fetch(new URL(path, server.url), {
    method: body === undefined ? "GET" : "POST",
    headers: {
      cookie: await signedIn(),
      ...(body !== undefined && { "content-type": "application/json" }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}

async function json<T>(response: Promise<Response>): Promise<T> {
  return (await (await response).json()) as T;
}

async function environmentReady(): Promise<void> {
  while ((await json<unknown[]>(api("/api/environments"))).length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function startMeta(text: string): Promise<Session> {
  await environmentReady();

  return json<Session>(api("/api/plugins/meta/sessions", { text }));
}

async function follow(
  sessionId: string,
  until: (events: readonly SessionEvent[]) => boolean,
): Promise<SessionEvent[]> {
  const events: SessionEvent[] = [];
  for await (const event of readSse(
    await api(`/api/sessions/${sessionId}/events`),
  )) {
    events.push(event as SessionEvent);
    if (until(events)) {
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

  await api(`/api/sessions/${sessionId}/commands`, {
    type: "answer",
    id: asked.id,
    value: "once",
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

  const [started] = await json<Session[]>(api("/api/sessions"));

  const profiles = await json<{ id: string; isDefault: boolean }[]>(
    api("/api/profiles"),
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
    call("sessions_start", { workspace: { kind: "folder" } }),
    fauxAssistantMessage([fauxText("that failed")]),
  ]);

  const metaSession = await startMeta("Start a Session");
  const events = await follow(metaSession.id, entriesInclude("that failed"));

  expect(transcriptOf(events)).toContain("workspace must be a folder");
  expect(await json<Session[]>(api("/api/sessions"))).toEqual([]);
});

test("finds deferred tools through tool_search, and asks before changing an Environment", async () => {
  await environmentReady();
  const [environment] = await json<{ id: string }[]>(api("/api/environments"));

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
    api("/api/environments"),
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

  const names = (await json<{ name: string }[]>(api("/api/environments"))).map(
    ({ name }) => name,
  );

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
    api("/api/plugins/projects/projects"),
  );

  const project = await json<{ goal: string; coordinatorId: string }>(
    api(`/api/plugins/projects/projects/${projects[0]?.id ?? ""}`),
  );

  const coordinator = await json<Session>(
    api(`/api/sessions/${project.coordinatorId}`),
  );

  const { user } = await json<{ user: { id: string } }>(api("/api/auth"));

  expect(prompts(events)).toEqual([]);
  expect(projects.map(({ name }) => name)).toEqual(["Shop"]);
  expect(project.goal).toBe("Sell more shoes");
  expect(coordinator.startedBy).toBe(user.id);
});

test("never acts as an admin from a meta-session, even one an admin started", async () => {
  await environmentReady();

  const [shared] = await json<{ id: string; name: string }[]>(
    api("/api/profiles"),
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

  const after = await json<{ name: string }>(api(`/api/profiles/${id}`));

  expect(transcriptOf(events)).toContain("admin_only");
  expect(after.name).toBe(shared?.name ?? "");
});

test("changes a Project's goal from a meta-session", async () => {
  await environmentReady();

  // On an Environment without runners, so its coordinator takes no turn.
  const { environment } = await json<{ environment: { id: string } }>(
    api("/api/environments", { name: "nowhere" }),
  );

  const { id } = await json<{ id: string }>(
    api("/api/plugins/projects/projects", {
      name: "Shop",
      repositories: ["https://example.com/shop.git"],
      environment: environment.id,
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
    api(`/api/plugins/projects/projects/${id}`),
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
    api("/api/sessions", {
      workspace: { kind: "folder", path: root },
      firstMessage: "List the Sessions",
    }),
  );

  const events = await follow(session.id, entriesInclude("all done"));

  expect(transcriptOf(events)).toContain("Tool sessions_list not found");
});

test("gives another plugin's Session on a toolset plugin's shared Profile its toolsets", async () => {
  const lead: ServerPlugin = {
    name: "lead",
    register: (context) => {
      context.toolsets.loadInOwnSessions();

      context.profiles.provide(
        "desk",
        {
          name: "Desk",
          packages: [],
          agentsMd: "",
          systemMd: "",
          appendSystemMd: "",
          mcpServers: {},
          settings: {},
        },
        { sharedWith: ["crew"] },
      );
    },
  };

  const starter = (name: string): ServerPlugin => ({
    name,
    register: (context) => {
      context.routes.handle((_request, _path, caller) =>
        Response.json(
          context.sessions.start(
            {
              actor: caller.actor,
              profile: "lead.desk",
              workspace: { kind: "folder", path: root },
              firstMessage: "List the Sessions",
            },
            "desk",
          ),
        ),
      );
    },
  });

  await server.stop();
  start([lead, starter("crew"), starter("stranger")]);
  await environmentReady();

  faux.setResponses([
    call("sessions_list", {}),
    fauxAssistantMessage([fauxText("listed")]),
  ]);

  const session = await json<Session>(api("/api/plugins/crew/start", {}));
  const events = await follow(session.id, entriesInclude("listed"));

  expect(transcriptOf(events)).not.toContain("Tool sessions_list not found");
  expect((await api("/api/plugins/stranger/start", {})).ok).toBe(false);
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

  const asked = {
    profile: "meta.assistant",
    threadProfile: "meta.builder",
  };

  const assistant = await json<{
    id: string;
    coordinatorId: string;
    assistant: boolean;
    repositories: string[];
  }>(
    api("/api/plugins/projects/assistant", {
      ...asked,
      text: "Build me a Profile",
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
      api(`/api/plugins/projects/projects/${assistant.id}`),
    )
  ).threads;

  await follow(thread?.sessionId ?? "", entriesInclude("built"));

  expect(seen.thread).toContain("thread of the person's Pipoca assistant");
  expect(seen.thread).toContain('{"name":"bash"');
  expect(seen.thread).toContain('{"name":"sessions_list"');

  expect(await json<unknown[]>(api("/api/plugins/projects/projects"))).toEqual(
    [],
  );

  const again = await json<{ id: string }>(
    api("/api/plugins/projects/assistant", { ...asked, text: "And another" }),
  );

  expect(again.id).toBe(assistant.id);
}, 20_000);

test("shows a Profile's MCP servers by name only", async () => {
  await api("/api/profiles", {
    name: "With MCP",
    mcpServers: { github: { env: { GITHUB_TOKEN: "token-in-env" } } },
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
  const probe: ServerPlugin = {
    name: "probe",
    register: (context) => {
      context.routes.handle((_request, path) =>
        path === "text"
          ? new Response("plain words")
          : Response.json({ reached: "probe" }),
      );

      context.toolsets.register({
        namespace: { name: "probe" },
        tools: [
          {
            name: "run",
            description: "Runs an item",
            parameters: { type: "object" },
            exposure: "direct",
            annotations: { readOnlyHint: true },
            request: (input) => ({
              method: "GET",
              path: `items/${String(input["id"])}`,
            }),
          },
          {
            name: "text",
            description: "Answers in plain text",
            parameters: { type: "object" },
            exposure: "direct",
            annotations: { readOnlyHint: true },
            request: () => ({ method: "GET", path: "text" }),
          },
        ],
      });
    },
  };

  await server.stop();
  start([meta, probe]);

  faux.setResponses([
    call("probe_run", { id: "../../../profiles" }),
    call("probe_run", { id: "%2e%2e/%2e%2e/%2e%2e/profiles" }),
    call("probe_run", { id: "7" }),
    call("probe_text", {}),
    fauxAssistantMessage([fauxText("tried them")]),
  ]);

  const metaSession = await startMeta("Run the items");

  const transcript = transcriptOf(
    await follow(metaSession.id, entriesInclude("tried them")),
  );

  expect(transcript.match(/isn't one of its routes/g)).toHaveLength(2);
  expect(transcript).toContain("reached");
  expect(transcript).not.toContain("isDefault");
  expect(transcript).toMatch(/"plain words".*"isError":false/);
});

test("refuses a plugin's toolset in a namespace the kernel has", async () => {
  const squatter: ServerPlugin = {
    name: "squatter",
    register: (context) => {
      context.toolsets.register({
        namespace: { name: "sessions" },
        tools: [],
      });
    },
  };

  await server.stop();
  start([meta, squatter]);

  const plugins = await json<{ id: string; state: string; error?: string }[]>(
    api("/api/plugins"),
  );

  expect(plugins.find(({ id }) => id === "squatter")).toMatchObject({
    state: "failed",
    error: "toolset sessions belongs to kernel",
  });
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

      void api(`/api/sessions/${metaSession.id}/commands`, {
        type: "answer",
        id: prompt.id,
        value: true,
      });
    }

    return entriesInclude("all opened")(all);
  });

  const [started] = await json<Session[]>(api("/api/sessions"));

  const [project] = await json<{ id: string }[]>(
    api("/api/plugins/projects/projects"),
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
  const probe: ServerPlugin = {
    name: "probe",
    register: (context) => {
      context.routes.handle(() => Response.json({}));

      context.toolsets.register({
        namespace: { name: "probe" },
        tools: [
          {
            name: "escape",
            description: "Opens a route outside the app",
            parameters: { type: "object" },
            exposure: "direct",
            annotations: { readOnlyHint: true },
            request: () => ({ method: "GET", path: "x" }),
            opens: () => ({ route: "../../elsewhere", label: "elsewhere" }),
          },
        ],
      });
    },
  };

  await server.stop();
  start([meta, probe]);
  await environmentReady();

  const target = await json<Session>(
    api("/api/sessions", { workspace: { kind: "folder", path: root } }),
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
  await server.stop();
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
  await server.stop();
  start(undefined, { root: join(root, "plugins"), plugins: [] });

  const folder = join(root, "work", "hello");
  await mkdir(join(folder, "node_modules", "left-out"), { recursive: true });

  await writeFile(
    join(folder, "package.json"),
    JSON.stringify({
      pipoca: {
        id: "hello",
        title: "Hello",
        description: "Says hi.",
        engine: 1,
        capabilities: ["routes"],
        parts: { server: "server.ts" },
      },
    }),
  );

  await writeFile(
    join(folder, "server.ts"),
    `export default { name: "hello", register: () => undefined };\n`,
  );

  await writeFile(join(folder, "node_modules", "left-out", "index.js"), "");

  faux.setResponses([
    call("install_plugin", { path: folder, plugin: "hello" }),
    fauxAssistantMessage([fauxText("built it")]),
  ]);

  const metaSession = await startMeta("Make me a hello plugin");
  const asked = await allowNext(metaSession.id);
  const events = await follow(metaSession.id, entriesInclude("built it"));

  const hello = (await json<PluginInfo[]>(api("/api/plugins"))).find(
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
    await json<unknown>(api("/api/plugin-files/hello")),
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
    await json<{ id: string; name: string }[]>(api("/api/profiles"))
  ).find(({ name }) => name === "dotfiles");

  expect(prompts(events)).toEqual([]);
  expect(profile).toBeDefined();

  expect(transcriptOf(events)).toContain(
    `"opened":{"kind":"open","route":"profiles/${profile?.id ?? ""}","label":"dotfiles"}`,
  );

  const files = JSON.stringify(
    await json<unknown>(api(`/api/profiles/${profile?.id ?? ""}/files`)),
  );

  expect(files).toContain("AGENTS.md");
  expect(files).toContain("skills/review/SKILL.md");
  expect(files).not.toContain(".git");
});
