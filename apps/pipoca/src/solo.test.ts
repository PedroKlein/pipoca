import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auth, InvalidCredentials } from "./auth";
import { serve } from "./serve";
import { openStore } from "./store";

let root: string;
let socket: string;
let logs: string[];
let server: ReturnType<typeof serve>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pipoca-solo-"));
  socket = join(root, "run", "pipoca.sock");
  logs = [];

  server = serve({
    port: 0,
    database: ":memory:",
    solo: { name: "pedro", socket },
    log: (message) => {
      logs.push(message);
    },
  });
});

afterEach(async () => {
  await server.stop();
  await rm(root, { recursive: true, force: true });
});

async function askForLink(): Promise<URL> {
  const response = await fetch("http://localhost/link", {
    method: "POST",
    unix: socket,
  });

  return new URL(((await response.json()) as { url: string }).url);
}

// A solo install has one admin from the start and no setup link; its person
// signs in through a link only their own system user can ask for (ADR 0053).
test("signs a solo install's one user in through a one-time link from its socket", async () => {
  const link = await askForLink();
  const visit = await fetch(link, { redirect: "manual" });
  const cookie = visit.headers.get("set-cookie")?.split(";")[0] ?? "";

  const status = (await (
    await fetch(new URL("/api/auth", server.url), { headers: { cookie } })
  ).json()) as { user: { name: string; admin: boolean }; solo: boolean };

  const again = await fetch(link, { redirect: "manual" });

  expect(logs).not.toContain("open the setup link to create the first user");
  expect(link.origin).toBe(server.url.origin);
  expect([visit.status, visit.headers.get("location")]).toEqual([303, "/"]);

  expect(status).toMatchObject({
    user: { name: "pedro", admin: true },
    solo: true,
  });

  expect(again.status).toBe(403);
  expect(again.headers.get("set-cookie")).toBeNull();
});

test("makes a solo install's socket and its folder reachable only by the server's own user", async () => {
  const [socketMode, folderMode] = await Promise.all([
    stat(socket).then(({ mode }) => mode & 0o777),
    stat(join(root, "run")).then(({ mode }) => mode & 0o777),
  ]);

  expect(socketMode & 0o077).toBe(0);
  expect(folderMode).toBe(0o700);
});

test("refuses a made-up sign-in link", async () => {
  const visit = await fetch(
    new URL("/api/auth/link/not-a-real-token", server.url),
    { redirect: "manual" },
  );

  expect(visit.status).toBe(403);
});

// Single sign-on plugins add people through the same call, so a solo install
// can't gain a second person that way.
test("adds no second user to a solo install", () => {
  const store = openStore(":memory:");
  const auth = new Auth(store.auth, true, () => Date.now(), "pedro");

  expect(() => auth.createUser("ana", false)).toThrow(InvalidCredentials);
  expect(auth.users().map(({ name }) => name)).toEqual(["pedro"]);

  store.close();
});
