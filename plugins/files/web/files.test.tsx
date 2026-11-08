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

test("a file added in the composer uploads at once, holds Send until it's saved, and says Pi gets it next", async () => {
  const sent: string[] = [];
  const uploading: boolean[] = [];

  const page = renderPart(
    web,
    "session.files",
    {
      session: sessionWith({}),
      files: [new File(["a,b"], "ledger.csv")],
      onRemove: () => undefined,
      onUploading: (now: boolean) => {
        uploading.push(now);
      },
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
  expect(uploading).toEqual([true, false]);
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
      onUploading: () => undefined,
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

test("the Files panel warns a person whose Sessions keep more than the per-person number", async () => {
  let asked = 0;

  const page = renderPart(
    web,
    "session.header",
    { session: sessionWith({}) },
    {
      fetch: async (url) => {
        await Promise.resolve();

        asked += 1;

        return url.endsWith("/limits")
          ? json({ maxFileBytes: 100, perPersonBytes: 1024, kept: 2048 })
          : json({ files: kept });
      },
    },
  );

  await act(async () => until(() => asked > 1));

  act(() => {
    page.querySelector<HTMLButtonElement>("button[aria-label^=Files]")?.click();
  });

  expect(document.body.textContent).toContain(
    "Your Sessions keep 2 KB of files, more than the 1 KB this server suggests for each person.",
  );
});

test("Settings shows what Session files take, and who keeps more than the per-person number", async () => {
  let asked = 0;

  const page = renderPart(
    web,
    "settings",
    {},
    {
      fetch: async (url) => {
        await Promise.resolve();

        asked += 1;

        return url.endsWith("/usage")
          ? json({
              used: 2048,
              free: 1024 * 1024 * 3,
              over: [{ name: "Ana", kept: 2048 }],
            })
          : json({});
      },
    },
  );

  await act(async () => until(() => asked > 1));

  expect(page.textContent).toContain(
    "Session files take 2 KB, with 3.0 MB free on the data volume.",
  );

  expect(page.textContent).toContain("Ana2 KB kept");
});

test("Settings shows sizes in MB or GB and saves them in bytes, with the snapshot settings as a group", async () => {
  const saved: unknown[] = [];
  let asked = 0;

  const page = renderPart(
    web,
    "settings",
    {},
    {
      fetch: async (url, init) => {
        await Promise.resolve();

        asked += 1;

        if (init?.method === "PUT" && typeof init.body === "string") {
          saved.push(JSON.parse(init.body));

          return json({});
        }

        return url.endsWith("/config")
          ? json({
              value: {
                maxFileBytes: 209_715_200,
                perPersonBytes: 10_737_418_240,
                snapshots: { enabled: true, maxBytes: 524_288_000 },
              },
            })
          : json({ used: 0, free: 0, over: [] });
      },
    },
  );

  await act(async () => until(() => asked > 1));

  const field = (label: string): HTMLInputElement | null =>
    [...page.querySelectorAll("label")]
      .find((each) => each.textContent.startsWith(label))
      ?.querySelector("input") ?? null;

  expect(field("Largest file")?.value).toBe("200");
  expect(field("Session files per person")?.value).toBe("10");

  expect(page.querySelector("fieldset legend")?.textContent).toBe(
    "Workspaces on Kubernetes",
  );

  expect(field("Largest snapshot")?.value).toBe("500");

  const input = field("Largest file");

  act(() => {
    if (input !== null) {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set?.call(input, "50");

      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });

  await act(async () => {
    page.querySelector<HTMLButtonElement>("button[type=submit]")?.click();
    await until(() => saved.length === 1);
  });

  expect(saved[0]).toMatchObject({
    value: {
      maxFileBytes: 52_428_800,
      snapshots: { enabled: true, maxBytes: 524_288_000 },
    },
  });
});
