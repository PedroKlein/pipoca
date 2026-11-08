import { expect, test } from "bun:test";
import { renderPart } from "@pipoca/plugins/web/testing";
import { until } from "@pipoca/testing/until";
import { act } from "react";
import { Folder } from "./folder";
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

const file = (path: string, by: string, size = 1024) => ({
  path,
  hash: "a".repeat(64),
  size,
  actor: "user:ana",
  by,
  updatedAt: 0,
});

// The folder, as the slot the test renders.
const slots = { folder: Folder };

test("the Project folder opens subfolders, finds files, says who wrote each and compares a conflict copy", async () => {
  const asked: string[] = [];

  const page = renderPart(
    { ...web, slots },
    "folder",
    { path: "projects/p1" },
    {
      fetch: async (url) => {
        await Promise.resolve();

        asked.push(url);

        if (url.endsWith("/files")) {
          return Response.json({
            perProjectBytes: 1024 * 1024 * 1024 * 5,
            files: [
              file("notes.md", "Ana"),
              file("notes (from Fix rounding).md", "Fix rounding"),
              file("reports/mismatches.csv", "Reconcile Q3 invoices"),
            ],
          });
        }

        if (url.endsWith("/log")) {
          return Response.json({
            writes: [
              {
                id: "w1",
                path: "notes (from Fix rounding).md",
                hash: "a".repeat(64),
                size: 1024,
                actor: "session:s2",
                by: "Fix rounding",
                conflict: true,
                at: 0,
              },
            ],
          });
        }

        return new Response(
          url.includes("from%20Fix") ? "five retries" : "three retries",
        );
      },
    },
  );

  await act(async () => until(() => asked.length === 2));

  const rows = (): string[] =>
    [...page.querySelectorAll("table[aria-label=Folder] tbody tr")].map(
      (row) => row.querySelector("td")?.textContent ?? "",
    );

  expect(rows()).toEqual([
    "reports/",
    "notes.md",
    "notes (from Fix rounding).mdconflict copy",
  ]);

  expect(page.textContent).toContain("Fix rounding");
  expect(page.textContent).toContain("3 KB of 5.0 GB used");

  act(() => {
    [...page.querySelectorAll<HTMLButtonElement>("button")]
      .find((each) => each.textContent === "Compare")
      ?.click();
  });

  await act(async () => until(() => asked.length === 4));

  expect(
    [...page.querySelectorAll("[aria-label=Compare] pre")].map(
      (each) => each.textContent,
    ),
  ).toEqual(["three retries", "five retries"]);

  act(() => {
    [...page.querySelectorAll<HTMLButtonElement>("tbody button")]
      .find((each) => each.textContent === "reports/")
      ?.click();
  });

  expect(rows()).toEqual(["mismatches.csv"]);
  expect(page.textContent).toContain("Reconcile Q3 invoices");

  const search = page.querySelector<HTMLInputElement>("input[type=search]");

  act(() => {
    if (search !== null) {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set?.call(search, "notes");

      search.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });

  expect(rows()).toEqual([
    "notes.md",
    "notes (from Fix rounding).mdconflict copy",
  ]);
});
