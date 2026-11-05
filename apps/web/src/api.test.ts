import { afterEach, expect, test } from "bun:test";
import { api, command } from "./api";

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

test("command sends a Session's commands one after another, in order", async () => {
  const bodies: unknown[] = [];
  let open = 0;
  let most = 0;

  globalThis.fetch = Object.assign(async (_url: string, init?: RequestInit) => {
    open += 1;
    most = Math.max(most, open);
    bodies.push(JSON.parse(init?.body as string));

    await new Promise((resolve) =>
      setTimeout(resolve, bodies.length === 1 ? 20 : 0),
    );

    open -= 1;

    return Response.json({});
  }, realFetch);

  await Promise.all([
    command("s1", { type: "set_thinking", level: "high" }),
    command("s1", { type: "set_thinking", level: "medium" }),
    command("s1", { type: "set_thinking", level: "high" }),
  ]);

  expect(most).toBe(1);

  expect(bodies).toEqual([
    { type: "set_thinking", level: "high" },
    { type: "set_thinking", level: "medium" },
    { type: "set_thinking", level: "high" },
  ]);
});

test("a failed command doesn't hold back the next one", async () => {
  let calls = 0;

  globalThis.fetch = Object.assign(async () => {
    calls += 1;
    await Promise.resolve();

    return calls === 1
      ? Response.json({ error: "invalid", message: "No." }, { status: 422 })
      : Response.json({});
  }, realFetch);

  const first = command("s1", { type: "set_thinking", level: "high" });
  const second = command("s1", { type: "set_thinking", level: "low" });

  expect(await first.catch(String)).toBe("Error: No.");
  await second;
  expect(calls).toBe(2);
});
