import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { $ } from "bun";
import type { PluginInfo } from "@pipoca/protocol";
import { installedPlugins } from "./installed";
import type { ServeOptions } from "./serve";
import { closeServers, testServer, type TestServer } from "./testdata/harness";

let root: string;
let plugins: string;
let server: TestServer;
let cookie: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pipoca-in-place-"));
  plugins = join(root, "plugins");
  cookie = undefined;
  await mkdir(plugins);
});

afterEach(async () => {
  await closeServers();
  await rm(root, { recursive: true, force: true });
});

async function start(
  options: Pick<ServeOptions, "idleTimeout"> = {},
): Promise<void> {
  await closeServers();

  server = testServer({
    ...options,
    database: join(root, "server.db"),
    sessions: { pollWaitMs: 0 },
    installed: {
      root: plugins,
      plugins: await installedPlugins(plugins, () => undefined),
    },
    ...(cookie !== undefined && { cookie }),
  });

  cookie = await server.signedIn();
}

async function write(
  plugin: string,
  path: string,
  content: string,
): Promise<Response> {
  return server.api(`/api/plugin-files/${plugin}`, {
    method: "PUT",
    body: { path, content },
  });
}

async function errorOf(response: Promise<Response>): Promise<string> {
  const settled = await response;

  const { error, message } = (await settled.json()) as {
    error: string;
    message: string;
  };

  expect([settled.status, error]).toEqual([400, "bad_request"]);

  return message;
}

const manifest = (parts: Record<string, string> = { server: "server.ts" }) =>
  JSON.stringify({
    type: "module",
    pipoca: {
      id: "hello",
      title: "Hello",
      description: "Says hi.",
      engine: 1,
      capabilities: ["routes"],
      parts,
    },
  });

const serverPart = `export default {
  name: "hello",
  register: (context) => {
    context.routes.handle(async () => new Response("hi"));
  },
};
`;

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

test("writes a new plugin turned off, and lists and reads its files", async () => {
  await start();

  const written = await write("hello", "package.json", manifest());

  expect(await written.json()).toMatchObject({
    id: "hello",
    title: "Hello",
    source: "installed",
    state: "off",
    turnedOn: false,
  });

  await write("hello", "src/util.ts", "export const two = 2;\n");

  expect(await (await server.api("/api/plugin-files/hello")).json()).toEqual([
    "package.json",
    "src/util.ts",
  ]);

  expect(
    await (
      await server.api("/api/plugin-files/hello?path=src%2Futil.ts")
    ).json(),
  ).toEqual({ path: "src/util.ts", content: "export const two = 2;\n" });
});

test("builds a plugin turned off without running it, and says why one doesn't build", async () => {
  await start();
  await write("hello", "package.json", manifest());

  await write(
    "hello",
    "server.ts",
    `${serverPart}\nawait Bun.write(${JSON.stringify(join(root, "ran"))}, "");`,
  );

  const built = await server.api("/api/plugin-builds/hello", {
    method: "POST",
  });

  expect(built.status).toBe(200);
  expect(await exists(join(plugins, "hello", ".build"))).toBe(true);
  expect(await exists(join(root, "ran"))).toBe(false);
  expect((await server.api("/api/plugins/hello/")).status).toBe(404);

  await write("hello", "server.ts", "export default {");

  expect(
    await errorOf(server.api("/api/plugin-builds/hello", { method: "POST" })),
  ).toContain("doesn't build");
});

test("finishes a build that takes longer than the server's idle timeout", async () => {
  const dependency = join(root, "slow", "package");
  await mkdir(dependency, { recursive: true });

  await writeFile(
    join(dependency, "package.json"),
    JSON.stringify({ name: "slow", version: "1.0.0" }),
  );

  await $`tar -czf ${join(root, "slow.tgz")} -C ${join(root, "slow")} package`;

  using registry = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async () => {
      await Bun.sleep(6000);

      return new Response(Bun.file(join(root, "slow.tgz")));
    },
  });

  await start({ idleTimeout: 1 });

  await write(
    "hello",
    "package.json",
    JSON.stringify({
      ...(JSON.parse(manifest()) as object),
      dependencies: { slow: new URL("/slow.tgz", registry.url).href },
    }),
  );

  await write("hello", "server.ts", serverPart);

  const built = await server.api("/api/plugin-builds/hello", {
    method: "POST",
  });

  expect(built.status).toBe(200);
}, 30_000);

test("won't build a plugin with no parts, since it would do nothing", async () => {
  await start();
  await write("hello", "package.json", manifest({}));

  expect(
    await errorOf(server.api("/api/plugin-builds/hello", { method: "POST" })),
  ).toContain("no parts");
});

test("builds without running a macro, which would run the plugin's code", async () => {
  const mark = join(root, "macro-ran");

  await start();
  await write("hello", "package.json", manifest());

  await write(
    "hello",
    "macro.ts",
    `export function hi() { Bun.write(${JSON.stringify(mark)}, ""); return "hi"; }\n`,
  );

  await write(
    "hello",
    "server.ts",
    `import { hi } from "./macro.ts" with { type: "macro" };\n\nexport default { name: hi(), register: () => undefined };\n`,
  );

  expect(
    await errorOf(server.api("/api/plugin-builds/hello", { method: "POST" })),
  ).toContain("Macros are disabled");

  await new Promise((resolve) => setTimeout(resolve, 100));

  expect(await exists(mark)).toBe(false);
});

test("keeps writes inside the plugin's own files", async () => {
  const outside = join(root, "outside");
  await mkdir(outside);
  await start();
  await write("hello", "package.json", manifest());
  await symlink(outside, join(plugins, "hello", "out"));

  for (const path of [
    "../escaped.ts",
    "/etc/escaped",
    ".build/server.js",
    "node_modules/x/index.js",
    ".source.json",
    "",
  ]) {
    expect((await write("hello", path, "x")).status).toBe(400);
  }

  expect(await errorOf(write("hello", "out/x.ts", "x"))).toContain(
    "outside the plugin's folder",
  );

  expect(await errorOf(write("hello", "out/sub/x.ts", "x"))).toContain(
    "outside the plugin's folder",
  );

  expect(await exists(join(outside, "x.ts"))).toBe(false);
  expect(await exists(join(outside, "sub"))).toBe(false);
  expect(await exists(join(root, "escaped.ts"))).toBe(false);
});

test("changes only plugins turned off that are its own to change", async () => {
  await start();
  await write("hello", "package.json", manifest());
  await write("hello", "server.ts", serverPart);

  await server.api("/api/plugins/hello", {
    method: "PATCH",
    body: { enabled: true },
  });

  expect(await errorOf(write("hello", "server.ts", "x"))).toContain(
    "turned on",
  );

  await start();

  await server.api("/api/plugins/hello", {
    method: "PATCH",
    body: { enabled: false },
  });

  expect(
    await errorOf(server.api("/api/plugin-builds/hello", { method: "POST" })),
  ).toContain("running");

  expect(await errorOf(write("projects", "x.ts", "x"))).toContain("built-in");

  await mkdir(join(plugins, "pinned"));

  await writeFile(
    join(plugins, "pinned", ".source.json"),
    JSON.stringify({ url: "https://example.com/p.git", pinned: "abc" }),
  );

  expect(await errorOf(write("pinned", "x.ts", "x"))).toContain("updating");

  await mkdir(join(root, "elsewhere"));
  await symlink(join(root, "elsewhere"), join(plugins, "linked"));

  expect(await errorOf(write("linked", "x.ts", "x"))).toContain("elsewhere");

  expect(await readFile(join(plugins, "hello", "server.ts"), "utf8")).toBe(
    serverPart,
  );
});

test("shows a plugin's broken manifest once it is written", async () => {
  await start();
  await write("hello", "package.json", "{");

  const listed = (await (
    await server.api("/api/plugins")
  ).json()) as PluginInfo[];

  expect(listed.find(({ id }) => id === "hello")).toMatchObject({
    state: "failed",
  });
});

test("writes a new plugin turned off even when a removed one of its id was on", async () => {
  await writeFile(join(plugins, "enabled.json"), JSON.stringify(["hello"]));
  await start();
  await write("hello", "package.json", manifest());
  await write("hello", "server.ts", serverPart);
  await start();

  expect((await server.api("/api/plugins/hello/")).status).toBe(404);
});

test("won't turn on a plugin that changed since the user saw it", async () => {
  await start();

  const seen = (await (
    await write("hello", "package.json", manifest())
  ).json()) as PluginInfo;

  await write("hello", "package.json", manifest({ server: "other.ts" }));

  expect(
    await errorOf(
      server.api("/api/plugins/hello", {
        method: "PATCH",
        body: {
          enabled: true,
          digest: seen.digest,
        },
      }),
    ),
  ).toContain("changed since");

  const now = (await (await server.api("/api/plugins")).json()) as PluginInfo[];
  const digest = now.find(({ id }) => id === "hello")?.digest;

  expect(
    (
      await server.api("/api/plugins/hello", {
        method: "PATCH",
        body: { enabled: true, digest },
      })
    ).status,
  ).toBe(200);
});

test("won't turn on a plugin whose code changed since the user saw it", async () => {
  await start();
  await write("hello", "package.json", manifest());

  const seen = (await (
    await write("hello", "server.ts", serverPart)
  ).json()) as PluginInfo;

  await write("hello", "server.ts", serverPart.replace("hi", "bye"));

  expect(
    await errorOf(
      server.api("/api/plugins/hello", {
        method: "PATCH",
        body: {
          enabled: true,
          digest: seen.digest,
        },
      }),
    ),
  ).toContain("changed since");
});

test("keeps what the server makes in a plugin's folder out of reach, whatever the case or links", async () => {
  await start();
  await write("hello", "package.json", manifest());
  await mkdir(join(plugins, "hello", ".build"));
  await symlink(join(plugins, "hello", ".build"), join(plugins, "hello", "b"));

  for (const path of [
    ".Build/x.js",
    "NODE_MODULES/x.js",
    ".GIT/hooks/x",
    "b/x.js",
  ]) {
    expect((await write("hello", path, "x")).status).toBe(400);
  }

  expect(await exists(join(plugins, "hello", ".build", "x.js"))).toBe(false);
});

test("won't build a plugin whose install would reach outside its folder", async () => {
  await start();
  await write("hello", "server.ts", serverPart);

  for (const [field, value] of [
    ["workspaces", ["../other"]],
    ["dependencies", { other: "file:../other" }],
    ["devDependencies", { other: "link:other" }],
    ["overrides", { other: "../other" }],
  ] as const) {
    await write(
      "hello",
      "package.json",
      JSON.stringify({ ...JSON.parse(manifest()), [field]: value }),
    );

    expect(
      await errorOf(server.api("/api/plugin-builds/hello", { method: "POST" })),
    ).toMatch(/can't have|not from elsewhere/);
  }

  await write("hello", "package.json", manifest());
  await write("hello", "bunfig.toml", "[install]\n");

  expect(
    await errorOf(server.api("/api/plugin-builds/hello", { method: "POST" })),
  ).toContain("bunfig.toml");
});

test("builds only plugins of its own folder", async () => {
  await mkdir(join(root, "elsewhere"));
  await writeFile(join(root, "elsewhere", "package.json"), manifest());
  await symlink(join(root, "elsewhere"), join(plugins, "linked"));
  await mkdir(join(plugins, "pinned"));
  await writeFile(join(plugins, "pinned", "package.json"), manifest());

  await writeFile(
    join(plugins, "pinned", ".source.json"),
    JSON.stringify({ url: "https://example.com/p.git", pinned: "abc" }),
  );

  await start();

  expect(
    await errorOf(server.api("/api/plugin-builds/linked", { method: "POST" })),
  ).toContain("elsewhere");

  expect(
    await errorOf(server.api("/api/plugin-builds/pinned", { method: "POST" })),
  ).toContain("updating");

  expect(await exists(join(root, "elsewhere", ".build"))).toBe(false);
});

test("leaves no folder behind for a write it refuses, nor reads one that isn't a plugin", async () => {
  await mkdir(join(plugins, ".install-left"));
  await start();

  expect((await write("fresh", "../x", "x")).status).toBe(400);
  expect(await exists(join(plugins, "fresh"))).toBe(false);

  expect((await server.api("/api/plugin-files/.install-left")).status).toBe(
    400,
  );
});

test("answers not found for a plugin or file that isn't there", async () => {
  await start();
  await write("hello", "package.json", manifest());

  const statuses = await Promise.all(
    [
      ["GET", "/api/plugin-files/nope"],
      ["GET", "/api/plugin-files/nope?path=server.ts"],
      ["POST", "/api/plugin-builds/nope"],
      ["GET", "/api/plugin-files/hello?path=server.ts"],
    ].map(
      async ([method = "", path = ""]) =>
        (await server.api(path, { method })).status,
    ),
  );

  expect(statuses).toEqual([404, 404, 404, 404]);
});

test("lets only an admin write or build a plugin's files", async () => {
  await start();
  await write("hello", "package.json", manifest());
  await write("hello", "server.ts", serverPart);

  const db = new DatabaseSync(join(root, "server.db"));
  db.exec("update users set admin = 0");
  db.close();

  const refused = await Promise.all([
    write("hello", "server.ts", "export default {};"),
    server.api("/api/plugin-builds/hello", { method: "POST" }),
  ]);

  expect(refused.map(({ status }) => status)).toEqual([403, 403]);
  expect(await refused[0].json()).toMatchObject({ error: "admin_only" });

  expect(await readFile(join(plugins, "hello", "server.ts"), "utf8")).toBe(
    serverPart,
  );
});
