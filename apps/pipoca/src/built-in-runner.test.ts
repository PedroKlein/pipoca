import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { definePlugin, defineServer } from "@pipoca/plugins";
import type { Environment } from "@pipoca/protocol";
import { testServer } from "./testdata/harness";

// Starts runners for every Environment, the way a cluster's plugin does.
const pods = defineServer(
  definePlugin({ id: "pods", title: "Pods", description: "" }),
  ({ provide }) => {
    provide.runners({
      kind: { label: "Pods", icon: "cloud" },
      starts: () => true,
      replacesServerRunner: () => true,
    });
  },
);

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "built-in-runner-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("runs no runner of its own where a plugin replaces it (ADR 0049)", async () => {
  const logs: string[] = [];

  const server = testServer({
    database: join(root, "server.db"),
    configDir: join(root, "config"),
    agent: {
      provider: "server",
      dataDir: join(root, "server"),
      extensionPaths: [],
      folders: [],
    },
    plugins: [],
    servers: [pods],
    log: (message) => {
      logs.push(message);
    },
  });

  await server.close();

  expect(logs).toContain(
    "the server's own runner is off, since a plugin replaces it",
  );

  const db = new DatabaseSync(join(root, "server.db"));
  const environments = db.prepare("select slug from environments").all();
  db.close();

  expect(environments).toEqual([]);
});

test("makes its own runner's Environment for the first person, once they sign up (ADR 0049)", async () => {
  const server = testServer({
    agent: {
      provider: "server",
      dataDir: join(root, "server"),
      extensionPaths: [],
      folders: [],
    },
  });

  const { user } = (await (await server.api("/api/auth")).json()) as {
    user: { id: string };
  };

  const environments = (await (
    await server.api("/api/environments")
  ).json()) as Environment[];

  await server.close();

  expect(
    environments.map(({ provider, ownerId }) => [provider, ownerId]),
  ).toEqual([["server", user.id]]);
});

test("says which plugin starts an Environment's runners, and with what label and icon", async () => {
  const server = testServer({ plugins: [], servers: [pods] });

  try {
    const made = (await (
      await server.api("/api/environments", { body: { name: "cluster" } })
    ).json()) as Environment;

    const [listed] = (await (
      await server.api("/api/environments")
    ).json()) as Environment[];

    expect({
      id: listed?.id,
      onDemand: listed?.onDemand,
      runnersFrom: listed?.runnersFrom,
    }).toEqual({
      id: made.id,
      onDemand: true,
      runnersFrom: { plugin: "pods", label: "Pods", icon: "cloud" },
    });
  } finally {
    await server.close();
  }
});
