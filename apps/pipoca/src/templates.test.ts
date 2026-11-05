import { afterEach, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type Assignment,
  type Environment,
  type EnvironmentTemplate,
  type Joined,
  protocolVersion,
  versionHeader,
} from "@pipoca/protocol";
import { json, testServer, type TestServer } from "./testdata/harness";

let root: string;
let server: TestServer;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "templates-"));
});

afterEach(async () => {
  await server.close();
  await rm(root, { recursive: true, force: true });
});

function start(): void {
  server = testServer({
    database: join(root, "server.db"),
    configDir: join(root, "config"),
    runners: { pollWaitMs: 0 },
  });
}

// Signs in a second user, who isn't an admin, and returns their cookie.
async function ana(): Promise<string> {
  await server.signedIn();

  const db = new DatabaseSync(join(root, "server.db"));

  db.prepare(
    "insert into users (id, name, password_hash, created_at, admin) values (?, 'ana', ?, ?, 0)",
  ).run(randomUUID(), await Bun.password.hash("battery staple"), Date.now());

  db.close();

  const response = await fetch(new URL("/api/auth/login", server.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "ana", password: "battery staple" }),
  });

  return response.headers.get("set-cookie")?.split(";")[0] ?? "";
}

const pods = {
  name: "Cluster pods",
  setupScript: "apt-get install -y ripgrep",
  variables: { REGION: "eu", TEAM: "core" },
};

test("only admins change templates, and everyone reads them", async () => {
  start();
  const anas = await ana();

  expect((await server.as(anas)("/api/templates", { body: pods })).status).toBe(
    403,
  );

  const made = await json<EnvironmentTemplate>(
    server.api("/api/templates", { body: pods }),
  );

  expect(made).toEqual({
    id: "cluster-pods",
    isolation: "process",
    image: null,
    aliases: null,
    source: null,
    ...pods,
  });

  expect(
    (
      await server.as(anas)(`/api/templates/${made.id}`, {
        method: "PATCH",
        body: { name: "x" },
      })
    ).status,
  ).toBe(403);

  expect(
    (
      await server.api(`/api/templates/${made.id}`, {
        method: "PATCH",
        body: { name: "Pods" },
      })
    ).status,
  ).toBe(200);

  expect(await json(server.as(anas)("/api/templates"))).toEqual([
    { ...made, name: "Pods", runnersFrom: null },
  ]);

  expect(
    (await server.api("/api/templates", { body: { ...pods, secrets: {} } }))
      .status,
  ).toBe(400);
});

test("runs a person's Environment as its template says, with their own variables on top", async () => {
  start();
  const anas = await ana();

  const template = await json<EnvironmentTemplate>(
    server.api("/api/templates", { body: pods }),
  );

  const { environment, key } = await json<{
    environment: Environment;
    key: string;
  }>(
    server.as(anas)("/api/environments", {
      body: { name: "mine", template: template.id },
    }),
  );

  expect(environment).toMatchObject({
    templateId: template.id,
    setupScript: pods.setupScript,
  });

  await server.as(anas)(`/api/environments/${environment.id}`, {
    method: "PATCH",
    body: { variables: { TEAM: "ana" }, secrets: { TOKEN: "s3cret" } },
  });

  expect(
    (
      await server.as(anas)(`/api/environments/${environment.id}`, {
        method: "PATCH",
        body: { setupScript: "true" },
      })
    ).status,
  ).toBe(409);

  await server.as(anas)("/api/sessions", {
    body: {
      environment: environment.id,
      workspace: { kind: "folder", path: root },
    },
  });

  const { token } = await json<Joined>(
    fetch(new URL("/agent/join", server.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [versionHeader]: String(protocolVersion),
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ name: "laptop" }),
    }),
  );

  const { start: assignments } = await json<{ start: Assignment[] }>(
    fetch(new URL("/agent/work", server.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [versionHeader]: String(protocolVersion),
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ running: [], folders: [root], models: [] }),
    }),
  );

  expect(assignments[0]?.environment).toEqual({
    isolation: "process",
    image: null,
    setupScript: pods.setupScript,
    variables: { REGION: "eu", TEAM: "ana", TOKEN: "s3cret" },
  });

  expect(
    (
      await server.as(anas)("/api/environments", {
        body: {
          name: "other",
          template: "nowhere",
        },
      })
    ).status,
  ).toBe(400);
});

test("reads templates an admin wrote into pipoca.json", async () => {
  await mkdir(join(root, "config"), { recursive: true });

  await writeFile(
    join(root, "config", "pipoca.json"),
    JSON.stringify({
      templates: [
        { id: "vm", name: "VM", image: "debian:12", isolation: "container" },
        { name: "no id" },
      ],
    }),
  );

  start();

  expect(await json(server.api("/api/templates"))).toEqual([
    {
      id: "vm",
      name: "VM",
      isolation: "container",
      image: "debian:12",
      setupScript: "",
      aliases: null,
      source: null,
      variables: {},
      runnersFrom: null,
    },
  ]);
});

test("offers a template's model aliases on Environments made from it", async () => {
  await mkdir(join(root, "config"), { recursive: true });

  await writeFile(
    join(root, "config", "pipoca.json"),
    JSON.stringify({
      templates: [
        {
          id: "team",
          name: "Team",
          aliases: {
            models: { fast: ["openai/gpt-5-mini"] },
            defaultAlias: "fast",
          },
        },
      ],
    }),
  );

  start();
  const anas = await ana();

  await json(
    server.as(anas)("/api/environments", {
      body: { name: "mine", template: "team" },
    }),
  );

  const [environment] = await json<Environment[]>(
    server.as(anas)("/api/environments"),
  );

  expect(environment?.models.map(({ id }) => id)).toContain("fast");
});
