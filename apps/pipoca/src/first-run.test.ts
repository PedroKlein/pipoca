import { afterEach, beforeEach, expect, test } from "bun:test";
import { serve } from "./serve";
import { firstUser } from "./testdata/sign-in";

let server: ReturnType<typeof serve>;
let signedIn: () => Promise<string>;

beforeEach(() => {
  const logs: string[] = [];

  server = serve({
    port: 0,
    database: ":memory:",
    sessions: { pollWaitMs: 0 },
    log: (message, fields) => {
      logs.push(`${message} ${JSON.stringify(fields)}`);
    },
  });

  signedIn = firstUser(server, logs);
});

afterEach(async () => {
  await server.stop();
});

async function setup(body?: unknown): Promise<Response> {
  return fetch(new URL("/api/setup", server.url), {
    method: body === undefined ? "GET" : "POST",
    headers: {
      cookie: await signedIn(),
      ...(body !== undefined && { "content-type": "application/json" }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}

test("a new person has the setup ahead of them until they finish it", async () => {
  expect(await (await setup()).json()).toEqual({
    finished: false,
    dismissed: [],
  });

  expect((await setup({ finished: true })).status).toBe(204);

  expect(await (await setup()).json()).toEqual({
    finished: true,
    dismissed: [],
  });
});

test("keeps the reminders a person dismissed, once each", async () => {
  await setup({ dismiss: "profile" });
  await setup({ dismiss: "git-hosts" });
  await setup({ dismiss: "profile" });

  expect(await (await setup()).json()).toEqual({
    finished: false,
    dismissed: ["profile", "git-hosts"],
  });
});

test("refuses a change that isn't finishing or a step's name", async () => {
  expect((await setup({ finished: "yes" })).status).toBe(400);
  expect((await setup({ dismiss: "" })).status).toBe(400);
});

test("needs a signed-in user", async () => {
  expect((await fetch(new URL("/api/setup", server.url))).status).toBe(401);
});
