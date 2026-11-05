import { afterEach, beforeEach, expect, test } from "bun:test";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginInfo } from "@pipoca/protocol";
import { installedPlugins } from "./installed";
import { testServer, type TestServer } from "./testdata/harness";

let root: string;
let server: TestServer;

// The plugin docs/plugins.md walks through, so the guide's code stays true.
const example = join(import.meta.dir, "../../../examples/plugins/greeter");

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pipoca-example-"));

  const plugins = join(root, "plugins");
  await cp(example, join(plugins, "greeter"), { recursive: true });

  server = testServer({
    database: join(root, "server.db"),
    sessions: { pollWaitMs: 0 },
    installed: {
      root: plugins,
      plugins: await installedPlugins(
        plugins,
        () => undefined,
        (id) => id === "greeter",
      ),
    },
  });
});

afterEach(async () => {
  await server.close();
  await rm(root, { recursive: true, force: true });
});

test("runs the guide's example plugin with all three parts", async () => {
  const all = (await (await server.api("/api/plugins")).json()) as PluginInfo[];
  const greeter = all.find(({ id }) => id === "greeter");

  expect(greeter).toMatchObject({ state: "on", source: "installed" });
  expect(greeter?.error).toBeUndefined();
  expect((await server.api(greeter?.webPart ?? "/missing")).status).toBe(200);

  expect(
    await (await server.api("/api/plugins/greeter/greeting")).json(),
  ).toEqual({ greeting: "Hello" });

  await server.api("/api/plugins/greeter", {
    method: "PATCH",
    body: {
      settings: { greeting: "Hi" },
    },
  });

  expect(
    await (await server.api("/api/plugins/greeter/greeting")).json(),
  ).toEqual({ greeting: "Hi" });
});

test("answers the example's unknown routes with the server's 404", async () => {
  const missing = await server.api("/api/plugins/greeter/farewell");

  expect(missing.status).toBe(404);

  expect(await missing.json()).toEqual({
    error: "not_found",
    message: "the greeter has no farewell",
  });
});
