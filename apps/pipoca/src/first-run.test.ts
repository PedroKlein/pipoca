import { afterEach, beforeEach, expect, test } from "bun:test";
import { testServer, type TestServer } from "./testdata/harness";

let server: TestServer;

beforeEach(() => {
  server = testServer({
    runners: { pollWaitMs: 0 },
  });
});

afterEach(async () => {
  await server.close();
});

async function setup(body?: unknown): Promise<Response> {
  return server.api(
    "/api/me/setup",
    body === undefined ? {} : { method: "PATCH", body },
  );
}

test("a new person has the setup ahead of them until they finish it", async () => {
  expect(await (await setup()).json()).toEqual({
    finished: false,
    dismissed: [],
    serverPending: true,
  });

  expect((await setup({ finished: true })).status).toBe(200);

  expect(await (await setup()).json()).toEqual({
    finished: true,
    dismissed: [],
    serverPending: true,
  });
});

test("keeps the reminders a person dismissed, once each", async () => {
  await setup({ dismiss: "profile" });
  await setup({ dismiss: "git-hosts" });
  await setup({ dismiss: "profile" });

  expect(await (await setup()).json()).toEqual({
    finished: false,
    dismissed: ["profile", "git-hosts"],
    serverPending: true,
  });
});

test("refuses a change that isn't finishing or a step's name", async () => {
  expect((await setup({ finished: "yes" })).status).toBe(422);
  expect((await setup({ dismiss: "" })).status).toBe(422);
});

test("needs a signed-in user", async () => {
  expect((await fetch(new URL("/api/me/setup", server.url))).status).toBe(401);
});
