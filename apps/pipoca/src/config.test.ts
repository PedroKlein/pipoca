import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testServer, type TestServer } from "./testdata/harness";

interface ConfigEntry {
  readonly name: string;
  readonly locked: boolean;
}

interface ConfigText extends ConfigEntry {
  readonly text: string;
  readonly version: string | null;
}

const ias = {
  providers: [
    {
      id: "ias",
      label: "Sign in with IAS",
      issuer: "https://ias.example.com",
      clientId: "pipoca",
    },
  ],
};

let root: string;
let server: TestServer;

function start(lockedConfig?: string): void {
  server = testServer({
    configDir: join(root, "config"),
    ...(lockedConfig !== undefined && { lockedConfig }),
    sessions: { pollWaitMs: 0 },
  });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "config-"));
});

afterEach(async () => {
  await server.close();
  await rm(root, { recursive: true, force: true });
});

async function open(name: string): Promise<ConfigText> {
  return (await (
    await server.api(`/api/config/file?name=${encodeURIComponent(name)}`)
  ).json()) as ConfigText;
}

async function save(
  name: string,
  text: string,
  version: string | null,
): Promise<Response> {
  return server.api("/api/config/file", {
    method: "PUT",
    body: { name, text, version },
  });
}

async function labels(): Promise<readonly string[]> {
  const providers = (await (
    await server.api("/api/plugins/oidc/providers")
  ).json()) as { label: string }[];

  return providers.map(({ label }) => label);
}

test("an admin edits pipoca.json, and plugins read the new values", async () => {
  start();

  const opened = await open("pipoca.json");
  const text = JSON.stringify({ oidc: ias });

  expect((await save("pipoca.json", text, opened.version)).status).toBe(200);

  expect(await readFile(join(root, "config", "pipoca.json"), "utf8")).toBe(
    `${text}\n`,
  );

  expect(await labels()).toEqual(["Sign in with IAS"]);
});

test("refuses text that isn't a JSON object, and an edit of a file that changed since", async () => {
  start();

  const opened = await open("pipoca.json");
  const path = join(root, "config", "pipoca.json");

  expect((await save("pipoca.json", "{ nope", opened.version)).status).toBe(
    400,
  );

  expect((await save("pipoca.json", "[]", opened.version)).status).toBe(400);

  await mkdir(join(root, "config"), { recursive: true });
  await writeFile(path, '{"by": "hand"}\n');

  expect((await save("pipoca.json", "{}", opened.version)).status).toBe(409);
  expect(await readFile(path, "utf8")).toBe('{"by": "hand"}\n');
});

test("lists shared Profiles to edit, and leaves people's own folders out", async () => {
  start();

  const config = join(root, "config");
  await mkdir(join(config, "profiles", "default"), { recursive: true });
  await mkdir(join(config, "people", "someone"), { recursive: true });
  await writeFile(join(config, "profiles", "default", "AGENTS.md"), "Hi\n");
  await writeFile(join(config, "people", "someone", "AGENTS.md"), "Mine\n");

  const listed = (await (await server.api("/api/config")).json()) as {
    files: ConfigEntry[];
  };

  expect(listed.files.map(({ name }) => name)).toEqual([
    "pipoca.json",
    "profiles/default/AGENTS.md",
  ]);

  const agents = await open("profiles/default/AGENTS.md");
  expect(agents.text).toBe("Hi\n");

  expect(
    (await save("profiles/default/AGENTS.md", "Hello", agents.version)).status,
  ).toBe(200);

  expect(
    await readFile(join(config, "profiles", "default", "AGENTS.md"), "utf8"),
  ).toBe("Hello\n");

  expect((await save("people/someone/AGENTS.md", "x", null)).status).toBe(400);
  expect((await save("../escape.json", "{}", null)).status).toBe(400);

  expect(
    (await server.api("/api/config/file?name=people%2Fsomeone%2FAGENTS.md"))
      .status,
  ).toBe(404);
});

test("a locked file's keys win, show read-only, and can't be changed from Settings", async () => {
  const locked = join(root, "locked.json");
  await writeFile(locked, JSON.stringify({ oidc: ias }));
  start(locked);

  const opened = await open("pipoca.json");

  const own = JSON.stringify({
    oidc: { providers: [{ ...ias.providers[0], label: "Mine" }] },
  });

  expect((await save("pipoca.json", own, opened.version)).status).toBe(200);
  expect(await labels()).toEqual(["Sign in with IAS"]);

  const account = (await (
    await server.api("/api/plugins/oidc/account")
  ).json()) as { lockedIn: string | null };

  expect(account.lockedIn).toBe(locked);

  const listed = (await (await server.api("/api/config")).json()) as {
    files: ConfigEntry[];
  };

  expect(listed.files).toContainEqual({ name: locked, locked: true });
  expect((await open(locked)).locked).toBe(true);
  expect((await save(locked, "{}", null)).status).toBe(400);

  const added = await server.api("/api/plugins/oidc/providers", {
    body: {
      label: "Another",
      issuer: "https://other.example.com",
      clientId: "x",
    },
  });

  expect(added.ok).toBe(false);
  expect(await added.text()).toContain("can't change here");
  expect(await labels()).toEqual(["Sign in with IAS"]);
});

test("keeps the files to admins", async () => {
  start();

  expect((await fetch(new URL("/api/config", server.url))).status).toBe(401);

  expect(
    (await fetch(new URL("/api/config/file?name=pipoca.json", server.url)))
      .status,
  ).toBe(401);
});
