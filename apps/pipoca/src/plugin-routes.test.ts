import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpError } from "@pipoca/plugins";
import { pluginClient } from "@pipoca/plugins/host";
import {
  type Invite,
  readSse,
  type Session,
  type SignInStatus,
} from "@pipoca/protocol";
import {
  closeServers,
  json,
  testServer,
  type TestServer,
} from "./testdata/harness";
import { server as diary } from "./testdata/diary-server";
import { server as notes } from "./testdata/notes-server";
import { runnerCredentials } from "./testdata/runners";

let root: string;
let server: TestServer;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "plugin-routes-"));
  server = testServer({ builtIns: false, servers: [notes, diary] });
});

afterEach(async () => {
  await closeServers();
  await rm(root, { recursive: true, force: true });
});

function as(cookie?: string): ReturnType<typeof pluginClient> {
  return pluginClient(notes.plugin, {
    server: server.url,
    ...(cookie !== undefined && { headers: { cookie } }),
  });
}

async function status(call: Promise<unknown>): Promise<number> {
  return call.then(
    () => 200,
    (error: unknown) => (error instanceof HttpError ? error.status : 0),
  );
}

async function member(name: string): Promise<string> {
  const [link] = await json<(Invite & { token: string })[]>(
    server.api("/api/invites", { body: { admin: false, days: 1 } }),
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

async function sessionCaller(): Promise<ReturnType<typeof pluginClient>> {
  const token = await runnerCredentials(server, server.signedIn).token("vm");

  const [environment] = await json<{ id: string }[]>(
    server.api("/api/environments"),
  );

  const session = await json<Session>(
    server.api("/api/sessions", {
      body: {
        environment: environment?.id,
        workspace: { kind: "folder", path: root },
      },
    }),
  );

  return pluginClient(notes.plugin, {
    server: server.url,
    session: session.id,
    headers: { authorization: `Bearer ${token}` },
  });
}

function signed(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

async function hook(
  body: string,
  signature: string,
  headers: Readonly<Record<string, string>> = {},
): Promise<{ readonly status: number; readonly body: unknown }> {
  const response = await fetch(
    new URL("/api/ext/notes/hooks/github", server.url),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signature,
        ...headers,
      },
      body,
    },
  );

  return { status: response.status, body: await response.json() };
}

test("a person route answers 401 to someone signed out and names who called", async () => {
  const cookie = await server.signedIn();

  expect(await status(as().get("whoami"))).toBe(401);

  expect(await as(cookie).get("whoami")).toMatchObject({
    kind: "person",
    person: "pedro",
  });
});

test("an admin route answers 403 to a person who isn't an admin", async () => {
  const cookie = await server.signedIn();
  const ana = await member("ana");

  expect(await status(as(ana).put("settings", {}))).toBe(403);
  expect(await status(as(cookie).put("settings", {}))).toBe(200);
});

test("a Session route answers 403 to a browser and serves the plugin's Session", async () => {
  const cookie = await server.signedIn();
  const session = await sessionCaller();

  expect(await status(as(cookie).post("beats", {}))).toBe(403);
  expect(await session.post("beats", {})).toMatchObject({ kind: "session" });
});

test("a person route answers 403 to a Session, even one a person started", async () => {
  const session = await sessionCaller();

  expect(await status(session.get("whoami"))).toBe(403);
});

test("a public route answers anyone and sees who signed in", async () => {
  const cookie = await server.signedIn();

  expect(await as().get("hello")).toEqual({
    kind: "public",
    person: null,
    owner: null,
  });

  expect(await as(cookie).get("hello")).toMatchObject({ person: "pedro" });
});

test("a public route makes its own URLs", async () => {
  const first = await fetch(new URL("/api/ext/notes/callback", server.url));

  expect(await first.json()).toEqual({
    url: new URL("/api/ext/notes/callback", server.url).href,
  });
});

test("a webhook answers 401 to a body it didn't sign and 413 to one over its limit", async () => {
  const body = JSON.stringify({ text: "pushed" });
  const large = JSON.stringify({ text: "x".repeat(100) });

  expect(await hook(body, signed(body, "s3cret"))).toEqual({
    status: 200,
    body: { name: "github", text: "pushed" },
  });

  expect(await hook(body, signed(body, "guess"))).toMatchObject({
    status: 401,
    body: { error: "bad_signature" },
  });

  expect(await hook(large, signed(large, "s3cret"))).toMatchObject({
    status: 413,
    body: { error: "too_large" },
  });
});

// Someone who captured a delivery can't send it again: not one with the same
// delivery id, and not one whose signed timestamp is over 5 minutes old.
test("a webhook refuses a delivery it took already or one signed too long ago", async () => {
  const body = JSON.stringify({ text: "pushed" });
  const signature = signed(body, "s3cret");
  const first = { "x-github-delivery": "d-1" };

  expect((await hook(body, signature, first)).status).toBe(200);

  expect(await hook(body, signature, first)).toMatchObject({
    status: 409,
    body: { error: "replayed" },
  });

  expect(
    (await hook(body, signature, { "x-github-delivery": "d-2" })).status,
  ).toBe(200);

  const at = (ms: number): Record<string, string> => ({
    "x-pipoca-timestamp": String(Math.floor(ms / 1000)),
  });

  const now = Date.now();
  const stale = now - 6 * 60_000;

  expect(
    (
      await hook(
        body,
        signed(`${String(Math.floor(now / 1000))}.${body}`, "s3cret"),
        at(now),
      )
    ).status,
  ).toBe(200);

  expect(await hook(body, signature, at(now))).toMatchObject({
    status: 401,
    body: { error: "bad_signature" },
  });

  expect(
    await hook(
      body,
      signed(`${String(Math.floor(stale / 1000))}.${body}`, "s3cret"),
      at(stale),
    ),
  ).toMatchObject({ status: 401, body: { error: "stale_delivery" } });
});

test("a body that doesn't fit the route's schema answers 422 naming the field", async () => {
  const cookie = await server.signedIn();

  const response = await server.api("/api/ext/notes/notes", {
    body: { text: 3 },
  });

  expect(response.status).toBe(422);

  expect(await response.json()).toMatchObject({
    error: "invalid",
    field: "text",
  });

  expect(await as(cookie).post("notes", { text: "milk" })).toEqual({
    text: "milk",
  });
});

test("a team route serves the caller's own owner and, while the plugin is on in team work, the team", async () => {
  const cookie = await server.signedIn();
  const { user } = await json<SignInStatus>(server.api("/api/auth"));
  const id = user?.id ?? "";

  expect(await as(cookie).get("lists")).toEqual({ owner: `person:${id}` });
  expect(await as(cookie).get("team/lists")).toEqual({ owner: "team" });

  const pages = pluginClient(diary.plugin, {
    server: server.url,
    headers: { cookie },
  });

  expect(await pages.get("pages")).toEqual({ owner: `person:${id}` });
  expect(await pages.get("team/pages")).toEqual({ owner: "team" });

  await server.api("/api/plugins/notes", {
    method: "PATCH",
    body: { teamWork: false },
  });

  expect(await status(as(cookie).get("team/lists"))).toBe(404);
});

test("a route publishes its change topics only when it succeeds", async () => {
  const cookie = await server.signedIn();
  const response = await server.api("/api/changes");
  const topics: string[] = [];

  const reading = (async () => {
    for await (const event of readSse(response)) {
      topics.push((event as { topic: string }).topic);

      if (topics.includes("notes.notes")) {
        break;
      }
    }
  })();

  expect(await status(as(cookie).post("notes", { text: "" }))).toBe(422);
  expect(await status(as(cookie).post("notes", { text: "fail" }))).toBe(400);
  await as(cookie).post("marks");
  await as(cookie).post("notes", { text: "milk" });
  await reading;

  expect(topics.filter((topic) => topic.startsWith("notes."))).toEqual([
    "notes.marks",
    "notes.notes",
  ]);
});
