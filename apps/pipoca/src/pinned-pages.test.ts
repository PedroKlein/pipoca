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

async function pinned(body?: unknown): Promise<Response> {
  return server.api("/api/pinned-pages", {
    method: body === undefined ? "GET" : "PUT",
    body,
  });
}

test("keeps the plugin pages a user pins, with none chosen until they pin one", async () => {
  expect(await (await pinned()).json()).toEqual({ pages: null });

  expect((await pinned({ pages: ["projects", "library"] })).status).toBe(204);

  expect(await (await pinned()).json()).toEqual({
    pages: ["projects", "library"],
  });

  expect((await pinned({ pages: [] })).status).toBe(204);
  expect(await (await pinned()).json()).toEqual({ pages: [] });
});

test("refuses pinned pages that aren't a list of names", async () => {
  const refused = await pinned({ pages: "projects" });

  expect(refused.status).toBe(422);
  expect(await (await pinned()).json()).toEqual({ pages: null });
});

test("needs a signed-in user", async () => {
  const response = await fetch(new URL("/api/pinned-pages", server.url));

  expect(response.status).toBe(401);
});
