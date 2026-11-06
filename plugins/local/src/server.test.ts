import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmod,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Environment, Session } from "@pipoca/protocol";
import { type PluginTest, testPlugin, until } from "@pipoca/testing";
import type { LocalEnvironment } from "./settings";
import { server } from "./server";

const people = [{ id: "ana", name: "Ana" }, { id: "bo" }];
const passMs = 1000;
const thisMachine = { plugin: "local", label: "This machine", icon: "monitor" };

let root: string;
let calls: string;
let t: PluginTest | undefined;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "pipoca-local-")));
  calls = join(root, "calls");
});

afterEach(async () => {
  await t?.close();
  t = undefined;
  await rm(root, { recursive: true, force: true });
});

// A stand-in for the pipoca binary that writes down how it was run, then
// stays up as a runner does or exits with the code.
async function binary(exitCode?: number): Promise<string> {
  const path = join(root, "pipoca");

  const then =
    exitCode === undefined ? "exec sleep 600" : `exit ${String(exitCode)}`;

  await writeFile(
    path,
    `#!/bin/sh\necho "$PIPOCA_TOKEN $*" >> '${calls}'\n${then}\n`,
  );

  await chmod(path, 0o755);

  return path;
}

async function started(): Promise<readonly string[]> {
  const text = await readFile(calls, "utf8").catch(() => "");

  return text.split("\n").filter((line) => line !== "");
}

async function start(
  o: { readonly solo?: boolean; readonly exitCode?: number } = {},
): Promise<PluginTest> {
  t = await testPlugin(server, {
    people,
    command: [await binary(o.exitCode)],
    ...(o.solo === true && { solo: true }),
  });

  return t;
}

async function json<T>(response: Promise<Response>): Promise<T> {
  const answered = await response;

  if (!answered.ok) {
    throw new Error(`${String(answered.status)}: ${await answered.text()}`);
  }

  return (await answered.json()) as T;
}

async function environments(pt: PluginTest): Promise<readonly Environment[]> {
  return json(pt.as("ana").raw("/api/environments", { method: "GET" }));
}

async function environment(
  pt: PluginTest,
  name = "laptop",
): Promise<Environment> {
  return json(
    pt.as("ana").raw("/api/environments", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  );
}

async function startSession(
  pt: PluginTest,
  environmentId: string,
): Promise<Session> {
  return json(
    pt.as("ana").raw("/api/sessions", {
      method: "POST",
      body: JSON.stringify({
        environment: environmentId,
        workspace: { kind: "folder", path: root },
      }),
    }),
  );
}

async function save(
  pt: PluginTest,
  environmentId: string,
  settings: object | null,
  as = "ana",
): Promise<Response> {
  return pt.as(as).raw(`environments/${environmentId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ settings }),
  });
}

async function shown(
  pt: PluginTest,
  environmentId: string,
): Promise<LocalEnvironment> {
  return json(
    pt.as("ana").raw(`environments/${environmentId}`, { method: "GET" }),
  );
}

test("starts a solo install's runner on this machine when a Session needs one", async () => {
  const pt = await start({ solo: true });
  const [own] = await environments(pt);

  expect(own).toMatchObject({
    name: "This machine",
    onDemand: true,
    runnersFrom: thisMachine,
  });

  await pt.clock.advance(passMs);
  expect(await started()).toEqual([]);

  await startSession(pt, own?.id ?? "");
  await pt.clock.advance(passMs);

  const [call] = await until(started, (lines) => lines.length > 0);
  const [token, ...args] = call?.split(" ") ?? [];

  expect(token).not.toBe("");

  expect(args as unknown[]).toEqual([
    "agent",
    "--name",
    "this-machine",
    "--server",
    expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/$/),
    "--capacity",
    "4",
    "--exit-when-idle",
    "300",
    "--data-dir",
    expect.stringMatching(new RegExp(`/${own?.id ?? ""}$`)),
  ]);

  await pt.clock.advance(passMs * 3);

  expect(await started()).toHaveLength(1);
});

test("starts runners only for an Environment with settings, with its own capacity and folders", async () => {
  const pt = await start();
  const laptop = await environment(pt);

  expect((await environments(pt))[0]).toMatchObject({
    onDemand: false,
    runnersFrom: null,
  });

  await startSession(pt, laptop.id);
  await pt.clock.advance(passMs);
  expect(await started()).toEqual([]);

  expect(
    await json(
      save(pt, laptop.id, { capacity: 2, idleSeconds: 30, folders: [root] }),
    ),
  ).toEqual({
    settings: { capacity: 2, idleSeconds: 30, folders: [root] },
    lastFailure: null,
  });

  expect((await environments(pt))[0]).toMatchObject({
    onDemand: true,
    runnersFrom: thisMachine,
  });

  await pt.clock.advance(passMs);

  const [call] = await until(started, (lines) => lines.length > 0);

  expect(call).toContain("--capacity 2 --exit-when-idle 30 ");
  expect(call).toEndWith(`--folder ${root}`);

  expect(await json(save(pt, laptop.id, null))).toEqual({
    settings: null,
    lastFailure: null,
  });

  expect((await environments(pt))[0]).toMatchObject({
    onDemand: false,
    runnersFrom: null,
  });
});

test("waits longer after each runner that fails, and starts again once it has waited", async () => {
  const pt = await start({ exitCode: 3 });
  const laptop = await environment(pt);

  await save(pt, laptop.id, {});
  await startSession(pt, laptop.id);
  await pt.clock.advance(passMs);

  const first = await until(
    async () => (await shown(pt, laptop.id)).lastFailure,
    (failure) => failure !== null,
  );

  expect(first?.problem).toBe("its runner exited with code 3");

  expect(Date.parse(first?.retryAt ?? "") - Date.parse(first?.at ?? "")).toBe(
    10_000,
  );

  await pt.clock.advance("8s");
  expect(await started()).toHaveLength(1);

  await pt.clock.advance("2s");
  await until(started, (lines) => lines.length === 2);

  const second = await until(
    async () => (await shown(pt, laptop.id)).lastFailure,
    (failure) => failure !== null && failure.at !== first?.at,
  );

  expect(Date.parse(second?.retryAt ?? "") - Date.parse(second?.at ?? "")).toBe(
    20_000,
  );
});

test("answers about an Environment only to its owner", async () => {
  const pt = await start();
  const laptop = await environment(pt);

  expect(
    (await pt.as("bo").raw(`environments/${laptop.id}`, { method: "GET" }))
      .status,
  ).toBe(404);

  expect((await save(pt, laptop.id, {}, "bo")).status).toBe(404);

  expect(await shown(pt, laptop.id)).toEqual({
    settings: null,
    lastFailure: null,
  });
});

test("refuses a folder this machine doesn't have", async () => {
  const pt = await start();
  const laptop = await environment(pt);
  const missing = join(root, "missing");
  const refused = await save(pt, laptop.id, { folders: [missing] });

  expect({
    status: refused.status,
    message: ((await refused.json()) as { message: string }).message,
  }).toEqual({
    status: 400,
    message: `${missing} isn't a folder on this machine`,
  });
});
