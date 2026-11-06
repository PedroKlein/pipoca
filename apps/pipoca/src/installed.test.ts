import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { $ } from "bun";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { PluginInfo, Session, SessionEvent } from "@pipoca/protocol";
import { installedTurnedOn } from "./config";
import { installedPlugins } from "./installed";
import { latestCommit } from "@pipoca/repositories";
import type { ServeOptions } from "./serve";
import { readSse } from "@pipoca/protocol";
import { closeServers, testServer, type TestServer } from "./testdata/harness";
import { until } from "@pipoca/testing/until";

let root: string;
let plugins: string;
let server: TestServer;
let cookie: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pipoca-installed-"));
  plugins = join(root, "plugins");
  cookie = undefined;
  await mkdir(plugins);
});

afterEach(async () => {
  await closeServers();
  await rm(root, { recursive: true, force: true });
});

const noLog = (): void => undefined;

async function turnOnInConfig(...ids: readonly string[]): Promise<void> {
  await mkdir(join(root, "config"), { recursive: true });

  await writeFile(
    join(root, "config", "pipoca.json"),
    JSON.stringify({
      plugins: Object.fromEntries(ids.map((id) => [id, { personal: true }])),
    }),
  );
}

async function switchesInConfig(): Promise<unknown> {
  const config = JSON.parse(
    await readFile(join(root, "config", "pipoca.json"), "utf8"),
  ) as { readonly plugins?: unknown };

  return config.plugins;
}

// A plugin folder whose server part answers on its route, and leaves a mark
// when it is imported.
async function writePlugin(
  id: string,
  pipoca: Record<string, unknown> = {},
  register = `routes.get("hi", { auth: "person" }, () => new Response("hi from ${id}"));`,
  parent = plugins,
): Promise<void> {
  const folder = join(parent, id);
  await mkdir(join(folder, "src"), { recursive: true });

  await writeFile(
    join(folder, "package.json"),
    JSON.stringify({
      name: id,
      description: "Says hi.",
      pipoca: { id, entry: "src/plugin.ts", ...pipoca },
    }),
  );

  await writeFile(
    join(folder, "src", "plugin.ts"),
    `import { definePlugin } from "@pipoca/plugins";

export const plugin = definePlugin({
  id: ${JSON.stringify(id)},
  title: "The ${id} plugin",
  description: "Says hi.",
});
`,
  );

  await writeServer(folder, register);
}

async function writeServer(
  folder: string,
  register: string,
  imports = "",
): Promise<void> {
  await writeFile(
    join(folder, "src", "server.ts"),
    `import { BadRequest, defineServer, Type } from "@pipoca/plugins";
import { plugin } from "./plugin";
${imports}
await Bun.write(${JSON.stringify(join(folder, "imported"))}, "");

export const server = defineServer(plugin, ({ provide, routes }) => {
  ${register}
});
`,
  );
}

async function hi(id: string): Promise<string> {
  return (await server.api(`/api/ext/${id}/hi`)).text();
}

// Starts the server the way the CLI does, so a restart reads the folder again.
async function start(agent?: ServeOptions["agent"]): Promise<void> {
  await closeServers();

  server = testServer({
    database: join(root, "server.db"),
    runners: { pollWaitMs: agent ? 100 : 0 },
    ...(agent && { agent }),
    installed: {
      root: plugins,
      plugins: await installedPlugins(
        plugins,
        noLog,
        installedTurnedOn(join(root, "config"), noLog),
      ),
    },
    ...(cookie !== undefined && { cookie }),
  });

  // The database outlives a restart, and the first user's cookie with it.
  cookie = await server.signedIn();
}

async function listed(id: string): Promise<PluginInfo | undefined> {
  const all = (await (await server.api("/api/plugins")).json()) as PluginInfo[];

  return all.find((plugin) => plugin.id === id);
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

test("lists an installed plugin turned off, without running its code", async () => {
  await writePlugin("hello");
  await start();

  expect(await listed("hello")).toMatchObject({
    source: "installed",
    state: "off",
    turnedOn: false,
    title: "hello",
    description: "Says hi.",
  });

  expect(await exists(join(plugins, "hello", "imported"))).toBe(false);
  expect((await server.api("/api/ext/hello/hi")).status).toBe(404);
});

test("turns an installed plugin on for the next start", async () => {
  await writePlugin("hello");
  await start();

  const turned = await server.api("/api/plugins/hello", {
    method: "PATCH",
    body: { enabled: true },
  });

  expect(await turned.json()).toMatchObject({ state: "off", turnedOn: true });

  expect(await switchesInConfig()).toEqual({ hello: { personal: true } });

  await start();

  expect(await listed("hello")).toMatchObject({
    state: "on",
    turnedOn: true,
    title: "The hello plugin",
  });

  expect(await hi("hello")).toBe("hi from hello");

  await server.api("/api/plugins/hello", {
    method: "PATCH",
    body: { enabled: false },
  });

  await start();

  expect(await listed("hello")).toMatchObject({
    state: "off",
    turnedOn: false,
  });
});

test("keeps an installed plugin out of team work until an admin turns it on there", async () => {
  await writePlugin("board");
  await start();

  await server.api("/api/plugins/board", {
    method: "PATCH",
    body: { enabled: true },
  });

  await start();

  expect(await listed("board")).toMatchObject({ state: "on", teamWork: false });
  expect(await listed("usage")).toMatchObject({ teamWork: true });

  await server.api("/api/plugins/board", {
    method: "PATCH",
    body: { teamWork: true },
  });

  expect(await listed("board")).toMatchObject({ teamWork: true });
});

test("fails an installed plugin that tries to sign people in", async () => {
  await writePlugin("imposter", {}, "provide.signIn({ logins: () => [] });");

  await turnOnInConfig("imposter");
  await start();

  const imposter = await listed("imposter");

  expect(imposter?.state).toBe("failed");
  expect(imposter?.error).toContain("an installed plugin can't sign people in");
});

test("names the manifest field that doesn't fit, failing only that plugin", async () => {
  await writePlugin("hello");
  await writePlugin("misnamed", { id: "other" });
  await writePlugin("pointless", { entry: 7 });
  await start();

  expect((await listed("misnamed"))?.error).toContain("folder's name");

  expect((await listed("pointless"))?.error).toBe(
    "pipoca.entry must be string",
  );

  expect(await listed("hello")).toMatchObject({ state: "off" });
});

test("turns built-in plugins on or off only through the server's options", async () => {
  await start();

  const refused = await server.api("/api/plugins/projects", {
    method: "PATCH",
    body: {
      enabled: false,
    },
  });

  expect(refused.status).toBe(400);
  expect((await listed("projects"))?.turnedOn).toBe(true);
});

test("keeps a built-in plugin when a folder takes its id", async () => {
  await writePlugin("projects");
  await turnOnInConfig("projects");
  await start();

  const all = (await (await server.api("/api/plugins")).json()) as PluginInfo[];

  expect(all.filter(({ id }) => id === "projects")).toMatchObject([
    { source: "built-in", state: "on" },
  ]);

  expect(await exists(join(plugins, "projects", "imported"))).toBe(false);
});

test("keeps every switch when several are turned at once", async () => {
  const ids = ["a", "b", "c", "d"];

  for (const id of ids) {
    await writePlugin(id);
  }

  await start();

  const turned = await Promise.all(
    ids.map(async (id) =>
      server.api(`/api/plugins/${id}`, {
        method: "PATCH",
        body: { enabled: true },
      }),
    ),
  );

  expect(turned.map(({ status }) => status)).toEqual([200, 200, 200, 200]);

  expect(await switchesInConfig()).toEqual(
    Object.fromEntries(ids.map((id) => [id, { personal: true }])),
  );
});

test("won't turn on a plugin whose manifest is broken", async () => {
  await writePlugin("pointless", { entry: 7 });
  await start();

  const refused = await server.api("/api/plugins/pointless", {
    method: "PATCH",
    body: { enabled: true },
  });

  expect(refused.status).toBe(400);
  expect(await exists(join(root, "config", "pipoca.json"))).toBe(false);
});

test("loads a plugin whose folder is a link to one elsewhere", async () => {
  await writePlugin("linked");
  await rename(join(plugins, "linked"), join(root, "linked"));
  await symlink(join(root, "linked"), join(plugins, "linked"));
  await turnOnInConfig("linked");
  await start();

  expect(await hi("linked")).toBe("hi from linked");
});

test("won't import a server part that links outside the plugin", async () => {
  const elsewhere = join(root, "elsewhere");
  await mkdir(elsewhere);
  await writeFile(join(elsewhere, "server.ts"), "export const server = {};");

  await writePlugin("sneaky");
  await rm(join(plugins, "sneaky", "src", "server.ts"));

  await symlink(
    join(elsewhere, "server.ts"),
    join(plugins, "sneaky", "src", "server.ts"),
  );

  await turnOnInConfig("sneaky");
  await start();

  expect((await listed("sneaky"))?.error).toContain("outside the plugin");
});

test("starts with every installed plugin off when pipoca.json is broken", async () => {
  await writePlugin("hello");
  await mkdir(join(root, "config"));
  await writeFile(join(root, "config", "pipoca.json"), "[");
  await start();

  expect(await listed("hello")).toMatchObject({ state: "off" });
});

test("builds a plugin with its dependencies, without its scripts, before running it", async () => {
  await writePlugin("greeter");

  const folder = join(plugins, "greeter");
  await mkdir(join(folder, "vendor", "greeting"), { recursive: true });

  await writeFile(
    join(folder, "vendor", "greeting", "package.json"),
    JSON.stringify({ name: "greeting", version: "1.0.0", main: "index.ts" }),
  );

  await writeFile(
    join(folder, "vendor", "greeting", "index.ts"),
    `export const greeting = "hi from a dependency";\n`,
  );

  const manifest = JSON.parse(
    await readFile(join(folder, "package.json"), "utf8"),
  ) as Record<string, unknown>;

  await writeFile(
    join(folder, "package.json"),
    JSON.stringify({
      ...manifest,
      dependencies: { greeting: "file:./vendor/greeting" },
      scripts: { prepare: "exit 3" },
    }),
  );

  await writeServer(
    folder,
    `routes.get("hi", { auth: "person" }, () => new Response(greeting));`,
    `import { greeting } from "greeting";`,
  );

  await turnOnInConfig("greeter");
  await start();

  expect(await hi("greeter")).toBe("hi from a dependency");
});

test("runs a plugin's source as it is at each start", async () => {
  await writePlugin("hello");
  await turnOnInConfig("hello");
  await start();

  const part = join(plugins, "hello", "src", "server.ts");
  const source = await readFile(part, "utf8");

  await writeFile(part, source.replace("hi from hello", "hello again"));
  await start();

  expect(await hi("hello")).toBe("hello again");
});

test("shows why a plugin doesn't build", async () => {
  await writePlugin("broken");

  await writeFile(
    join(plugins, "broken", "src", "server.ts"),
    "export const server = {",
  );

  await turnOnInConfig("broken");
  await start();

  const broken = await listed("broken");

  expect(broken?.state).toBe("failed");
  expect(broken?.error).toContain("server.ts doesn't build");
  expect(broken?.error).toMatch(/broken\/src\/server\.ts:1:\d+: /);
});

// A plugin whose route refuses what it is sent with errors from the SDK it
// imports from.
async function writeRefusingPlugin(id: string, sdk: string): Promise<void> {
  await writePlugin(id);

  await writeServer(
    join(plugins, id),
    `routes.post("hi", { auth: "person" }, () => {
    throw new Refused("say something");
  });

  routes.post("names", { auth: "admin" }, () => ({ renamed: true }));`,
    `import { BadRequest as Refused } from ${JSON.stringify(sdk)};`,
  );

  await turnOnInConfig(id);
}

test("answers the errors a plugin throws from the server's plugin SDK", async () => {
  await writeRefusingPlugin("strict", "@pipoca/plugins");
  await start();

  const refused = await server.api("/api/ext/strict/hi", {
    method: "POST",
  });

  expect(await listed("strict")).toMatchObject({ state: "on" });
  expect(refused.status).toBe(400);

  expect(await refused.json()).toEqual({
    error: "bad_request",
    message: "say something",
  });
});

test("lets only an admin through a plugin's route that requires one", async () => {
  await writeRefusingPlugin("strict", "@pipoca/plugins");
  await start();

  expect(
    await (
      await server.api("/api/ext/strict/names", { method: "POST" })
    ).json(),
  ).toEqual({ renamed: true });

  const db = new DatabaseSync(join(root, "server.db"));
  db.exec("update users set admin = 0");
  db.close();

  const refused = await server.api("/api/ext/strict/names", {
    method: "POST",
  });

  expect(refused.status).toBe(403);
});

test("checks a body against a schema from the server's plugin SDK", async () => {
  await writePlugin("names");

  await writeServer(
    join(plugins, "names"),
    `routes.post(
    "rename",
    { auth: "person", body: Type.Object({ name: Type.String() }) },
    ({ body }) => body,
  );`,
  );

  await turnOnInConfig("names");
  await start();

  const named = await server.api("/api/ext/names/rename", {
    body: { name: "a" },
  });

  expect(await named.json()).toEqual({ name: "a" });

  const refused = await server.api("/api/ext/names/rename", {
    body: { name: 7 },
  });

  expect(refused.status).toBe(422);

  expect(await refused.json()).toEqual({
    error: "invalid",
    message: "name must be string",
    field: "name",
  });
});

test("answers the errors of a plugin that bundles its own copy of the SDK", async () => {
  await writeRefusingPlugin("vendored", "./sdk");

  await writeFile(
    join(plugins, "vendored", "src", "sdk.ts"),
    await readFile(
      join(import.meta.dir, "../../../packages/plugins/src/http.ts"),
    ),
  );

  await start();

  const refused = await server.api("/api/ext/vendored/hi", {
    method: "POST",
  });

  expect(refused.status).toBe(400);

  expect(await refused.json()).toEqual({
    error: "bad_request",
    message: "say something",
  });
});

test("serves a running plugin's web part, built against the page's modules", async () => {
  await writePlugin("pages");
  await mkdir(join(plugins, "pages", "web"));

  await writeFile(
    join(plugins, "pages", "web", "index.tsx"),
    `import { useState } from "react";

export const web = { hook: useState };
`,
  );

  await turnOnInConfig("pages");
  await start();

  const webPart = (await listed("pages"))?.webPart ?? "";
  const served = await server.api(webPart);

  expect(webPart).toMatch(/^\/api\/plugins\/pages\/parts\/web-\w+\.js$/);
  expect(served.headers.get("content-type")).toContain("javascript");
  expect(await served.text()).toContain('globalThis.pipocaShared["react"]');

  expect((await server.api("/api/plugins/pages/parts/server.ts")).status).toBe(
    404,
  );
});

test("fails a web part that imports CSS the page would never load", async () => {
  await writePlugin("styled");
  await mkdir(join(plugins, "styled", "web"));

  await writeFile(
    join(plugins, "styled", "web", "look.css"),
    "p { color: red; }\n",
  );

  await writeFile(
    join(plugins, "styled", "web", "index.tsx"),
    `import "./look.css";\n\nexport const web = {};\n`,
  );

  await turnOnInConfig("styled");
  await start();

  expect((await listed("styled"))?.error).toContain("imports CSS");
});

// A Session part that adds a slash command, so a Session shows it loaded.
async function writeSlashPlugin(): Promise<void> {
  await writePlugin("slash");
  await writeSession(join(plugins, "slash"));
  await turnOnInConfig("slash");
}

async function writeSession(folder: string): Promise<void> {
  await writeFile(
    join(folder, "src", "session.ts"),
    `import { defineSession } from "@pipoca/plugins";
import { plugin } from "./plugin";

export const session = defineSession(plugin, (s) => {
  s.extension((pi) => {
    pi.registerCommand("installed-hello", {
      description: "Says hi from an installed plugin",
      handler: async () => undefined,
    });
  });
});
`,
  );
}

// Starts the server with its own runner on a faux model, and a Session on it.
async function startSession(): Promise<Session> {
  const faux = fauxProvider();

  const runtime = await ModelRuntime.create({
    authPath: join(root, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  });

  runtime.registerNativeProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage([fauxText("hi")])]);

  await start({
    provider: "local",
    dataDir: join(root, "local"),
    extensionPaths: [],
    folders: [root],
    models: { runtime, model: faux.getModel() },
  });

  await until(
    async () =>
      ((await (await server.api("/api/environments")).json()) as unknown[])
        .length > 0,
  );

  return (await (
    await server.api("/api/sessions", {
      body: {
        workspace: { kind: "folder", path: root },
      },
    })
  ).json()) as Session;
}

async function commandsOf(session: Session): Promise<readonly string[]> {
  const events = await server.api(`/api/sessions/${session.id}/events`);

  for await (const event of readSse(events)) {
    const sent = event as SessionEvent;

    if (sent.type === "live" && sent.event.type === "commands") {
      return sent.event.commands.map(({ name }) => name);
    }
  }

  return [];
}

test("runs an installed plugin's Session part in a Session, fetched by its hash", async () => {
  await writeSlashPlugin();

  const session = await startSession();

  expect(await commandsOf(session)).toContain("installed-hello");

  const cached = await readdir(
    join(root, "local", "sessions", session.id, "plugin-parts"),
  );

  expect(cached).toHaveLength(1);
  expect(cached[0]).toMatch(/^slash-[0-9a-f]{64}\.js$/);
});

test("fails a Session part that imports a file the runner wouldn't get", async () => {
  await writePlugin("prompted");
  await writeFile(join(plugins, "prompted", "src", "prompt.png"), "not really");

  await writeFile(
    join(plugins, "prompted", "src", "session.ts"),
    `import prompt from "./prompt.png";\n\nexport const session = { prompt };\n`,
  );

  await turnOnInConfig("prompted");
  await start();

  expect((await listed("prompted"))?.error).toContain(
    "imports files other than code",
  );
});

// A git repository holding a plugin, committed, and the URL to install it by.
async function gitPlugin(id: string, register?: string): Promise<string> {
  const sources = join(root, "sources");
  const folder = join(sources, id);

  await mkdir(sources, { recursive: true });
  await writePlugin(id, {}, register, sources);
  await $`git -C ${folder} init -q`;
  await commit(folder);

  return `file://${folder}`;
}

async function commit(folder: string): Promise<string> {
  await $`git -C ${folder} add -A`;
  await $`git -C ${folder} -c user.name=t -c user.email=t@t -c commit.gpgsign=false commit -qm c`;

  return (await $`git -C ${folder} rev-parse HEAD`.text()).trim();
}

// The check a server starts with runs in the background; it logs when done.
async function checked(): Promise<void> {
  await until(() =>
    server.logs.some((line) => line.startsWith("plugin updates checked")),
  );
}

async function install(url: string): Promise<Response> {
  return server.api("/api/plugins", { body: { url } });
}

test("installs a plugin from a git repository turned off, pinned to its commit", async () => {
  const url = await gitPlugin("hello");

  const pinned = (
    await $`git -C ${join(root, "sources", "hello")} rev-parse HEAD`.text()
  ).trim();

  await start();

  const installed = await install(url);

  expect(installed.status).toBe(201);

  expect(await installed.json()).toMatchObject({
    id: "hello",
    source: "installed",
    state: "off",
    turnedOn: false,
    installedFrom: { url, pinned },
  });

  expect(await exists(join(plugins, "hello", ".git"))).toBe(false);
  expect(await exists(join(plugins, "hello", "imported"))).toBe(false);

  await server.api("/api/plugins/hello", {
    method: "PATCH",
    body: { enabled: true },
  });

  await start();

  expect(await hi("hello")).toBe("hi from hello");
  expect((await listed("hello"))?.installedFrom).toEqual({ url, pinned });
});

test("installs a plugin from a branch or tag after # in its URL", async () => {
  const url = await gitPlugin("hello");
  const folder = join(root, "sources", "hello");

  await $`git -C ${folder} tag v1`;
  const tagged = (await $`git -C ${folder} rev-parse HEAD`.text()).trim();
  await writeFile(join(folder, "later.txt"), "");
  await commit(folder);
  await start();

  const installed = (await (await install(`${url}#v1`)).json()) as PluginInfo;

  expect(installed.installedFrom?.pinned).toBe(tagged);
});

test("installs a plugin from a tarball, pinned to its SHA-256", async () => {
  await gitPlugin("packed");

  const tarball = join(root, "packed.tgz");
  await $`tar -czf ${tarball} -C ${join(root, "sources")} packed`;

  const hash = new Bun.CryptoHasher("sha256")
    .update(await readFile(tarball))
    .digest("hex");

  await start();

  const installed = await install(`file://${tarball}`);

  expect(await installed.json()).toMatchObject({
    id: "packed",
    installedFrom: { pinned: `sha256:${hash}` },
  });

  expect(await exists(join(plugins, "packed", "src", "server.ts"))).toBe(true);
});

test("refuses an install that would take an id already here, leaving nothing behind", async () => {
  await writePlugin("hello");
  const taken = await gitPlugin("hello");
  const builtIn = await gitPlugin("projects");

  await start();

  const twice = await install(taken);
  const projects = await install(builtIn);

  expect(twice.status).toBe(400);

  expect(((await twice.json()) as { message: string }).message).toContain(
    "already here",
  );

  expect(projects.status).toBe(400);

  expect(((await projects.json()) as { message: string }).message).toContain(
    "built-in",
  );

  expect((await readdir(plugins)).sort()).toEqual(["hello"]);
});

test("refuses to install from anything but an https, ssh or file URL", async () => {
  await start();

  for (const url of ["http://example.com/x.git", "ext::sh -c id", "-u"]) {
    expect((await install(url)).status).toBe(400);
  }
});

test("updates a plugin to its repository's newest commit for the next start", async () => {
  const url = await gitPlugin("hello");
  const folder = join(root, "sources", "hello");

  await start();
  await install(url);

  await server.api("/api/plugins/hello", {
    method: "PATCH",
    body: { enabled: true },
  });

  await start();

  const same = await server.api("/api/plugins/hello", {
    method: "PATCH",
    body: { update: true },
  });

  expect(await same.json()).not.toHaveProperty("updated");

  await writeServer(
    folder,
    `routes.get("hi", { auth: "person" }, () => new Response("hi again"));`,
  );

  const newest = await commit(folder);

  const updated = await server.api("/api/plugins/hello", {
    method: "PATCH",
    body: { update: true },
  });

  expect(await updated.json()).toMatchObject({
    state: "on",
    turnedOn: true,
    updated: true,
    installedFrom: { pinned: newest },
  });

  expect(await hi("hello")).toBe("hi from hello");

  await start();

  expect(await hi("hello")).toBe("hi again");
});

test("offers an update once the plugin's repository moves past it, and stops once it updates", async () => {
  const url = await gitPlugin("hello");
  const folder = join(root, "sources", "hello");

  await start();
  await install(url);
  await start();
  await checked();

  expect(await listed("hello")).not.toHaveProperty("updateAvailable");

  await writeFile(join(folder, "README.md"), "newer\n");
  await commit(folder);
  await start();
  await checked();

  expect(await listed("hello")).toMatchObject({ updateAvailable: true });

  await server.api("/api/plugins/hello", {
    method: "PATCH",
    body: { update: true },
  });

  expect(await listed("hello")).not.toHaveProperty("updateAvailable");
});

test("follows a tag to its commit when it checks for an update", async () => {
  const url = await gitPlugin("hello");
  const folder = join(root, "sources", "hello");

  await $`git -C ${folder} -c user.name=t -c user.email=t@t tag -a v1 -m v1`;

  expect(await latestCommit(`${url}#v1`)).toBe(
    (await $`git -C ${folder} rev-parse HEAD`.text()).trim(),
  );

  expect(await latestCommit(`${url}#nope`)).toBeUndefined();
  expect(await latestCommit("https://example.com/plugin.tgz")).toBeUndefined();
});

test("forgets why a plugin failed once an update replaces it", async () => {
  const url = await gitPlugin("hello", `throw new Error("broken");`);
  const folder = join(root, "sources", "hello");

  await start();
  await install(url);

  await server.api("/api/plugins/hello", {
    method: "PATCH",
    body: { enabled: true },
  });

  await start();

  expect((await listed("hello"))?.error).toContain("broken");

  await writeServer(
    folder,
    `routes.get("hi", { auth: "person" }, () => new Response("fixed"));`,
  );

  await commit(folder);

  const updated = await server.api("/api/plugins/hello", {
    method: "PATCH",
    body: { update: true },
  });

  expect(await updated.json()).not.toHaveProperty("error");
  expect(await listed("hello")).toMatchObject({ state: "off", updated: true });
});

test("won't update a plugin put in the folder by hand", async () => {
  await writePlugin("hello");
  await start();

  const refused = await server.api("/api/plugins/hello", {
    method: "PATCH",
    body: { update: true },
  });

  expect(refused.status).toBe(400);
});

test("removes an installed plugin only once it isn't running", async () => {
  await writePlugin("hello");
  await turnOnInConfig("hello");
  await start();

  const running = await server.api("/api/plugins/hello", { method: "DELETE" });

  expect(running.status).toBe(400);

  await server.api("/api/plugins/hello", {
    method: "PATCH",
    body: { enabled: false },
  });

  await start();

  const removed = await server.api("/api/plugins/hello", { method: "DELETE" });

  expect(removed.status).toBe(204);
  expect(await listed("hello")).toBeUndefined();
  expect(await exists(join(plugins, "hello"))).toBe(false);

  expect(
    (await server.api("/api/plugins/hello", { method: "DELETE" })).status,
  ).toBe(404);

  expect(
    (await server.api("/api/plugins/projects", { method: "DELETE" })).status,
  ).toBe(400);
});

test("says why a plugin couldn't be removed", async () => {
  await writePlugin("hello");
  await start();
  await mkdir(join(root, "config", "pipoca.json"), { recursive: true });

  const refused = await server.api("/api/plugins/hello", { method: "DELETE" });

  expect(refused.status).toBe(400);

  expect(((await refused.json()) as { message: string }).message).toContain(
    "pipoca.json",
  );

  expect(await listed("hello")).toBeDefined();
});

test("removes only the link to a plugin developed elsewhere", async () => {
  await writePlugin("linked");
  await rename(join(plugins, "linked"), join(root, "linked"));
  await symlink(join(root, "linked"), join(plugins, "linked"));
  await start();

  await server.api("/api/plugins/linked", { method: "DELETE" });

  expect(await exists(join(plugins, "linked"))).toBe(false);
  expect(await exists(join(root, "linked", "package.json"))).toBe(true);
});

test("refuses a plugin holding a link, which could aim the server's writes anywhere", async () => {
  const victim = join(root, "victim.txt");
  await writeFile(victim, "untouched");

  const url = await gitPlugin("linky");
  const folder = join(root, "sources", "linky");
  await symlink(victim, join(folder, ".source.json"));
  await commit(folder);
  await start();

  const refused = await install(url);

  expect(refused.status).toBe(400);

  expect(((await refused.json()) as { message: string }).message).toContain(
    "holds a link, .source.json",
  );

  expect(await readFile(victim, "utf8")).toBe("untouched");
  expect(await readdir(plugins)).toEqual([]);
});

test("refuses a URL holding credentials, since every user sees where a plugin came from", async () => {
  await start();

  const refused = await install("https://me:token@example.com/plugin.git");

  expect(((await refused.json()) as { message: string }).message).toContain(
    "credentials",
  );
});

test("turns off an update that adds a part running somewhere new", async () => {
  const url = await gitPlugin("hello");
  const folder = join(root, "sources", "hello");

  await start();
  await install(url);

  await server.api("/api/plugins/hello", {
    method: "PATCH",
    body: { enabled: true },
  });

  await writeSession(folder);
  await commit(folder);

  const updated = await server.api("/api/plugins/hello", {
    method: "PATCH",
    body: { update: true },
  });

  expect(await updated.json()).toMatchObject({ turnedOn: false });
});

test("installs turned off even when a plugin of its id was turned on and removed by hand", async () => {
  await turnOnInConfig("hello");

  const url = await gitPlugin("hello");

  await start();
  await install(url);
  await start();

  expect(await listed("hello")).toMatchObject({
    state: "off",
    turnedOn: false,
  });
});

test("clears what an install that didn't finish left in the folder", async () => {
  await mkdir(join(plugins, ".install-left"));
  await mkdir(join(plugins, ".old-left"));
  await start();

  expect(await readdir(plugins)).toEqual([]);
});
