import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "./serve";
import { firstUser } from "./testdata/sign-in";

let root: string;
let server: ReturnType<typeof serve>;
let pedro: () => Promise<string>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "newcomers-"));

  const logs: string[] = [];

  server = serve({
    port: 0,
    database: ":memory:",
    configDir: join(root, "config"),
    sessions: { pollWaitMs: 0 },
    log: (message, fields) => {
      logs.push(`${message} ${JSON.stringify(fields)}`);
    },
  });

  pedro = firstUser(server, logs);
});

afterEach(async () => {
  await server.stop();
  await rm(root, { recursive: true, force: true });
});

async function newcomers(body?: unknown): Promise<Response> {
  return fetch(new URL("/api/newcomers", server.url), {
    method: body === undefined ? "GET" : "PUT",
    headers: {
      cookie: await pedro(),
      ...(body !== undefined && { "content-type": "application/json" }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
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
