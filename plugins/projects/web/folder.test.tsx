import { expect, test } from "bun:test";
import { drafts, renderPart } from "@pipoca/plugins/web/testing";
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
  const deleted: string[] = [];

  const page = renderPart(
    { ...web, slots },
    "folder",
    { project: { id: "p1", coordinatorId: "c1" } },
    {
      fetch: async (url, init) => {
        await Promise.resolve();

        asked.push(url);

        if (url.endsWith("/files")) {
          return Response.json({
            perProjectBytes: 1024 * 1024 * 1024 * 5,
            historyDays: 14,
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

        if (init?.method === "DELETE") {
          deleted.push(url);

          return Response.json({ ok: true });
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
      (row) =>
        (row.querySelector("td > span") ?? row.querySelector("td"))
          ?.textContent ?? "",
    );

  expect(rows()).toEqual([
    "reports/",
    "notes.md",
    "notes (from Fix rounding).mdconflict copy",
  ]);

  expect(page.textContent).toContain("Fix rounding");
  expect(page.textContent).toContain("3 files · 3 KB of 5.0 GB used");

  expect(page.textContent).toContain(
    "Earlier versions of a file stay downloadable for 14 days.",
  );

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

  // A name opens the file in the viewer over the page.
  act(() => {
    [...page.querySelectorAll<HTMLButtonElement>("tbody button")]
      .find((each) => each.textContent === "notes.md")
      ?.click();
  });

  expect(location.hash).toContain("?project=p1&path=notes.md");

  const more = (label: string): void => {
    act(() => {
      page
        .querySelector<HTMLButtonElement>('[aria-label="More for notes.md"]')
        ?.click();
    });

    act(() => {
      [...document.querySelectorAll<HTMLElement>("[role=menuitem]")]
        .find((each) => each.textContent.includes(label))
        ?.click();
    });
  };

  // Earlier versions narrows Recent writes to the file.
  more("Earlier versions");

  expect(page.textContent).toContain("Versions of notes.md");
  expect(page.textContent).toContain("Nothing written yet.");

  more("Open");
  expect(location.hash).toContain("?project=p1&path=notes.md");

  const clicked: string[] = [];

  // Download makes a link and clicks it, which the page would follow.
  Object.defineProperty(HTMLAnchorElement.prototype, "click", {
    configurable: true,
    value(this: HTMLAnchorElement) {
      clicked.push(`${this.download} ${this.href}`);
    },
  });

  more("Download");
  Reflect.deleteProperty(HTMLAnchorElement.prototype, "click");

  expect(clicked).toEqual([
    "notes.md /api/ext/projects/projects/p1/file?path=notes.md",
  ]);

  more("Attach to a new message");

  expect(drafts.at(-1)).toMatchObject({
    sessionId: "c1",
    text: "",
    attachments: [{ key: "project:notes.md", title: "notes.md" }],
  });

  // Delete asks first, and Cancel keeps the file.
  const answer = async (label: string): Promise<void> => {
    more("Delete");

    await act(async () =>
      until(() => document.body.textContent.includes("Delete notes.md?")),
    );

    expect(document.body.textContent).toContain(
      "Earlier versions stay in Recent writes for 14 days.",
    );

    await act(async () => {
      [...document.querySelectorAll<HTMLButtonElement>("dialog button")]
        .find((each) => each.textContent === label)
        ?.click();

      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  };

  await answer("Cancel");
  expect(deleted).toEqual([]);

  await answer("Delete");
  await act(async () => until(() => deleted.length === 1));

  expect(deleted).toEqual(["/api/ext/projects/projects/p1/file?path=notes.md"]);
});
