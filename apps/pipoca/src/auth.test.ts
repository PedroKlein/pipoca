import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testServer, type TestServer } from "./testdata/harness";
import { setupTokenOf } from "./testdata/sign-in";

let root: string;
let server: TestServer;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pipoca-auth-"));
  server = testServer();
});

afterEach(async () => {
  await server.close();
  await rm(root, { recursive: true, force: true });
});

function cookieOf(response: Response): string {
  return response.headers.get("set-cookie")?.split(";")[0] ?? "";
}

const pedro = { name: "pedro", password: "correct horse" };

async function setUp(): Promise<string> {
  return cookieOf(
    await server.as()("/api/auth/setup", {
      body: { ...pedro, token: setupTokenOf(server.logs) },
    }),
  );
}

test("creates the first user from the one-time setup link and signs them in", async () => {
  const token = setupTokenOf(server.logs);

  expect(await (await server.as()("/api/auth")).json()).toEqual({
    user: null,
    setup: true,
    solo: false,
    passwordLogin: true,
    logins: [],
  });

  const created = await server.as()("/api/auth/setup", {
    body: { ...pedro, token },
  });

  const again = await server.as()("/api/auth/setup", {
    body: { ...pedro, token },
  });

  expect(created.status).toBe(201);

  expect(created.headers.get("set-cookie")).toMatch(
    /^pipoca-session=[\w-]+; Path=\/; Max-Age=\d+; HttpOnly; SameSite=Strict$/,
  );

  expect(
    await (await server.as(cookieOf(created))("/api/auth")).json(),
  ).toEqual({
    user: { id: expect.any(String) as string, name: "pedro", admin: true },
    setup: false,
    solo: false,
    passwordLogin: true,
    logins: [],
  });

  expect(again.status).toBe(403);
});

test("refuses a setup link with the wrong token or a short password", async () => {
  const wrong = await server.as()("/api/auth/setup", {
    body: { ...pedro, token: "guess" },
  });

  const short = await server.as()("/api/auth/setup", {
    body: {
      name: "pedro",
      password: "short",
      token: setupTokenOf(server.logs),
    },
  });

  expect([wrong.status, short.status]).toEqual([403, 400]);

  expect(await (await server.as()("/api/auth")).json()).toMatchObject({
    setup: true,
  });
});

test("refuses the API and terminals without a signed-in browser", async () => {
  const sessions = await server.as()("/api/sessions");

  const others = [
    (await server.as()("/api/sessions/any/events")).status,
    (await server.as()("/api/profiles")).status,
    (await server.as()("/api/ext/projects/projects")).status,
    (await server.as()("/api/sessions", { body: {} })).status,
  ];

  const terminal = await fetch(
    new URL("/api/sessions/any/terminal", server.url),
    { headers: { upgrade: "websocket", connection: "Upgrade" } },
  );

  expect([sessions.status, terminal.status, ...others]).toEqual([
    401, 401, 401, 401, 401, 401,
  ]);

  expect(await sessions.json()).toEqual({
    error: "signed_out",
    message: "Sign in again.",
  });

  expect((await server.as()("/healthz")).status).toBe(200);
  expect((await server.as()("/")).status).toBe(200);
});

test("signs in with a password and out again", async () => {
  await setUp();

  const wrong = await server.as()("/api/auth/session", {
    body: { ...pedro, password: "nope" },
  });

  const unknown = await server.as()("/api/auth/session", {
    body: { ...pedro, name: "ana" },
  });

  const signedIn = await server.as()("/api/auth/session", { body: pedro });
  const cookie = cookieOf(signedIn);

  expect([wrong.status, unknown.status, signedIn.status]).toEqual([
    401, 401, 200,
  ]);

  expect((await server.as(cookie)("/api/sessions")).status).toBe(200);

  const out = await server.as()("/api/auth/session", {
    method: "DELETE",
    headers: { cookie },
  });

  expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
  expect((await server.as(cookie)("/api/sessions")).status).toBe(401);
});

test("keeps a user's name without the spaces around it, and signs in with or without them", async () => {
  const created = await server.as()("/api/auth/setup", {
    body: {
      ...pedro,
      name: " pedro ",
      token: setupTokenOf(server.logs),
    },
  });

  const signedIn = await Promise.all(
    ["pedro", " pedro "].map(async (name) =>
      server.as()("/api/auth/session", { body: { ...pedro, name } }),
    ),
  );

  expect(await created.json()).toMatchObject({ name: "pedro" });
  expect(signedIn.map(({ status }) => status)).toEqual([200, 200]);
});

test("keeps the first user's display name beside their username", async () => {
  const created = await server.as()("/api/auth/setup", {
    body: {
      ...pedro,
      displayName: "  Pedro Klein ",
      token: setupTokenOf(server.logs),
    },
  });

  expect(await (await server.as(cookieOf(created))("/api/me")).json()).toEqual({
    id: expect.any(String) as string,
    name: "pedro",
    displayName: "Pedro Klein",
    admin: true,
    defaultEnvironment: null,
  });
});

test("leaves the display name empty when setup gives none", async () => {
  const cookie = await setUp();

  expect(await (await server.as(cookie)("/api/me")).json()).toMatchObject({
    name: "pedro",
    displayName: null,
  });
});

async function behindProxy(): Promise<void> {
  await server.close();
  server = testServer({ trustProxy: true });
  await setUp();
}

function from(address: string): Record<string, string> {
  return { "x-forwarded-for": `198.51.100.7, ${address}` };
}

test("locks a name after repeated failed sign-ins from one address, but not from another", async () => {
  await behindProxy();

  for (let attempt = 0; attempt < 10; attempt++) {
    await server.as()("/api/auth/session", {
      body: { ...pedro, password: "nope" },
      headers: from("203.0.113.1"),
    });
  }

  const here = await server.as()("/api/auth/session", {
    body: pedro,
    headers: from("203.0.113.1"),
  });

  expect(here.status).toBe(429);

  expect(await here.json()).toEqual({
    error: "locked",
    message: "Too many failed sign-ins. Try again in 15 minutes.",
  });

  const elsewhere = await server.as()("/api/auth/session", {
    body: pedro,
    headers: from("203.0.113.2"),
  });

  expect(elsewhere.status).toBe(200);
});

test("locks an address after failed sign-ins for many names", async () => {
  await behindProxy();

  const guesses = await Promise.all(
    Array.from({ length: 50 }, async (_, attempt) =>
      server.as()("/api/auth/session", {
        body: { name: `guess-${String(attempt)}`, password: "nope" },
        headers: from("203.0.113.1"),
      }),
    ),
  );

  expect(guesses.map(({ status }) => status)).toEqual(
    Array.from({ length: 50 }, () => 401),
  );

  expect(
    (
      await server.as()("/api/auth/session", {
        body: pedro,
        headers: from("203.0.113.1"),
      })
    ).status,
  ).toBe(429);

  expect(
    (
      await server.as()("/api/auth/session", {
        body: pedro,
        headers: from("203.0.113.2"),
      })
    ).status,
  ).toBe(200);
}, 30_000);

test("ignores a forwarded address unless the server trusts its proxy", async () => {
  await setUp();

  for (let attempt = 0; attempt < 10; attempt++) {
    await server.as()("/api/auth/session", {
      body: { ...pedro, password: "nope" },
      headers: from(`203.0.113.${String(attempt)}`),
    });
  }

  expect(
    (
      await server.as()("/api/auth/session", {
        body: pedro,
        headers: from("203.0.113.99"),
      })
    ).status,
  ).toBe(429);
});

test("locks a name after failed sign-ins sent all at once", async () => {
  await setUp();

  const guesses = await Promise.all(
    Array.from({ length: 30 }, async (_, attempt) =>
      server.as()("/api/auth/session", {
        body: attempt < 29 ? { ...pedro, password: "nope" } : pedro,
      }),
    ),
  );

  expect(guesses.filter(({ status }) => status === 401)).toHaveLength(10);
  expect(guesses.at(-1)?.status).toBe(429);
});

test("doesn't lock a user over failed sign-ins for other names", async () => {
  await setUp();

  for (let attempt = 0; attempt < 10; attempt++) {
    await server.as()("/api/auth/session", { body: { ...pedro, name: "ana" } });
  }

  expect((await server.as()("/api/auth/session", { body: pedro })).status).toBe(
    200,
  );
});

test("marks the cookie Secure behind an HTTPS gateway", async () => {
  await setUp();

  const signedIn = await server.as()("/api/auth/session", {
    body: pedro,
    headers: {
      "x-forwarded-proto": "https",
    },
  });

  expect(signedIn.headers.get("set-cookie")).toContain("; Secure");
});

test("names the cookie __Host- behind an HTTPS gateway, so a subdomain can't plant one", async () => {
  await setUp();
  const https = { "x-forwarded-proto": "https" };

  const signedIn = await server.as()("/api/auth/session", {
    body: pedro,
    headers: https,
  });

  const cookie = cookieOf(signedIn);
  const token = cookie.split("=")[1] ?? "";

  expect(signedIn.headers.get("set-cookie")).toMatch(
    /^__Host-pipoca-session=[\w-]+; Path=\/; Max-Age=\d+; Secure; HttpOnly; SameSite=Strict$/,
  );

  expect(
    (await server.as(cookie)("/api/sessions", { headers: https })).status,
  ).toBe(200);

  expect(
    (
      await server.as(`pipoca-session=${token}`)("/api/sessions", {
        headers: https,
      })
    ).status,
  ).toBe(401);
});

test("treats a request carrying two session cookies as signed out", async () => {
  const cookie = await setUp();

  expect((await server.as(cookie)("/api/sessions")).status).toBe(200);

  for (const both of [
    `pipoca-session=planted; ${cookie}`,
    `${cookie}; pipoca-session=planted`,
  ]) {
    expect((await server.as(both)("/api/sessions")).status).toBe(401);
  }
});

test("logs a new setup link after a restart while there are no users", async () => {
  await server.close();
  const database = join(root, "server.db");
  server = testServer({ database });
  const first = setupTokenOf(server.logs);

  await server.close();
  server = testServer({ database });

  expect(setupTokenOf(server.logs)).not.toBe(first);

  const stale = await server.as()("/api/auth/setup", {
    body: { ...pedro, token: first },
  });

  expect(stale.status).toBe(403);
});

test("keeps users and browser sessions across a restart, with no new setup link", async () => {
  await server.close();
  const database = join(root, "server.db");
  server = testServer({ database });
  const cookie = await setUp();

  await server.close();
  server = testServer({ database });

  expect(server.logs.some((line) => line.includes("#setup/"))).toBe(false);
  expect((await server.as(cookie)("/api/sessions")).status).toBe(200);
});

test("refuses passwords when only single sign-on is on, but keeps the setup link", async () => {
  await server.close();
  server = testServer({ passwordLogin: false });

  const created = await server.as()("/api/auth/setup", {
    body: {
      ...pedro,
      token: setupTokenOf(server.logs),
    },
  });

  const login = await server.as()("/api/auth/session", { body: pedro });

  expect([created.status, login.status]).toEqual([201, 403]);

  expect(await login.json()).toEqual({
    error: "password_login_off",
    message: "This server doesn't sign people in with a password.",
  });

  expect(await (await server.as()("/api/auth")).json()).toMatchObject({
    passwordLogin: false,
  });
});
