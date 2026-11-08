import { afterEach, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { definePlugin, defineServer } from "@pipoca/plugins";
import type { PluginInfo } from "@pipoca/protocol";
import { builtInPlugins } from "./built-in";
import { closeServers, json, testServer } from "./testdata/harness";

afterEach(closeServers);

const root = join(import.meta.dir, "../../..");

const ids = (await readdir(join(root, "plugins"))).sort();

// Literals that are a plugin's id by chance: a field, a file or an event of
// the kernel's own.
const meansOther: Readonly<Record<string, readonly string[]>> = {
  "apps/pipoca/src/server/http/routes/server.ts": ["changes"],
  "apps/pipoca/src/faux.ts": ["models"],
  "apps/pipoca/src/web-app.ts": ["push"],
  "apps/pipoca/src/dev.ts": ["local"],
  "apps/web/src/session/feed.ts": ["files"],
  "apps/web/src/settings/configuration/tree.ts": ["files"],
  "apps/web/src/settings/profiles/overview.tsx": ["files"],
  "apps/web/src/settings/profiles/tabs.tsx": ["models", "files"],
  "packages/environments/src/environments.ts": ["models"],
  "packages/environments/src/runner-polls.ts": ["models"],
  "packages/pluginhost/src/host.ts": ["models"],
  "packages/runner/src/agent.ts": ["logins", "models"],
  "packages/runner/src/container.ts": ["models"],
  "packages/runner/src/host.ts": ["models"],
  "packages/runner/src/models.ts": ["models"],
  "packages/protocol/src/events.ts": ["files"],
  "packages/runner/src/session-process.ts": ["models"],
  "packages/sessionhost/src/host.ts": ["files"],
  "packages/sessionhost/src/profile.ts": ["files"],
  "packages/sessions/src/sessions.ts": ["models"],
};

const generated = new Set([
  "apps/pipoca/src/registry-server.ts",
  "apps/pipoca/src/registry-session.ts",
  "apps/web/src/registry.ts",
]);

async function sources(folder: string): Promise<readonly string[]> {
  const found: string[] = [];

  for (const entry of await readdir(join(root, folder), {
    withFileTypes: true,
  })) {
    const path = join(folder, entry.name);

    if (entry.isDirectory()) {
      if (!["node_modules", "testdata", "dist"].includes(entry.name)) {
        found.push(...(await sources(path)));
      }
    } else if (
      /\.tsx?$/.test(path) &&
      !/\.test\.tsx?$|\.e2e\.ts$/.test(path) &&
      !generated.has(path)
    ) {
      found.push(path);
    }
  }

  return found;
}

async function kernelFiles(): Promise<readonly string[]> {
  return (
    await Promise.all(
      ["apps/pipoca/src", "apps/web/src", "packages"].map(sources),
    )
  ).flat();
}

test("the kernel names no plugin and imports none", async () => {
  const named: string[] = [];

  for (const path of await kernelFiles()) {
    const source = await readFile(join(root, path), "utf8");

    const allowed = meansOther[path] ?? [];

    for (const id of ids) {
      const literal = new RegExp(`["'\`]${id}(["'\`]|\\.(?!json)\\w)`);

      const imported = new RegExp(
        `from "(@pipoca/${id}|[./]*plugins/${id})["/]`,
      );

      if (imported.test(source)) {
        named.push(`${path} imports ${id}`);
      }

      if (literal.test(source) && !allowed.includes(id)) {
        named.push(`${path} names ${id}`);
      }
    }
  }

  expect(named).toEqual([]);
});

test("the allowances name only what the kernel still says", async () => {
  const stale: string[] = [];

  for (const [path, allowed] of Object.entries(meansOther)) {
    const source = await readFile(join(root, path), "utf8");

    for (const id of allowed) {
      if (!new RegExp(`["'\`]${id}["'\`.]`).test(source)) {
        stale.push(`${path} ${id}`);
      }
    }
  }

  expect(stale).toEqual([]);
});

const builtIn = builtInPlugins.map(({ id }) => id);

async function listed(
  server: ReturnType<typeof testServer>,
): Promise<readonly PluginInfo[]> {
  return json<PluginInfo[]>(server.api("/api/plugins"));
}

test("a server with every plugin off signs people in, keeps its own pages and refuses a Session it can't place", async () => {
  const server = testServer({ disabledPlugins: builtIn });

  for (const path of [
    "/api/auth",
    "/api/people",
    "/api/environments",
    "/api/profiles",
    "/api/settings/team",
    "/api/plugins",
  ]) {
    expect({ path, status: (await server.api(path)).status }).toEqual({
      path,
      status: 200,
    });
  }

  expect((await listed(server)).filter(({ state }) => state !== "off")).toEqual(
    [],
  );

  const started = await server.api("/api/sessions", {
    body: {
      environment: "nowhere",
      workspace: { kind: "folder", path: "/work" },
    },
  });

  expect({ status: started.status, body: await started.json() }).toEqual({
    status: 400,
    body: {
      error: "unknown_environment",
      message: "There is no such Environment.",
    },
  });
});

test("a server with any one plugin off loads the rest", async () => {
  const everyOn = new Map(
    (await listed(testServer())).map((each) => [each.id, each.state]),
  );

  for (const off of builtIn) {
    const server = testServer({ disabledPlugins: [off] });

    const changed = (await listed(server)).flatMap(({ id, state, error }) =>
      id === off || state === everyOn.get(id) ? [] : [{ id, state, error }],
    );

    expect({ off, changed }).toEqual({
      off,
      changed: changed.filter(
        ({ error }) => error?.endsWith(`needs ${off}, which is off`) === true,
      ),
    });

    await server.close();
  }
});

// A plugin whose code throws whenever the kernel calls it.
const throwing = defineServer(
  definePlugin({
    id: "throwing",
    title: "Throwing",
    description: "",
  }),
  ({ provide }) => {
    provide.models(() => {
      throw new Error("no models today");
    });

    provide.gitCredentials(() => {
      throw new Error("no logins today");
    });
  },
);

test("a plugin that throws when the kernel calls it offers nothing, and Environments still list", async () => {
  const server = testServer({ servers: [throwing] });

  const made = await server.api("/api/environments", {
    body: { name: "mine" },
  });

  expect(made.status).toBe(201);
  expect((await server.api("/api/environments")).status).toBe(200);

  expect(
    server.logs.filter((line) => line.startsWith("plugin call failed")),
  ).toContain(
    'plugin call failed {"plugin":"throwing","call":"offeredModels","error":"no models today"}',
  );
});
