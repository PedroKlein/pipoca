import { expect, test } from "bun:test";
import type { TypedClient } from "@pipoca/plugins";
import { renderPart } from "@pipoca/plugins/web/testing";
import { until } from "@pipoca/testing/until";
import { act } from "react";
import { web } from "./index";

// The page's change stream, which tells nothing here.
Object.assign(globalThis, {
  EventSource: class {
    addEventListener(): void {
      // Nothing changes.
    }

    close(): void {
      // Nothing to close.
    }
  },
});

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

test("the Slack app it creates may find people by their email, to tell them of artifact activity", async () => {
  const page = renderPart(
    web,
    "settings",
    {},
    {
      admin: true,
      fetch: async (url) =>
        Promise.resolve(
          Response.json(url.endsWith("/bots") ? [] : { bots: [] }),
        ),
    },
  );

  const link = (): HTMLAnchorElement | null =>
    [...page.querySelectorAll("a")].find(
      (each) => each.textContent === "Create the Slack app",
    ) ?? null;

  await act(async () => until(() => link() !== null));

  const manifest = JSON.parse(
    new URL(link()?.href ?? "").searchParams.get("manifest_json") ?? "{}",
  ) as { oauth_config: { scopes: { bot: string[] } } };

  expect(manifest.oauth_config.scopes.bot).toContain("users:read");
  expect(manifest.oauth_config.scopes.bot).toContain("users:read.email");
});
