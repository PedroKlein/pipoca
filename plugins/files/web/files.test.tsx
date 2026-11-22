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

  expect(page.textContent).toContain("ledger.csv3 B · saved");

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

const files: readonly SessionFile[] = [
  ...kept,
  {
    place: "uploads",
    path: "ledger.xlsx",
    hash: "b".repeat(64),
    size: 225_280,
    savedAt: 0,
    by: "ana",
  },
];

const listing = async (url: string): Promise<Response> => {
  await Promise.resolve();

  if (url.endsWith("/limits")) {
    return json({ maxFileBytes: 1000, perPersonBytes: 1000, kept: 0 });
  }

  return url.endsWith("/snapshots")
    ? json({ snapshots: [] })
    : json({ files, steers: true });
};

// Lets the page render between reads, which act holds back inside it.
const settle = async (done: () => boolean): Promise<void> => {
  for (let tries = 0; !done(); tries += 1) {
    if (tries === 200) {
      throw new Error("the page never got there");
    }

    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  }
};

const filesButton = async (): Promise<HTMLButtonElement> => {
  await settle(
    () => document.querySelector("button[aria-label^=Files]") !== null,
  );

  const button = document.querySelector<HTMLButtonElement>(
    "button[aria-label^=Files]",
  );

  if (button === null) {
    throw new Error("no Files button");
  }

  return button;
};

const menu = (): HTMLElement | null =>
  document.querySelector<HTMLElement>("[role=complementary][aria-label=Files]");

const typeInto = (input: HTMLInputElement | null, value: string): void => {
  act(() => {
    if (input !== null) {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set?.call(input, value);

      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
};

test("the panel's Files section lists what Pi made and what people uploaded, and a row opens the file over the page", async () => {
  renderPart(
    web,
    "session.panel",
    { session: sessionWith({}) },
    { fetch: listing, hash: "#session-1" },
  );

  const button = await filesButton();

  expect(button.getAttribute("aria-label")).toBe("Files, 2");
  expect(button.textContent).toBe("2");
  expect(menu()).toBeNull();

  act(() => {
    button.click();
  });

  expect(
    [...(menu()?.querySelectorAll("section") ?? [])]
      .map((section) => section.textContent)
      .filter((text) => text !== ""),
  ).toEqual([
    "Made by Pi · outputs/mismatches.csv84 KB",
    "Uploaded · uploads/ledger.xlsx220 KB",
  ]);

  act(() => {
    [...(menu()?.querySelectorAll("button") ?? [])]
      .find((row) => row.textContent.startsWith("ledger.xlsx"))
      ?.click();
  });

  expect(location.hash).toBe(
    "#session-1?session=session-1&file=uploads%2Fledger.xlsx",
  );

  expect(menu()).not.toBeNull();
});

test("the Files filter narrows the rows to the names that hold it", async () => {
  renderPart(
    web,
    "session.panel",
    { session: sessionWith({}) },
    { fetch: listing },
  );

  const button = await filesButton();

  act(() => {
    button.click();
  });

  typeInto(
    menu()?.querySelector<HTMLInputElement>(
      "input[aria-label='Filter files']",
    ) ?? null,
    "LEDGER",
  );

  expect(
    [...(menu()?.querySelectorAll("section") ?? [])]
      .map((section) => section.textContent)
      .filter((text) => text !== ""),
  ).toEqual(["Uploaded · uploads/ledger.xlsx220 KB"]);
});

test("Upload in the Files menu gives the Session a file, which Pi is told about", async () => {
  const sent: string[] = [];

  renderPart(
    web,
    "session.panel",
    { session: sessionWith({}) },
    {
      fetch: async (url, init) => {
        const method = init?.method ?? "GET";

        if (method === "GET") {
          return listing(url);
        }

        await Promise.resolve();

        sent.push(`${method} ${url.split("_blobs/browser/")[0] ?? url}`);

        if (method === "PUT") {
          return json({ received: 3 });
        }

        return url.endsWith("/finish")
          ? json({ hash: "c".repeat(64), size: 3 })
          : json({ path: "notes.txt" });
      },
    },
  );

  const button = await filesButton();

  act(() => {
    button.click();
  });

  const input = menu()?.querySelector<HTMLInputElement>("input[type=file]");

  expect(input?.closest("label")?.textContent).toBe("Upload");

  act(() => {
    if (input !== null && input !== undefined) {
      Object.defineProperty(input, "files", {
        value: [new File(["abc"], "notes.txt")],
      });

      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });

  await act(async () => until(() => sent.length === 3));

  expect(sent.at(-1)).toBe("POST /api/ext/files/sessions/session-1/uploads");
});

test("an upload over the server's limit isn't sent, and the Files menu says the limit", async () => {
  renderPart(
    web,
    "session.panel",
    { session: sessionWith({}) },
    {
      fetch: async (url) =>
        url.endsWith("/limits")
          ? json({ maxFileBytes: 2, perPersonBytes: 1000, kept: 0 })
          : listing(url),
    },
  );

  const button = await filesButton();

  act(() => {
    button.click();
  });

  const input = menu()?.querySelector<HTMLInputElement>("input[type=file]");

  act(() => {
    if (input !== null && input !== undefined) {
      Object.defineProperty(input, "files", {
        value: [new File(["abc"], "notes.txt")],
      });

      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });

  await settle(
    () =>
      menu()?.textContent.includes(
        "notes.txt is 3 B. Files can be up to 2 B on this server.",
      ) === true,
  );
});

test("the Files menu says when Pi's outputs aren't saved yet", async () => {
  renderPart(
    web,
    "session.panel",
    {
      session: sessionWith({
        published: [
          {
            plugin: "files",
            key: "files",
            data: { unsaved: ["late.csv"] },
          },
        ],
      }),
    },
    { fetch: listing },
  );

  const button = await filesButton();

  act(() => {
    button.click();
  });

  expect(menu()?.textContent).toContain(
    "1 file not saved yet · retrying when the runner is back",
  );
});

test("the Files menu warns a person whose Sessions keep more than the per-person number", async () => {
  renderPart(
    web,
    "session.panel",
    { session: sessionWith({}) },
    {
      fetch: async (url) => {
        await Promise.resolve();

        return url.endsWith("/limits")
          ? json({ maxFileBytes: 100, perPersonBytes: 1024, kept: 2048 })
          : json({ files: kept, steers: true, snapshots: [] });
      },
    },
  );

  const button = await filesButton();

  act(() => {
    button.click();
  });

  await settle(
    () => menu()?.textContent.includes("Your Sessions keep") === true,
  );

  expect(menu()?.textContent).toContain(
    "Your Sessions keep 2 KB of files, more than the 1 KB this server suggests for each person.",
  );
});

test("a Session file opens in the viewer with its folder, size and maker, steps through the Session's files with the arrow keys, and shows its source", async () => {
  renderPart(
    web,
    "overlay",
    {},
    {
      fetch: listing,
      hash: "#session-1?session=session-1&file=outputs%2Fmismatches.csv",
    },
  );

  const heading = (): string | undefined =>
    document.querySelector("dialog h2")?.textContent;

  await settle(
    () =>
      document.querySelector("dialog")?.textContent.includes("Pi wrote it") ===
      true,
  );

  const dialog = document.querySelector("dialog");

  expect(dialog?.textContent).toContain("outputs/ · 84 KB · Pi wrote it");
  expect(dialog?.textContent).toContain("1 of 2 files in this Session");

  expect(dialog?.textContent).toContain(
    "Files have no comments or versions. Publish one as an artifact to share it and get comments.",
  );

  expect(document.querySelector("dialog iframe")?.getAttribute("src")).toBe(
    `/api/ext/files/sessions/session-1/files/outputs/view?path=mismatches.csv&v=${"a".repeat(64)}`,
  );

  expect(
    document.querySelector("dialog a[download]")?.getAttribute("href"),
  ).toBe("/api/ext/files/sessions/session-1/files/outputs?path=mismatches.csv");

  act(() => {
    [...document.querySelectorAll<HTMLButtonElement>("dialog button")]
      .find((each) => each.textContent === "Raw")
      ?.click();
  });

  expect(document.querySelector("dialog iframe")?.getAttribute("src")).toBe(
    `/api/ext/files/sessions/session-1/files/outputs/view?path=mismatches.csv&v=${"a".repeat(64)}&as=text`,
  );

  act(() => {
    dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
  });

  await settle(() => heading() === "ledger.xlsx");

  expect(location.hash).toBe(
    "#session-1?session=session-1&file=uploads%2Fledger.xlsx",
  );

  expect(dialog?.textContent).toContain("uploads/ · 220 KB · you added it");
  expect(dialog?.textContent).toContain("Pipoca can't preview .xlsx files.");
  expect(document.querySelector("dialog iframe")).toBeNull();

  act(() => {
    dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
  });

  expect(heading()).toBe("ledger.xlsx");

  act(() => {
    dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft" }));
  });

  await settle(() => heading() === "mismatches.csv");

  expect(document.querySelector("dialog iframe")?.getAttribute("src")).toBe(
    `/api/ext/files/sessions/session-1/files/outputs/view?path=mismatches.csv&v=${"a".repeat(64)}`,
  );
});

test("a file the Session no longer keeps says so in the viewer", async () => {
  renderPart(
    web,
    "overlay",
    {},
    {
      fetch: listing,
      hash: "#session-1?session=session-1&file=outputs%2Fgone.csv",
    },
  );

  await settle(
    () =>
      document
        .querySelector("dialog")
        ?.textContent.includes("This Session doesn't keep gone.csv.") === true,
  );
});

test("Escape closes the panel and gives focus back to the Files icon on its rail", async () => {
  renderPart(
    web,
    "session.panel",
    { session: sessionWith({}) },
    { fetch: listing },
  );

  const button = await filesButton();

  act(() => {
    button.click();
  });

  act(() => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });

  expect(menu()).toBeNull();
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Files, 2");
});

test("the Files button stays hidden while a Session has no files", async () => {
  let asked = 0;

  renderPart(
    web,
    "session.panel",
    { session: sessionWith({}) },
    {
      fetch: async (url) => {
        asked += 1;

        return url.endsWith("/files")
          ? json({ files: [], steers: true })
          : listing(url);
      },
    },
  );

  await settle(() => asked >= 3);
  await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));

  expect(document.querySelector("button[aria-label^=Files]")).toBeNull();
});

test("an output Pi changed since it was saved says not saved in its row, without the unsaved note", async () => {
  renderPart(
    web,
    "session.panel",
    {
      session: sessionWith({
        published: [
          {
            plugin: "files",
            key: "files",
            data: { unsaved: ["mismatches.csv"] },
          },
        ],
      }),
    },
    { fetch: listing },
  );

  const button = await filesButton();

  act(() => {
    button.click();
  });

  expect(menu()?.querySelector("section")?.textContent).toBe(
    "Made by Pi · outputs/mismatches.csvnot saved",
  );

  expect(menu()?.textContent).not.toContain("not saved yet");
});

const viewing = async (
  hash: string,
  shown: readonly SessionFile[] = files,
): Promise<void> => {
  renderPart(
    web,
    "overlay",
    {},
    {
      fetch: async (url) =>
        url.endsWith("/files")
          ? json({ files: shown, steers: true })
          : listing(url),
      hash,
    },
  );

  await settle(
    () =>
      document.querySelector("dialog")?.textContent.includes(" · ") === true,
  );
};

const heading = (): string | undefined =>
  document.querySelector("dialog h2")?.textContent;

test("arrow keys don't step through files while typing or with a modifier held", async () => {
  await viewing("#session-1?session=session-1&file=outputs%2Fmismatches.csv");

  for (const held of ["ctrlKey", "altKey", "metaKey"]) {
    act(() => {
      dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", [held]: true }),
      );
    });
  }

  const input = document.createElement("input");
  document.querySelector("dialog")?.append(input);

  act(() => {
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
  });

  expect(heading()).toBe("mismatches.csv");

  expect(location.hash).toBe(
    "#session-1?session=session-1&file=outputs%2Fmismatches.csv",
  );
});

test("the Previous and Next buttons step through the files and stop at the ends", async () => {
  await viewing("#session-1?session=session-1&file=outputs%2Fmismatches.csv");

  const step = (label: string): HTMLButtonElement | null =>
    document.querySelector<HTMLButtonElement>(
      `dialog button[aria-label='${label}']`,
    );

  expect(step("Previous file")?.disabled).toBe(true);

  act(() => {
    step("Next file")?.click();
  });

  await settle(() => heading() === "ledger.xlsx");

  expect(step("Next file")?.disabled).toBe(true);

  act(() => {
    step("Previous file")?.click();
  });

  await settle(() => heading() === "mismatches.csv");
});

test("a file over 5 MB offers a download instead of a preview", async () => {
  await viewing("#session-1?session=session-1&file=outputs%2Fbig.csv", [
    {
      place: "outputs",
      path: "big.csv",
      hash: "d".repeat(64),
      size: 6_000_000,
      savedAt: 0,
      by: null,
    },
  ]);

  const dialog = document.querySelector("dialog");

  expect(dialog?.textContent).toContain("This file is too big to show here.");
  expect(dialog?.querySelector("iframe")).toBeNull();
  expect(dialog?.textContent).not.toContain("Raw");

  expect(
    [...(dialog?.querySelectorAll("a[download]") ?? [])].map((link) => [
      link.getAttribute("href"),
      link.getAttribute("download"),
    ]),
  ).toEqual([
    ["/api/ext/files/sessions/session-1/files/outputs?path=big.csv", "big.csv"],
    ["/api/ext/files/sessions/session-1/files/outputs?path=big.csv", "big.csv"],
  ]);
});

test("a Session file's viewer offers plugins' actions, such as Publish, only to people who steer the Session", async () => {
  let steers = false;

  const fills = {
    "file.actions": ({ session }: { readonly session: string }) => (
      <span data-action={session} />
    ),
  };

  renderPart(
    web,
    "overlay",
    {},
    {
      fills,
      fetch: async (url) =>
        url.endsWith("/files") ? json({ files, steers }) : listing(url),
      hash: "#session-1?session=session-1&file=outputs%2Fmismatches.csv",
    },
  );

  await settle(() => document.querySelector("dialog iframe") !== null);

  expect(document.querySelector("[data-action]")).toBeNull();

  steers = true;

  act(() => {
    history.replaceState(
      null,
      "",
      "#session-2?session=session-2&file=outputs%2Fmismatches.csv",
    );

    dispatchEvent(new HashChangeEvent("hashchange"));
  });

  await settle(() => document.querySelector("[data-action]") !== null);

  expect(
    document.querySelector("[data-action]")?.getAttribute("data-action"),
  ).toBe("session-2");
});

test("someone who only sees the Session gets no Upload in the Files menu", async () => {
  renderPart(
    web,
    "session.panel",
    { session: sessionWith({}) },
    {
      fetch: async (url) =>
        url.endsWith("/files") ? json({ files, steers: false }) : listing(url),
    },
  );

  const button = await filesButton();

  act(() => {
    button.click();
  });

  expect(menu()?.querySelector("input[type=file]")).toBeNull();
});

test("the Files button shows while Pi's only outputs aren't saved yet", async () => {
  renderPart(
    web,
    "session.panel",
    {
      session: sessionWith({
        published: [
          { plugin: "files", key: "files", data: { unsaved: ["late.csv"] } },
        ],
      }),
    },
    {
      fetch: async (url) =>
        url.endsWith("/files")
          ? json({ files: [], steers: true })
          : listing(url),
    },
  );

  expect((await filesButton()).getAttribute("aria-label")).toBe("Files, 1");
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

test("what Pi's turn saved shows as cards under its reply, and a card opens the file over the chat", () => {
  const page = renderPart(
    web,
    "notice:saved",
    {
      text: "Saved for the person after your turn: outputs/joined.csv (6 KB).",
      data: { files: [{ path: "joined.csv", size: 6144 }] },
      session: sessionWith({}),
    },
    { hash: "#session-1" },
  );

  const card = page.querySelector<HTMLButtonElement>(
    "[aria-label='Files Pi saved'] button",
  );

  expect(card?.textContent).toBe("joined.csvoutputs · 6 KB");

  act(() => {
    card?.click();
  });

  expect(location.hash).toBe(
    "#session-1?session=session-1&file=outputs%2Fjoined.csv",
  );
});
