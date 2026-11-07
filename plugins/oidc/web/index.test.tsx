import { expect, test } from "bun:test";
import { renderPart } from "@pipoca/plugins/web/testing";
import type { TypedClient } from "@pipoca/plugins";
import { until } from "@pipoca/testing/until";
import { act } from "react";
import type { Account } from "../src/model";
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

const account: Account = {
  admin: false,
  passwordLogin: true,
  lockedIn: null,
  providers: [
    { id: "ias", label: "Sign in with IAS", issuer: "https://ias.example.com" },
    { id: "google", label: "Google", issuer: "https://accounts.google.com" },
  ],
  identities: [
    {
      issuer: "https://ias.example.com",
      email: "ana@example.com",
      linkedAt: "2026-11-01T00:00:00.000Z",
      created: false,
    },
  ],
};

test("lists the person's sign-ins on Accounts, and unlinks one", async () => {
  const asked: string[] = [];

  const page = renderPart(
    web,
    "settings.accounts",
    {},
    {
      fetch: async (url, init) => {
        asked.push(`${init?.method ?? "GET"} ${url}`);

        return Promise.resolve(Response.json(account));
      },
    },
  );

  // Inside act, so React draws the answer even where an earlier test file
  // took its page down.
  await act(async () => until(() => asked.length > 0));

  const rows = [...page.querySelectorAll("li")].map((each) => each.textContent);

  const unlink = [...page.querySelectorAll("button")].find(
    (each) => each.textContent === "Unlink",
  );

  await act(async () => {
    unlink?.click();
    await until(() => asked.length > 1);
  });

  expect(rows).toEqual([
    expect.stringContaining("You sign in as ana@example.com") as string,
    expect.stringContaining("Not linked") as string,
  ]);

  expect(asked).toContain(
    `DELETE /api/ext/oidc/identities/${encodeURIComponent("https://ias.example.com")}`,
  );
});

test("adds a sign-in step to a team server's setup, done once a provider is added", async () => {
  const [step, ...others] = web.setup ?? [];
  const refuse = async (): Promise<never> => Promise.reject(new Error("no"));

  const done = async (providers: readonly unknown[]): Promise<boolean> =>
    (await step?.done({
      get: (async (path: string) =>
        path === "providers" ? providers : refuse()) as TypedClient["get"],
      post: refuse,
      put: refuse,
      patch: refuse,
      delete: refuse,
      raw: refuse,
    })) === true;

  expect(others).toEqual([]);

  expect(step).toMatchObject({
    audience: "server",
    after: "plugins",
    teamOnly: true,
    title: "Sign-in",
    optional: true,
  });

  expect(await done([])).toBe(false);
  expect(await done([{ id: "company", label: "Company SSO" }])).toBe(true);
});
