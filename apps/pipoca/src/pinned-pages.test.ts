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
  return server.api("/api/me/pinned-pages", {
    method: body === undefined ? "GET" : "PUT",
    body,
  });
}

test("keeps the plugin pages a user pins, with none chosen until they pin one", async () => {
  expect(await (await pinned()).json()).toEqual({ pages: null });

  expect((await pinned({ pages: ["projects", "library"] })).status).toBe(200);

  expect(await (await pinned()).json()).toEqual({
    pages: ["projects", "library"],
  });

  expect((await pinned({ pages: [] })).status).toBe(200);
  expect(await (await pinned()).json()).toEqual({ pages: [] });
});

test("refuses pinned pages that aren't a list of names", async () => {
  const refused = await pinned({ pages: "projects" });

  expect(refused.status).toBe(422);
  expect(await (await pinned()).json()).toEqual({ pages: null });
});

test("needs a signed-in user", async () => {
  const response = await fetch(new URL("/api/me/pinned-pages", server.url));

  expect(response.status).toBe(401);
});

test("keeps the models a person stars, last picked and hid, with only the last few picks", async () => {
  const choices = async (body?: unknown): Promise<unknown> =>
    (
      await server.api("/api/me/model-choices", {
        method: body === undefined ? "GET" : "PUT",
        body,
      })
    ).json();

  expect(await choices()).toEqual({ favorites: [], recent: [], hidden: [] });

  await choices({
    favorites: ["core/sonnet", "core/sonnet", "core/opus"],
    recent: ["a/1", "a/2", "a/3", "a/4", "a/5", "a/6"],
    hidden: ["core/old"],
  });

  expect(await choices()).toEqual({
    favorites: ["core/sonnet", "core/opus"],
    recent: ["a/1", "a/2", "a/3", "a/4", "a/5"],
    hidden: ["core/old"],
  });
});
