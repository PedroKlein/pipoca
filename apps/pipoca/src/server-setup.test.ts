import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Invite } from "@pipoca/protocol";
import { json, testServer, type TestServer } from "./testdata/harness";

let root: string;
let server: TestServer;

const options = (): Parameters<typeof testServer>[0] => ({
  database: join(root, "server.db"),
  configDir: join(root, "config"),
  runners: { pollWaitMs: 0 },
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "server-setup-"));
  server = testServer(options());
});

afterEach(async () => {
  await server.close();
  await rm(root, { recursive: true, force: true });
});

async function serverSetup(body?: unknown, as = server.api): Promise<Response> {
  return as(
    "/api/settings/server-setup",
    body === undefined ? {} : { method: "PATCH", body },
  );
}

// Someone who joins through an invite link, as the role it names.
async function invited(name: string, admin: boolean): Promise<string> {
  const [link] = await json<(Invite & { token: string })[]>(
    server.api("/api/invites", { body: { admin } }),
  );

  const joined = await fetch(
    new URL(`/api/auth/invites/${link?.token ?? ""}`, server.url),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, password: "correct horse" }),
    },
  );

  return joined.headers.get("set-cookie")?.split(";")[0] ?? "";
}

async function setupOf(cookie: string): Promise<unknown> {
  return json(server.as(cookie)("/api/me/setup"));
}

test("an admin has the server's setup ahead until an admin finishes it, and no one else ever does", async () => {
  const pedro = await server.signedIn();
  const ana = await invited("ana", true);
  const bea = await invited("bea", false);

  expect(await setupOf(pedro)).toMatchObject({ serverPending: true });
  expect(await setupOf(ana)).toMatchObject({ serverPending: true });
  expect(await setupOf(bea)).toMatchObject({ serverPending: false });

  expect(await json(serverSetup())).toEqual({
    usedBy: null,
    solo: false,
    finished: false,
  });

  expect(await json(serverSetup({ finished: true }, server.as(ana)))).toEqual({
    usedBy: null,
    solo: false,
    finished: true,
  });

  expect(await setupOf(pedro)).toEqual({
    finished: false,
    dismissed: [],
    serverPending: false,
  });
});

test("keeps who the server is for in pipoca.json, beside the server's other options", async () => {
  mkdirSync(join(root, "config"), { recursive: true });

  await writeFile(
    join(root, "config", "pipoca.json"),
    JSON.stringify({ server: { sessionDays: 7 } }),
  );

  expect(await json(serverSetup({ usedBy: "team" }))).toMatchObject({
    usedBy: "team",
  });

  expect(
    JSON.parse(await readFile(join(root, "config", "pipoca.json"), "utf8")),
  ).toEqual({ server: { sessionDays: 7, usedBy: "team" } });

  expect((await serverSetup({ usedBy: "everyone" })).status).toBe(422);
  expect((await serverSetup({ finished: false })).status).toBe(422);
});

test("remembers that the server's setup is finished after a restart", async () => {
  await serverSetup({ usedBy: "me", finished: true });
  const cookie = await server.signedIn();
  await server.close();

  server = testServer({ ...options(), cookie, clock: server.clock });

  expect(await json(serverSetup())).toEqual({
    usedBy: "me",
    solo: false,
    finished: true,
  });

  expect(await setupOf(cookie)).toMatchObject({ serverPending: false });
});

test("only admins see or change the server's setup", async () => {
  await server.signedIn();
  const bea = await invited("bea", false);

  expect((await serverSetup(undefined, server.as(bea))).status).toBe(403);

  expect((await serverSetup({ finished: true }, server.as(bea))).status).toBe(
    403,
  );

  expect(await json(serverSetup())).toMatchObject({ finished: false });
});

test("a solo install is just for its person and can't be opened to a team", async () => {
  await server.close();
  const socket = join(root, "run", "pipoca.sock");
  server = testServer({ ...options(), solo: { name: "pedro", socket } });

  const link = (await (
    await fetch("http://localhost/link", { method: "POST", unix: socket })
  ).json()) as { url: string };

  const visit = await fetch(link.url, { redirect: "manual" });
  const cookie = visit.headers.get("set-cookie")?.split(";")[0] ?? "";
  const as = server.as(cookie);

  expect(await setupOf(cookie)).toMatchObject({ serverPending: true });

  expect(await json(serverSetup(undefined, as))).toEqual({
    usedBy: "me",
    solo: true,
    finished: false,
  });

  const team = await serverSetup({ usedBy: "team" }, as);

  expect(team.status).toBe(409);
  expect(await team.json()).toMatchObject({ error: "solo_install" });
});
