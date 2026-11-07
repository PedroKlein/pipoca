import { expect, test } from "bun:test";
import "@pipoca/plugins/web/testing";
import type { TypedClient } from "@pipoca/plugins";
import { web } from "./index";

// A client of the plugin's routes that only reads path.
function answering(path: string, value: unknown): TypedClient {
  const refuse = async (): Promise<never> =>
    Promise.reject(new Error("read only"));

  return {
    get: (async (asked: string) =>
      asked === path ? Promise.resolve(value) : refuse()) as TypedClient["get"],
    post: refuse,
    put: refuse,
    patch: refuse,
    delete: refuse,
    raw: refuse,
  };
}

test("adds a bot step to a team server's setup after Where, and none to a person's", async () => {
  const [step, ...others] = web.setup ?? [];

  expect(others).toEqual([]);

  expect(step).toMatchObject({
    audience: "server",
    after: "where",
    teamOnly: true,
    optional: true,
  });

  expect(await step?.done(answering("bots", []))).toBe(false);

  expect(
    await step?.done(answering("bots", [{ name: "team-bot", team: "T1" }])),
  ).toBe(true);
});
