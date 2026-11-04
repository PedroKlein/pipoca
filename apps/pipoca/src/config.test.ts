import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "./serve";
import { firstUser } from "./testdata/sign-in";

interface ConfigView {
  readonly path: string;
  readonly text: string;
  readonly version: string | null;
}

let root: string;
let server: ReturnType<typeof serve>;
let pedro: () => Promise<string>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "config-"));

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

async function config(body?: unknown): Promise<Response> {
  return fetch(new URL("/api/config", server.url), {
    method: body === undefined ? "GET" : "PUT",
    headers: {
      cookie: await pedro(),
      ...(body !== undefined && { "content-type": "application/json" }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}

test("an admin edits pipoca.json, and plugins read the new values", async () => {
  const opened = (await (await config()).json()) as ConfigView;

  expect(opened.path).toBe(join(root, "config", "pipoca.json"));

  const text = JSON.stringify({
    oidc: {
      providers: [
        {
          id: "ias",
          label: "Sign in with IAS",
          issuer: "https://ias.example.com",
          clientId: "pipoca",
        },
      ],
    },
  });

  const saved = await config({ text, version: opened.version });

  expect(saved.status).toBe(200);
  expect(await readFile(opened.path, "utf8")).toBe(`${text}\n`);

  const providers = (await (
    await fetch(new URL("/api/plugins/oidc/providers", server.url), {
      headers: { cookie: await pedro() },
    })
  ).json()) as { label: string }[];

  expect(providers.map(({ label }) => label)).toEqual(["Sign in with IAS"]);
});

test("refuses text that isn't a JSON object, and an edit of a file that changed since", async () => {
  const opened = (await (await config()).json()) as ConfigView;

  const broken = await config({ text: "{ nope", version: opened.version });
  expect(broken.status).toBe(400);

  const list = await config({ text: "[]", version: opened.version });
  expect(list.status).toBe(400);

  await writeFile(opened.path, '{"by": "hand"}\n');

  const stale = await config({ text: "{}", version: opened.version });
  expect(stale.status).toBe(409);
  expect(await readFile(opened.path, "utf8")).toBe('{"by": "hand"}\n');
});

test("keeps the file to admins", async () => {
  const response = await fetch(new URL("/api/config", server.url));

  expect(response.status).toBe(401);
});
