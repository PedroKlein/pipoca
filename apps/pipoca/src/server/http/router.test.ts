import { expect, test } from "bun:test";
import { Type } from "@pipoca/plugins";
import type { RouteSpec } from "@pipoca/protocol";
import { createRouter, type Route } from "./router";

const item = Type.Object({ name: Type.String({ minLength: 1 }) });

const routes: Route[] = [
  {
    spec: {
      method: "GET",
      path: "/api/items/:id",
      auth: "person",
    } satisfies RouteSpec,
    handler: ({ params }) => params,
  },
  {
    spec: {
      method: "PATCH",
      path: "/api/items/:id",
      auth: "person",
      body: item,
      changes: ["items"],
    } satisfies RouteSpec,
    handler: ({ body }) => body,
  },
  {
    spec: {
      method: "DELETE",
      path: "/api/items/:id",
      auth: "admin",
      status: 204,
    } satisfies RouteSpec,
    handler: () => undefined,
  },
];

function routerFor(admin: boolean): {
  readonly send: (method: string, init?: RequestInit) => Promise<Response>;
  readonly published: readonly string[];
} {
  const published: string[] = [];

  const router = createRouter(routes, {
    callers: {
      person: () => ({
        kind: "person",
        actor: "user:u1",
        id: "u1",
        admin,
        team: false,
      }),
      runner: () => undefined,
      hosts: () => false,
    },
    publish: (topic) => published.push(topic),
    refused: () => false,
    log: () => undefined,
  });

  return {
    send: async (method, init = {}) =>
      router.handle(
        new Request("http://pipoca/api/items/a%20b", { method, ...init }),
      ),
    published,
  };
}

const json = { "content-type": "application/json" };

test("matches a route by method and path, with its parameters decoded", async () => {
  const { send } = routerFor(false);

  expect(await (await send("GET")).json()).toEqual({ id: "a b" });
});

test("answers a method the path doesn't take with 405 and what it takes", async () => {
  const response = await routerFor(false).send("PUT");

  expect(response.status).toBe(405);
  expect(response.headers.get("allow")).toBe("GET, PATCH, DELETE");
  expect(await response.json()).toMatchObject({ error: "method_not_allowed" });
});

test("refuses a body that isn't JSON with 415", async () => {
  const response = await routerFor(false).send("PATCH", {
    headers: { "content-type": "text/plain" },
    body: '{"name":"x"}',
  });

  expect(response.status).toBe(415);

  expect(await response.json()).toMatchObject({
    error: "unsupported_media_type",
  });
});

test("refuses a body that doesn't fit with 422, naming the field", async () => {
  const response = await routerFor(false).send("PATCH", {
    headers: json,
    body: '{"name":""}',
  });

  expect(response.status).toBe(422);

  expect(await response.json()).toMatchObject({
    error: "invalid",
    field: "name",
  });
});

test("publishes a change topic once a change succeeds", async () => {
  const { send, published } = routerFor(false);

  await send("PATCH", { headers: json, body: '{"name":""}' });
  expect(published).toEqual([]);

  const changed = await send("PATCH", { headers: json, body: '{"name":"x"}' });

  expect(await changed.json()).toEqual({ name: "x" });
  expect(published).toEqual(["items"]);
});

test("lets only admins reach an admin route", async () => {
  const refused = await routerFor(false).send("DELETE");

  expect(refused.status).toBe(403);
  expect(await refused.json()).toMatchObject({ error: "admin_only" });
  expect((await routerFor(true).send("DELETE")).status).toBe(204);
});
