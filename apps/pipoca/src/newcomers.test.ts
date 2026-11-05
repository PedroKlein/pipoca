import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testServer, type TestServer } from "./testdata/harness";

let root: string;
let server: TestServer;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "newcomers-"));

  server = testServer({
    configDir: join(root, "config"),
    sessions: { pollWaitMs: 0 },
  });
});

afterEach(async () => {
  await server.close();
  await rm(root, { recursive: true, force: true });
});

async function newcomers(body?: unknown): Promise<Response> {
  return server.api("/api/newcomers", {
    method: body === undefined ? "GET" : "PUT",
    body,
  });
}

test("an admin keeps what new people get in pipoca.json", async () => {
  expect(await (await newcomers()).json()).toEqual({
    template: null,
    profiles: [],
    required: [],
  });

  const chosen = {
    template: "pods",
    profiles: ["backend", "backend"],
    required: ["git-hosts"],
  };

  expect((await newcomers(chosen)).status).toBe(200);

  const saved = { ...chosen, profiles: ["backend"] };

  expect(await (await newcomers()).json()).toEqual(saved);

  expect(
    JSON.parse(await readFile(join(root, "config", "pipoca.json"), "utf8")),
  ).toEqual({ newcomers: saved });
});

test("refuses what new people get when it doesn't fit", async () => {
  expect((await newcomers({ profiles: "backend" })).status).toBe(400);
  expect((await newcomers({ template: 3 })).status).toBe(400);
});

test("keeps what new people get to signed-in people", async () => {
  expect((await fetch(new URL("/api/newcomers", server.url))).status).toBe(401);
});
