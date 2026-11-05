import { afterEach, expect, test } from "bun:test";
import { api } from "./api";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function respond(response: () => Response): void {
  globalThis.fetch = Object.assign(
    async () => Promise.resolve(response()),
    realFetch,
  );
}

test("api rejects with the status when an error response isn't JSON", async () => {
  respond(
    () =>
      new Response("upstream connect error", {
        status: 503,
        statusText: "Service Unavailable",
      }),
  );

  expect(await api("sessions.list").catch(String)).toBe(
    "Error: 503 Service Unavailable",
  );

  expect(
    await api("me.pinnedPages.update", { body: { pages: [] } }).catch(String),
  ).toBe("Error: 503 Service Unavailable");
});

test("api rejects with the server's error message and code", async () => {
  respond(() =>
    Response.json(
      { error: "signed_out", message: "Sign in again." },
      { status: 401 },
    ),
  );

  const error = await api("sessions.list").catch((caught: unknown) => caught);

  expect(String(error)).toBe("Error: Sign in again.");
  expect((error as Error).cause).toBe("signed_out");
});

test("api sends the route's method, path, query and JSON body", async () => {
  const sent: { url: string; init: RequestInit }[] = [];

  globalThis.fetch = Object.assign(async (url: string, init?: RequestInit) => {
    sent.push({ url, init: init ?? {} });

    return Promise.resolve(Response.json({ id: "s1" }));
  }, realFetch);

  await api("sessions.update", {
    params: { id: "a b" },
    body: { archived: true },
  });

  await api("sessions.list", { query: { scope: "team", archived: true } });

  expect(sent.map(({ url, init }) => [init.method, url, init.body])).toEqual([
    ["PATCH", "/api/sessions/a%20b", JSON.stringify({ archived: true })],
    ["GET", "/api/sessions?scope=team&archived=true", undefined],
  ]);
});
