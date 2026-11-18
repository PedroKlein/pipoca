import { expect, test } from "bun:test";
import { renderPart, sessionWith } from "@pipoca/plugins/web/testing";
import { until } from "@pipoca/testing/until";
import { act } from "react";
import type { ArtifactSummary } from "../src/artifacts";
import { web } from "./index";

// The page's change stream, which tells only what a test says changed.
const heard: ((event: { readonly data: string }) => void)[] = [];

Object.assign(globalThis, {
  EventSource: class {
    readonly readyState = 1;

    addEventListener(
      type: string,
      listener: (event: { readonly data: string }) => void,
    ): void {
      if (type === "message") {
        heard.push(listener);
      }
    }

    close(): void {
      // Nothing to close.
    }
  },
});

function changed(topic: string): void {
  for (const listener of heard) {
    listener({ data: JSON.stringify({ topic }) });
  }
}

test("a published artifact shows in the chat as a card of how it is now, which opens it over the chat", async () => {
  const asked: string[] = [];

  const page = renderPart(
    web,
    "session.toolCall:publish_artifact",
    {
      session: sessionWith({}),
      call: {
        id: "call-1",
        name: "publish_artifact",
        args: { path: "report.md" },
        status: "done",
        result: {
          text: "Published",
          details: { id: "a1", title: "Sales report", version: 2 },
          failed: false,
        },
      },
    },
    {
      hash: "#session-1",
      fetch: async (url) => {
        await Promise.resolve();

        asked.push(url);

        return Response.json(
          artifact({ title: "Sales report", kind: "markdown", versions: 3 }),
        );
      },
    },
  );

  await act(async () => until(() => asked.length === 1));

  const card = page.querySelector("a");

  expect(card?.textContent).toContain("Sales report");
  expect(card?.textContent).toContain("Markdown · version 3 · Only you");
  expect(card?.getAttribute("href")).toBe("#plugin/artifacts/a1");

  await act(async () => {
    card?.click();
    await until(() => location.hash.includes("?"));
  });

  expect(location.hash).toBe("#session-1?artifact=a1");
});

test("a publish that failed says why, with nothing to open", () => {
  const page = renderPart(web, "session.toolCall:publish_artifact", {
    session: sessionWith({}),
    call: {
      id: "call-2",
      name: "publish_artifact",
      args: { path: "notes.docx", title: "Notes" },
      status: "failed",
      result: {
        text: "notes.docx can't be an artifact",
        details: {},
        failed: true,
      },
    },
  });

  expect(page.textContent).toContain("Notes");
  expect(page.textContent).toContain("notes.docx can't be an artifact");
  expect(page.querySelector("a")).toBeNull();
});

test("the card of an artifact deleted since says so, with nothing to open", async () => {
  const asked: string[] = [];

  const page = renderPart(
    web,
    "session.toolCall:publish_artifact",
    {
      session: sessionWith({}),
      call: {
        id: "call-3",
        name: "publish_artifact",
        args: { path: "report.md" },
        status: "done",
        result: {
          text: "Published",
          details: { id: "gone", title: "Old report", version: 1 },
          failed: false,
        },
      },
    },
    {
      fetch: async (url) => {
        await Promise.resolve();

        asked.push(url);

        return Response.json({ error: "not_found" }, { status: 404 });
      },
    },
  );

  await act(async () => until(() => asked.length === 1));
  await drawn(() => page.textContent.includes("Deleted"));

  expect(page.textContent).toContain("Old report");
  expect(page.querySelector("a")).toBeNull();
});

test("threads sent to Pi show in the chat as one row that opens them, with their text on demand", async () => {
  const asked: string[] = [];

  const page = renderPart(
    web,
    "notice:artifact_comments",
    {
      text: "Comment threads on your artifact were sent to you",
      data: { batch: "b1" },
    },
    {
      hash: "#session-1",
      fetch: async (url) => {
        await Promise.resolve();

        asked.push(url);

        return Response.json({
          senders: ["You"],
          threads: [
            {
              artifact: "a1",
              title: "Checkout latency",
              comment: {
                id: "c1",
                author: "Ana",
                quote: "three times",
                body: "Attempts or retries?",
              },
            },
            {
              artifact: "a1",
              title: "Checkout latency",
              comment: {
                id: "c2",
                version: 1,
                author: "Pedro",
                quote: "",
                body: "Add the error rate",
              },
            },
          ],
        });
      },
    },
  );

  await act(async () => until(() => asked.length === 1));

  const row = page.querySelector("summary");

  expect(row?.textContent).toContain(
    "You sent 2 comment threads on Checkout latency",
  );

  expect(row?.textContent).not.toContain("Attempts or retries?");
  expect(page.querySelector("details")?.open).toBe(false);

  act(() => {
    row?.click();
  });

  expect(page.querySelector("details")?.open).toBe(true);

  expect(page.querySelector("a")?.getAttribute("href")).toBe(
    "#plugin/artifacts/a1/comments",
  );

  expect(
    [...page.querySelectorAll("[aria-label='Sent comments'] li")].map(
      (each) => each.textContent,
    ),
  ).toEqual([
    "Ana on “three times”Attempts or retries?",
    "Pedro on version 1Add the error rate",
  ]);

  await act(async () => {
    page.querySelector("a")?.click();
    await until(() => location.hash.includes("?"));
  });

  expect(location.hash).toBe("#session-1?artifact=a1&comments=1");
});

interface Served {
  readonly url: string;
  readonly method: string;
  readonly body?: unknown;
}

// The plugin's routes as a fake server, with the artifact these tests open.
function serving(
  shown: object,
  asked: Served[],
): (url: string, init?: RequestInit) => Promise<Response> {
  return async (url, init) => {
    await Promise.resolve();

    asked.push({
      url,
      method: init?.method ?? "GET",
      ...(typeof init?.body === "string" && {
        body: JSON.parse(init.body) as unknown,
      }),
    });

    if (url.endsWith("/comments")) {
      return Response.json({ comments: [] });
    }

    const version = /\/(view|download)\?v=(\d+)$/.exec(url);

    if (version !== null) {
      return new Response(
        version[1] === "view"
          ? `<p>same version ${String(version[2])}</p>`
          : `same\nversion ${String(version[2])}\n`,
      );
    }

    return Response.json(
      init?.method === undefined || init.method === "GET" ? shown : {},
    );
  };
}

// Waits for what the page draws: React draws only once each act ends.
async function drawn(done: () => boolean): Promise<void> {
  for (let tries = 0; !done(); tries += 1) {
    if (tries > 200) {
      throw new Error("never drawn");
    }

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

function buttons(page: HTMLElement): HTMLButtonElement[] {
  return [...page.querySelectorAll<HTMLButtonElement>("button")];
}

function named(page: HTMLElement, name: string): HTMLButtonElement | undefined {
  return buttons(page).find(
    (each) =>
      each.getAttribute("aria-label") === name || each.textContent === name,
  );
}

function versionMenu(page: HTMLElement): HTMLButtonElement | undefined {
  return buttons(page).find(
    (each) => each.getAttribute("aria-label")?.endsWith("Versions") === true,
  );
}

// Types as a person does, so React hears it.
function typeInto(field: HTMLTextAreaElement | null, text: string): void {
  act(() => {
    if (field === null) {
      return;
    }

    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set?.call(field, text);

    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function menuItems(page: HTMLElement): HTMLButtonElement[] {
  return [
    ...page.querySelectorAll<HTMLButtonElement>("[role=menu] [role^=menuitem]"),
  ];
}

function item(page: HTMLElement, label: string): HTMLButtonElement | undefined {
  return menuItems(page).find((each) => each.textContent.startsWith(label));
}

async function opened(asked: readonly Served[]): Promise<void> {
  // The artifact loads, and then what its comments quote.
  await act(async () => until(() => asked.length >= 1));
  await act(async () => until(() => asked.length >= 2));
}

test("an artifact opens over the page with what can be done with it, and closes back to the page", async () => {
  const asked: Served[] = [];

  const page = renderPart(
    web,
    "overlay",
    {},
    {
      hash: "#session-1?artifact=a1",
      fetch: serving(
        {
          ...artifact({ title: "Checkout latency", versions: 3 }),
          ...viewed(3),
          openComments: 2,
        },
        asked,
      ),
    },
  );

  await opened(asked);

  const dialog = page.querySelector("dialog");

  expect(dialog?.querySelector("h2")?.textContent).toBe("Checkout latency");

  expect(dialog?.textContent).toContain(
    "From “Why did checkout slow down?” · Only you",
  );

  expect(page.querySelector("iframe")?.getAttribute("title")).toBe(
    "Checkout latency, version 3",
  );

  const versions = named(page, "Version 3, the latest. Versions");

  expect(versions?.textContent).toBe("Version 3 · latest");

  expect(
    buttons(page).find((each) => each.textContent.startsWith("Comment"))
      ?.textContent,
  ).toBe("Comment2 open");

  expect(named(page, "Share")).toBeDefined();

  expect(
    page
      .querySelector("a[aria-label='Open in a new tab']")
      ?.getAttribute("href"),
  ).toBe("#plugin/artifacts/a1");

  act(() => {
    named(page, "More")?.click();
  });

  expect(menuItems(page).map((each) => each.textContent)).toEqual([
    "Download",
    "Copy link",
    "Copy link to version 3",
    "Pin to sidebar",
    "Go to the Session",
    "Delete artifact…",
  ]);

  act(() => {
    named(page, "More")?.click();
    versions?.click();
  });

  expect(item(page, "Version 3")?.getAttribute("aria-checked")).toBe("true");
  expect(item(page, "Version 3")?.textContent).toContain("latest");
  expect(item(page, "Version 1")?.getAttribute("aria-checked")).toBe("false");
  expect(item(page, "Version 1")?.textContent).toContain("first draft");
  expect(item(page, "Compare versions…")).toBeDefined();

  const steps = history.length;

  await act(async () => {
    item(page, "Version 1")?.click();
    await until(() => location.hash.includes("v=1"));
  });

  expect(location.hash).toBe("#session-1?artifact=a1&v=1");
  expect(history.length).toBe(steps);

  expect(dialog?.textContent).toContain(
    "You're viewing version 1. The latest is version 3.",
  );

  await act(async () => {
    named(page, "Go to latest")?.click();
    await until(() => !location.hash.includes("v="));
  });

  expect(location.hash).toBe("#session-1?artifact=a1");

  await act(async () => {
    named(page, "Close")?.click();
    await until(() => !location.hash.includes("?"));
  });

  expect(location.hash).toBe("#session-1");
  expect(page.querySelector("dialog")).toBeNull();
});

test("a version the address can't name shows the latest, and the version menu lists every version with who made it", async () => {
  const asked: Served[] = [];

  const page = renderPart(
    web,
    "overlay",
    {},
    {
      hash: "#session-1?artifact=a1&v=abc",
      fetch: serving({ ...artifact({ versions: 3 }), ...viewed(3) }, asked),
    },
  );

  await opened(asked);

  expect(versionMenu(page)?.textContent).toBe("Version 3 · latest");

  act(() => {
    history.replaceState(null, "", "#session-1?artifact=a1&v=99");
    dispatchEvent(new HashChangeEvent("hashchange"));
  });

  expect(versionMenu(page)?.textContent).toBe("Version 3 · latest");

  act(() => {
    versionMenu(page)?.click();
  });

  const menu = page.querySelector("[role=menu]");

  expect(menu?.textContent).toStartWith("Versions · every publish is kept");

  expect(menuItems(page).map((each) => each.textContent)).toEqual([
    "Version 3 latestPi · just now",
    "Version 2Pi · just now",
    "Version 1Pi · just now · “first draft”",
    "Compare versions…",
  ]);
});

test("compare opens inside the viewer with both versions side by side or as a source diff, and Back leaves it", async () => {
  const asked: Served[] = [];

  const page = renderPart(
    web,
    "overlay",
    {},
    {
      hash: "#session-1?artifact=a1",
      fetch: serving({ ...artifact({ versions: 3 }), ...viewed(3) }, asked),
    },
  );

  await opened(asked);

  act(() => {
    versionMenu(page)?.click();
  });

  act(() => {
    item(page, "Compare versions…")?.click();
  });

  expect(page.querySelector("h2")?.textContent).toBe("Report");
  expect(page.textContent).toContain("Comparing two versions");
  expect(named(page, "Back to version 3")).toBeDefined();

  expect(
    [...page.querySelectorAll("section")].map((each) => [
      each.getAttribute("aria-label"),
      each.querySelector("p")?.textContent,
      each.querySelector("iframe")?.getAttribute("src"),
    ]),
  ).toEqual([
    [
      "Version 2",
      "Version 2 · Pi · just now",
      "/api/ext/artifacts/artifacts/a1/view?v=2",
    ],
    [
      "Version 3",
      "Version 3 · Pi · just now",
      "/api/ext/artifacts/artifacts/a1/view?v=3",
    ],
  ]);

  await drawn(() => asked.some(({ url }) => url.endsWith("/view?v=3")));

  act(() => {
    named(page, "Older version")?.click();
  });

  act(() => {
    item(page, "Version 1")?.click();
  });

  expect(page.querySelector("section")?.getAttribute("aria-label")).toBe(
    "Version 1",
  );

  act(() => {
    named(page, "Source diff")?.click();
  });

  await drawn(
    () => page.querySelector("[aria-label=Changes]")?.textContent !== "",
  );

  expect(
    [...page.querySelectorAll("[aria-label=Changes] div")].map(
      (each) => each.textContent,
    ),
  ).toEqual(["  same", "- version 1", "+ version 3", "  "]);

  act(() => {
    named(page, "Back to version 3")?.click();
  });

  expect(page.textContent).not.toContain("Comparing two versions");

  act(() => {
    versionMenu(page)?.click();
  });

  act(() => {
    item(page, "Compare versions…")?.click();
  });

  // Back in the browser leaves compare with the address it opened on.
  act(() => {
    history.replaceState(null, "", "#session-1?artifact=a1&v=1");
    dispatchEvent(new HashChangeEvent("hashchange"));
  });

  expect(page.textContent).not.toContain("Comparing two versions");
  expect(versionMenu(page)?.textContent).toBe("Version 1 of 3");
});

test("a Markdown artifact is edited beside its preview, saved as a version on the one it started from, and a version saved meanwhile asks first", async () => {
  const asked: Served[] = [];
  let shown = { ...artifact({ kind: "markdown", versions: 2 }), ...viewed(2) };
  let stale = false;

  const page = renderPart(
    web,
    "overlay",
    {},
    {
      hash: "#session-1?artifact=a1",
      fetch: async (url, init) => {
        if (
          url.endsWith("/versions") &&
          stale &&
          typeof init?.body === "string"
        ) {
          const body = JSON.parse(init.body) as { base?: number };

          if (body.base !== undefined) {
            asked.push({ url, method: "POST", body });

            return Response.json(
              {
                error: "stale",
                message: "Pi saved version 3 while you were editing.",
              },
              { status: 409 },
            );
          }
        }

        return serving(shown, asked)(url, init);
      },
    },
  );

  await opened(asked);

  act(() => {
    named(page, "More")?.click();
  });

  act(() => {
    item(page, "Edit")?.click();
  });

  const source = (): HTMLTextAreaElement | null =>
    page.querySelector("textarea[aria-label=Markdown]");

  await drawn(() => source()?.value === "same\nversion 2\n");

  expect(page.textContent).toContain("Markdown · Only you · editing version 2");
  expect(page.querySelector("iframe")?.getAttribute("title")).toBe("Preview");
  expect(page.querySelector("iframe")?.getAttribute("sandbox")).toBe("");

  const save = (): HTMLButtonElement | undefined =>
    named(page, "Save as version 3");

  expect(save()?.disabled).toBe(true);

  typeInto(source(), "same\nmine\n");

  expect(page.querySelector("iframe")?.getAttribute("srcdoc")).toContain(
    "<p>same\nmine</p>",
  );

  // Escape leaves the editor first, and asks before dropping changes.
  act(() => {
    source()?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });

  await drawn(() => named(page, "Discard") !== undefined);

  act(() => {
    buttons(page)
      .filter((each) => each.textContent === "Cancel")
      .at(-1)
      ?.click();
  });

  await drawn(() => named(page, "Discard") === undefined);

  expect(source()?.value).toBe("same\nmine\n");

  stale = true;

  await act(async () => {
    save()?.click();
    await until(() => asked.some(({ method }) => method === "POST"));
  });

  await drawn(() => page.querySelector("[role=alert]") !== null);

  expect(asked.find(({ method }) => method === "POST")?.body).toEqual({
    text: "same\nmine\n",
    base: 2,
  });

  shown = { ...artifact({ kind: "markdown", versions: 3 }), ...viewed(3) };

  act(() => {
    changed("artifacts.artifacts");
  });

  await drawn(
    () =>
      page
        .querySelector("[role=alert]")
        ?.textContent.includes("Pi saved version 3 while you were editing.") ===
      true,
  );

  expect(source()?.value).toBe("same\nmine\n");
  expect(named(page, "Open version 3")).toBeDefined();

  await act(async () => {
    named(page, "Save anyway as version 4")?.click();

    await until(
      () => asked.filter(({ method }) => method === "POST").length === 2,
    );
  });

  expect(asked.filter(({ method }) => method === "POST").at(-1)?.body).toEqual({
    text: "same\nmine\n",
  });

  await drawn(() => source() === null);

  expect(location.hash).toBe("#session-1?artifact=a1");
});

test("a version a person saved shows in the chat as a row that opens it", async () => {
  const asked: Served[] = [];

  const page = renderPart(
    web,
    "notice:artifact_version",
    { text: "Ana saved version 2", data: { artifact: "a1", version: 2 } },
    {
      hash: "#session-1",
      fetch: serving(
        {
          ...artifact({ title: "Rollout plan", kind: "markdown", versions: 2 }),
          ...viewed(2),
          history: [
            viewed(1).history[0],
            { ...viewed(2).history[1], author: "user:ana", by: "Ana" },
          ],
        },
        asked,
      ),
    },
  );

  await drawn(() => page.textContent.includes("Rollout plan"));

  expect(page.textContent).toContain("Ana saved version 2 of Rollout plan");

  const open = page.querySelector("a");

  expect(open?.getAttribute("href")).toBe("#plugin/artifacts/a1/v/2");

  await act(async () => {
    open?.click();
    await until(() => location.hash.includes("?"));
  });

  expect(location.hash).toBe("#session-1?artifact=a1&v=2");
});

test("a refresh that fails keeps the artifact shown", async () => {
  const asked: Served[] = [];
  let failing = false;

  const serve = serving(
    { ...artifact({ title: "Kept" }), ...viewed(1) },
    asked,
  );

  const page = renderPart(
    web,
    "overlay",
    {},
    {
      hash: "#session-1?artifact=a1",
      fetch: async (url, init) =>
        failing
          ? Response.json({ error: "down" }, { status: 503 })
          : serve(url, init),
    },
  );

  await opened(asked);

  expect(page.querySelector("h2")?.textContent).toBe("Kept");

  failing = true;

  act(() => {
    changed("artifacts.artifacts");
  });

  await drawn(() => page.textContent.includes("Kept"));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 400)));

  expect(page.querySelector("h2")?.textContent).toBe("Kept");
  expect(page.textContent).not.toContain("didn't load");
});

test("someone an artifact is shared with to view sees it, and nothing that changes it", async () => {
  const asked: Served[] = [];

  const page = renderPart(
    web,
    "overlay",
    {},
    {
      hash: "#plugin/artifacts?artifact=a1&v=1",
      fetch: serving(
        {
          ...artifact({ kind: "markdown", versions: 2, yours: false }),
          ...viewed(2),
          access: "view",
        },
        asked,
      ),
    },
  );

  await opened(asked);

  expect(page.textContent).toContain("You're viewing version 1.");
  expect(named(page, "Share")).toBeUndefined();
  expect(named(page, "Restore version 1")).toBeUndefined();

  act(() => {
    named(page, "More")?.click();
  });

  expect(menuItems(page).map((each) => each.textContent)).toEqual([
    "Download",
    "Copy link",
    "Copy link to version 1",
    "Pin to sidebar",
    "Go to the Session",
  ]);
});

test("its links are copied, it pins to the sidebar, and its comments open beside it", async () => {
  const asked: Served[] = [];
  const copied: string[] = [];

  const page = renderPart(
    web,
    "overlay",
    {},
    {
      hash: "#session-1?artifact=a1&comments=1",
      fetch: serving({ ...artifact({ versions: 3 }), ...viewed(3) }, asked),
    },
  );

  // The page is set up by now, with its own navigator.
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        await Promise.resolve();
        copied.push(text);
      },
    },
  });

  await opened(asked);
  await act(async () => until(() => asked.length >= 3));

  expect(page.querySelector("aside[aria-label=Comments]")).not.toBeNull();

  const comment = buttons(page).find((each) =>
    each.textContent.startsWith("Comment"),
  );

  expect(comment?.getAttribute("aria-pressed")).toBe("true");

  act(() => {
    comment?.click();
  });

  expect(page.querySelector("aside[aria-label=Comments]")).toBeNull();

  for (const label of ["Copy link", "Copy link to version 3"]) {
    act(() => {
      named(page, "More")?.click();
    });

    const before = copied.length;

    act(() => {
      menuItems(page)
        .find((each) => each.textContent === label)
        ?.click();
    });

    await act(async () => until(() => copied.length > before));
    await drawn(() => page.textContent.includes("Link copied"));
  }

  expect(copied.map((each) => each.slice(each.indexOf("#")))).toEqual([
    "#plugin/artifacts/a1",
    "#plugin/artifacts/a1/v/3",
  ]);

  act(() => {
    named(page, "More")?.click();
  });

  await act(async () => {
    item(page, "Pin to sidebar")?.click();
    await until(() => asked.some(({ url }) => url.endsWith("/pin")));
  });

  expect(asked.find(({ url }) => url.endsWith("/pin"))).toEqual({
    url: "/api/ext/artifacts/artifacts/a1/pin",
    method: "PUT",
    body: { pinned: true },
  });
});

test("deleting asks first, and closes the viewer once it's gone", async () => {
  const asked: Served[] = [];

  const page = renderPart(
    web,
    "overlay",
    {},
    {
      hash: "#session-1?artifact=a1",
      fetch: serving({ ...artifact(), ...viewed(1) }, asked),
    },
  );

  await opened(asked);

  const remove = (): void => {
    act(() => {
      named(page, "More")?.click();
    });

    act(() => {
      item(page, "Delete artifact…")?.click();
    });
  };

  remove();
  expect(page.textContent).toContain("This can't be undone.");

  act(() => {
    named(page, "Cancel")?.click();
  });

  expect(asked.some(({ method }) => method === "DELETE")).toBe(false);

  remove();

  await act(async () => {
    named(page, "Delete")?.click();
    await until(() => !location.hash.includes("?"));
  });

  expect(asked.find(({ method }) => method === "DELETE")?.url).toBe(
    "/api/ext/artifacts/artifacts/a1",
  );

  expect(location.hash).toBe("#session-1");
});

test("an artifact that isn't there, or didn't load, still offers a way out", async () => {
  let answer = 404;
  const asked: string[] = [];

  const page = renderPart(
    web,
    "overlay",
    {},
    {
      hash: "#session-1?artifact=gone",
      fetch: async (url) => {
        await Promise.resolve();
        asked.push(url);

        if (url.endsWith("/comments")) {
          return Response.json({ comments: [] });
        }

        return answer === 200
          ? Response.json({
              ...artifact({ title: "Back again" }),
              ...viewed(1),
            })
          : Response.json({ error: "oops" }, { status: answer });
      },
    },
  );

  await act(async () => until(() => asked.length === 1));
  await drawn(() => page.textContent.includes("This artifact isn't here"));

  expect(named(page, "Close")).toBeDefined();

  await act(async () => {
    named(page, "Close")?.click();
    await until(() => !location.hash.includes("?"));
  });

  answer = 500;

  act(() => {
    history.replaceState(null, "", "#session-1?artifact=a1");
    dispatchEvent(new HashChangeEvent("hashchange"));
  });

  await act(async () => until(() => asked.length === 2));

  await drawn(() => page.textContent.includes("The artifact didn't load"));

  answer = 200;

  act(() => {
    named(page, "Try again")?.click();
  });

  await act(async () => until(() => asked.length >= 3));

  await drawn(() => page.querySelector("h2")?.textContent === "Back again");
});

function artifact(o: Partial<ArtifactSummary> = {}): ArtifactSummary {
  return {
    id: "a1",
    title: "Report",
    kind: "html",
    sessionId: "session-1",
    sessionTitle: "Why did checkout slow down?",
    owner: "Ana",
    yours: true,
    audience: "you",
    sharedWith: [],
    openComments: 0,
    versions: 1,
    updatedAt: 0,
    ...o,
  };
}

function viewed(versions: number) {
  return {
    history: Array.from({ length: versions }, (_, at) => ({
      number: at + 1,
      name: "report.html",
      size: 10,
      author: "session:session-1",
      by: "Pi",
      note: at === 0 ? "first draft" : "",
      createdAt: Date.now(),
    })),
    access: "steer",
    shares: [],
    pinned: false,
  };
}

const slots = { page: web.pages?.[0]?.Page };

test("the Artifacts page shows yours, the ones shared with you and the team's, finds them by title or Session, and opens one over the page", async () => {
  const asked: string[] = [];

  const page = renderPart(
    { ...web, slots },
    "page",
    { path: "" },
    {
      hash: "#plugin/artifacts",
      fetch: async (url) => {
        await Promise.resolve();

        asked.push(url);

        return Response.json({
          artifacts: [
            artifact({
              id: "a1",
              title: "Checkout latency",
              audience: "named",
              sharedWith: ["Bo", "Cy"],
              openComments: 2,
            }),
            artifact({
              id: "a2",
              title: "Billing flow",
              sessionTitle: "Draw the billing flow",
            }),
            artifact({
              id: "a3",
              title: "Bo's plan",
              yours: false,
              owner: "Bo",
            }),
            artifact({ id: "a4", title: "Rollout", audience: "team" }),
          ],
        });
      },
    },
  );

  await act(async () => until(() => asked.length === 1));

  const titles = (): string[] =>
    [...page.querySelectorAll("[aria-label=Artifacts] li a")].map(
      (each) => each.textContent,
    );

  expect(titles()).toEqual(["Checkout latency", "Billing flow"]);
  expect(page.textContent).toContain("2 comments");
  expect(page.textContent).toContain("Shared with Bo, Cy");
  expect(page.textContent).toContain("Only you");

  const show = (label: string): void => {
    act(() => {
      [...page.querySelectorAll<HTMLButtonElement>("[aria-label=Show] button")]
        .find((each) => each.textContent === label)
        ?.click();
    });
  };

  show("Shared with you");
  expect(titles()).toEqual(["Bo's plan"]);
  expect(page.textContent).toContain("From Bo");
  show("Team");
  expect(titles()).toEqual(["Rollout"]);
  show("Yours");

  const search = page.querySelector<HTMLInputElement>("input[type=search]");

  act(() => {
    if (search !== null) {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set?.call(search, "billing");

      search.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });

  expect(titles()).toEqual(["Billing flow"]);

  await act(async () => {
    page
      .querySelector<HTMLAnchorElement>("[aria-label=Artifacts] li a")
      ?.click();

    await until(() => location.hash.includes("?"));
  });

  expect(location.hash).toBe("#plugin/artifacts?artifact=a2");
});

test("a link opens the artifact alone in the window, and an earlier version offers the latest and a restore", async () => {
  const asked: { url: string; method: string }[] = [];

  const page = renderPart(
    { ...web, slots },
    "page",
    { path: "a1/v/2" },
    {
      hash: "#plugin/artifacts/a1/v/2",
      fetch: async (url, init) => {
        await Promise.resolve();

        asked.push({ url, method: init?.method ?? "GET" });

        if (url.endsWith("/comments")) {
          return Response.json({ comments: [] });
        }

        return url.endsWith("/restore")
          ? Response.json({ version: 4 })
          : Response.json({ ...artifact({ versions: 3 }), ...viewed(3) });
      },
    },
  );

  // The artifact loads, and then what its comments quote.
  await act(async () => until(() => asked.length === 1));
  await act(async () => until(() => asked.length === 2));

  expect(page.textContent).toContain(
    "By Ana · from “Why did checkout slow down?”",
  );

  expect(page.textContent).toContain(
    "You're viewing version 2. The latest is version 3.",
  );

  expect(page.querySelector("button[aria-label=Close]")).toBeNull();
  expect(page.querySelector("a[aria-label='Open in a new tab']")).toBeNull();

  await act(async () => {
    [...page.querySelectorAll<HTMLButtonElement>("button")]
      .find((each) => each.textContent === "Restore version 2")
      ?.click();

    await until(() => asked.some(({ url }) => url.endsWith("/restore")));
  });

  expect(asked.at(-1)).toEqual({
    url: "/api/ext/artifacts/artifacts/a1/restore",
    method: "POST",
  });

  await act(async () => until(() => location.hash === "#plugin/artifacts/a1"));

  expect(location.hash).toBe("#plugin/artifacts/a1");
});

test("sharing names people and what they can do, and the link opens the latest or one version", async () => {
  const asked: { url: string; body?: unknown }[] = [];

  const page = renderPart(
    { ...web, slots },
    "page",
    { path: "a1" },
    {
      fetch: async (url, init) => {
        await Promise.resolve();

        asked.push({
          url,
          ...(typeof init?.body === "string" && {
            body: JSON.parse(init.body) as unknown,
          }),
        });

        if (url.endsWith("/comments")) {
          return Response.json({ comments: [] });
        }

        return url.endsWith("/shares")
          ? Response.json({ shares: [] })
          : Response.json({ ...artifact({ versions: 2 }), ...viewed(2) });
      },
    },
  );

  // The artifact loads, and then what its comments quote.
  await act(async () => until(() => asked.length === 1));
  await act(async () => until(() => asked.length === 2));

  const button = (label: string): HTMLButtonElement | undefined =>
    [...page.querySelectorAll<HTMLButtonElement>("button")].find(
      (each) => each.textContent === label,
    );

  act(() => {
    button("Share")?.click();
  });

  const type = (input: HTMLInputElement | null, text: string): void => {
    if (input === null) {
      return;
    }

    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(input, text);

    input.dispatchEvent(new Event("input", { bubbles: true }));
  };

  act(() => {
    page.querySelectorAll<HTMLInputElement>("input[name=audience]")[1]?.click();
  });

  act(() => {
    type(page.querySelector("input[aria-label=Name]"), "Bo");
  });

  act(() => {
    button("Add")?.click();
  });

  act(() => {
    [...page.querySelectorAll<HTMLButtonElement>("[aria-label=Access] button")]
      .find((each) => each.textContent === "Comment")
      ?.click();

    button("Version 2 only")?.click();
  });

  expect(page.querySelector("dialog code")?.textContent).toEndWith(
    "#plugin/artifacts/a1/v/2",
  );

  expect(page.textContent).toContain("can't send them to Pi");

  await act(async () => {
    button("Save")?.click();
    await until(() => asked.some(({ url }) => url.endsWith("/shares")));
  });

  expect(asked.at(-1)).toEqual({
    url: "/api/ext/artifacts/artifacts/a1/shares",
    body: { shares: [{ name: "Bo", role: "comment" }] },
  });
});
