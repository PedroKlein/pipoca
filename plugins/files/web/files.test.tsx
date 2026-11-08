import { expect, test } from "bun:test";
import { renderPart, sessionWith } from "@pipoca/plugins/web/testing";
import { until } from "@pipoca/testing/until";
import { act } from "react";
import type { SessionFile } from "../src/files";
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

const json = (body: unknown): Response => Response.json(body);

const kept: readonly SessionFile[] = [
  {
    place: "outputs",
    path: "mismatches.csv",
    hash: "a".repeat(64),
    size: 86_016,
    savedAt: 0,
    by: null,
  },
];

test("a file added in the composer uploads at once and says Pi gets it next", async () => {
  const sent: string[] = [];

  const page = renderPart(
    web,
    "session.files",
    {
      session: sessionWith({}),
      files: [new File(["a,b"], "ledger.csv")],
      onRemove: () => undefined,
    },
    {
      fetch: async (url, init) => {
        await Promise.resolve();

        sent.push(
          `${init?.method ?? "GET"} ${url.split("_blobs/browser/")[0] ?? url}`,
        );

        if (url.endsWith("/limits")) {
          return json({ maxFileBytes: 100 });
        }

        if (init?.method === "PUT") {
          return json({ received: 3 });
        }

        return url.endsWith("/finish")
          ? json({ hash: "b".repeat(64), size: 3 })
          : json({ path: "ledger.csv" });
      },
    },
  );

  await act(async () => until(() => sent.length === 4));

  expect(page.textContent).toContain(
    "ledger.csv3 B · saved, Pi gets it with your next message",
  );

  expect(sent.at(-1)).toBe("POST /api/ext/files/sessions/session-1/uploads");
});

test("a file over the server's limit isn't sent, and says the limit", async () => {
  const asked: string[] = [];

  const page = renderPart(
    web,
    "session.files",
    {
      session: sessionWith({}),
      files: [new File(["x".repeat(2048)], "dump.sql")],
      onRemove: () => undefined,
    },
    {
      fetch: async (url, init) => {
        await Promise.resolve();

        asked.push(`${init?.method ?? "GET"} ${url}`);

        return json({ maxFileBytes: 1024 });
      },
    },
  );

  await act(async () => until(() => asked.length > 0));

  expect(page.textContent).toContain(
    "dump.sql is 2 KB. Files can be up to 1 KB on this server.",
  );

  expect(asked).toEqual(["GET /api/ext/files/limits"]);
});

test("the header's Files panel lists outputs with downloads", async () => {
  let asked = 0;

  const page = renderPart(
    web,
    "session.header",
    { session: sessionWith({}) },
    {
      fetch: async () => {
        await Promise.resolve();

        asked += 1;

        return json({ files: kept });
      },
    },
  );

  await act(async () => until(() => asked > 0));

  act(() => {
    page.querySelector<HTMLButtonElement>("button[aria-label^=Files]")?.click();
  });

  const link = document.querySelector<HTMLAnchorElement>("a[download]");

  expect(link?.getAttribute("href")).toBe(
    "/api/ext/files/sessions/session-1/files/outputs?path=mismatches.csv",
  );
});
