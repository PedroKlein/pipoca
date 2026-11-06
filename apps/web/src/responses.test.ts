import { expect, test } from "bun:test";
import { ok } from "./responses";

test("ok accepts an empty success and rejects with the server's message, its code as the cause", async () => {
  const empty = new Response(null, { status: 204 });

  expect(await ok(Promise.resolve(empty))).toBe(empty);

  const refused = Response.json(
    { error: "bad_request", message: "state must be one of working, done" },
    { status: 400 },
  );

  const error = await ok(Promise.resolve(refused)).catch(
    (reason: unknown) => reason,
  );

  expect(error).toMatchObject({
    message: "state must be one of working, done",
    cause: "bad_request",
  });
});

test("ok falls back to the error code, then to the status line", async () => {
  const coded = Response.json({ error: "unknown_state" }, { status: 400 });

  const bare = new Response("upstream connect error", {
    status: 503,
    statusText: "Service Unavailable",
  });

  expect([
    await ok(Promise.resolve(coded)).catch(String),
    await ok(Promise.resolve(bare)).catch(String),
  ]).toEqual(["Error: unknown_state", "Error: 503 Service Unavailable"]);
});
