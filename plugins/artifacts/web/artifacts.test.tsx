import { expect, test } from "bun:test";
import { renderPart, sessionWith } from "@pipoca/plugins/web/testing";
import { until } from "@pipoca/testing/until";
import { act } from "react";
import type { ArtifactSummary, Comment, Presence } from "../src/artifacts";
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
  readonly keepalive?: true;
}

// Answers who's looking for a fake that doesn't, and keeps those calls out
// of what it hears.
function lively(
  fetch: (url: string, init?: RequestInit) => Promise<Response>,
): (url: string, init?: RequestInit) => Promise<Response> {
  return async (url, init) =>
    url.endsWith("/presence") || url.endsWith("/people")
      ? Response.json({ people: [] })
      : fetch(url, init);
}

// The plugin's routes as a fake server, with the artifact these tests open
// and its comments. Writing a comment answers with a new thread's id.
function serving(
  shown: object,
  asked: Served[],
  {
    comments = () => [],
    people = [],
    here = () => [],
    beats = [],
  }: {
    readonly comments?: () => readonly Comment[];
    // Who else can see the artifact, and who of them is looking now.
    readonly people?: readonly string[];
    readonly here?: () => readonly Presence[];
    // Where the viewer's presence calls go, kept out of what was asked.
    readonly beats?: Served[];
  } = {},
): (url: string, init?: RequestInit) => Promise<Response> {
  return async (url, init) => {
    await Promise.resolve();

    const served: Served = {
      url,
      method: init?.method ?? "GET",
      ...(typeof init?.body === "string" && {
        body: JSON.parse(init.body) as unknown,
      }),
      ...(init?.keepalive === true && { keepalive: true as const }),
    };

    if (url.endsWith("/presence")) {
      beats.push(served);

      return Response.json(served.method === "GET" ? { people: here() } : {});
    }

    if (url.endsWith("/people")) {
      return Response.json({ people });
    }

    asked.push(served);

    if (url.endsWith("/comments")) {
      return Response.json(
        init?.method === "POST"
          ? {
              id: "new",
              sentToPi:
                typeof init.body === "string" && init.body.includes("@pi"),
            }
          : { comments: comments() },
      );
    }

    if (url.endsWith("/comments/send") && typeof init?.body === "string") {
      const { threads } = JSON.parse(init.body) as { threads: string[] };

      return Response.json({ sent: threads.length });
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

// Answers the confirm dialog with this title.
function asking(page: HTMLElement, title: string, answer: string): void {
  const dialog = [...page.querySelectorAll("dialog")].find(
    (each) => each.querySelector("h2")?.textContent === title,
  );

  if (dialog === undefined) {
    throw new Error(`no dialog “${title}”`);
  }

  [...dialog.querySelectorAll("button")]
    .find((each) => each.textContent === answer)
    ?.click();
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
  // The artifact loads, and then its comments.
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

  // The older side offers only versions before the newer one.
  act(() => {
    named(page, "Version 2, older version")?.click();
  });

  expect(menuItems(page).map((each) => each.textContent)).toEqual([
    "Version 2Pi · just now",
    "Version 1Pi · just now · “first draft”",
  ]);

  act(() => {
    item(page, "Version 1")?.click();
  });

  expect(page.querySelector("section")?.getAttribute("aria-label")).toBe(
    "Version 1",
  );

  act(() => {
    named(page, "Version 3 · latest, newer version")?.click();
  });

  expect(menuItems(page).map((each) => each.textContent)).toEqual([
    "Version 3 latestPi · just now",
    "Version 2Pi · just now",
  ]);

  act(() => {
    named(page, "Version 3 · latest, newer version")?.click();
  });

  act(() => {
    named(page, "Source diff")?.click();
  });

  await drawn(
    () => page.querySelector("[aria-label=Changes][aria-busy=false]") !== null,
  );

  expect(
    [...page.querySelectorAll("[aria-label=Changes] div")].map(
      (each) => each.textContent,
    ),
  ).toEqual(["  same", "- removed: version 1", "+ added: version 3", "  "]);

  // Escape steps back out of compare, and not out of the viewer.
  act(() => {
    named(page, "Back to version 3")?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });

  expect(page.textContent).not.toContain("Comparing two versions");
  expect(location.hash).toBe("#session-1?artifact=a1");

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

test("pictures compare side by side only", async () => {
  const asked: Served[] = [];

  const page = renderPart(
    web,
    "overlay",
    {},
    {
      hash: "#session-1?artifact=a1",
      fetch: serving(
        { ...artifact({ kind: "image", versions: 2 }), ...viewed(2) },
        asked,
      ),
    },
  );

  await opened(asked);

  act(() => {
    versionMenu(page)?.click();
  });

  act(() => {
    item(page, "Compare versions…")?.click();
  });

  expect(page.querySelectorAll("section iframe")).toHaveLength(2);
  expect(named(page, "Source diff")).toBeUndefined();

  // Their text is never read to mark changes.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  expect(asked.some(({ url }) => /\/(view|download)\?v=/.test(url))).toBe(
    false,
  );
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

          if (body.base === 2) {
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

        if (url.endsWith("/versions")) {
          asked.push({
            url,
            method: "POST",
            body: JSON.parse(init?.body as string) as unknown,
          });

          return Response.json({ version: 4 });
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

  // Same origin only to keep its scroll: it runs no scripts.
  expect(page.querySelector("iframe")?.getAttribute("sandbox")).toBe(
    "allow-same-origin",
  );

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
    asking(page, "Discard your changes?", "Cancel");
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

  // Until the newer version loads, the bar says what the server said.
  expect(page.querySelector("[role=alert]")?.textContent).toBe(
    "Pi saved version 3 while you were editing.Open the latestSave anyway",
  );

  expect(save()).toBeUndefined();

  shown = { ...artifact({ kind: "markdown", versions: 3 }), ...viewed(3) };

  act(() => {
    changed("artifacts.artifacts");
  });

  await drawn(() => named(page, "Open version 3") !== undefined);

  expect(page.querySelector("[role=alert]")?.textContent).toBe(
    "Pi saved version 3 while you were editing.Open version 3Save anyway as version 4",
  );

  expect(source()?.value).toBe("same\nmine\n");

  act(() => {
    named(page, "Open version 3")?.click();
  });

  await drawn(() => named(page, "Discard") !== undefined);

  act(() => {
    asking(page, "Open version 3 and discard your changes?", "Cancel");
  });

  await drawn(() => named(page, "Discard") === undefined);

  await act(async () => {
    named(page, "Save anyway as version 4")?.click();

    await until(
      () => asked.filter(({ method }) => method === "POST").length === 2,
    );
  });

  // On the version the bar names, so a later one still asks.
  expect(asked.filter(({ method }) => method === "POST").at(-1)?.body).toEqual({
    text: "same\nmine\n",
    base: 3,
  });

  await drawn(() => source() === null);

  expect(location.hash).toBe("#session-1?artifact=a1");

  expect(page.querySelector("[role=status]")?.textContent).toBe(
    "Saved as version 4",
  );
});

async function editing(
  fetch: (url: string, init?: RequestInit) => Promise<Response>,
  asked: Served[],
): Promise<HTMLElement> {
  const page = renderPart(
    web,
    "overlay",
    {},
    { hash: "#session-1?artifact=a1", fetch },
  );

  await opened(asked);

  act(() => {
    named(page, "More")?.click();
  });

  act(() => {
    item(page, "Edit")?.click();
  });

  return page;
}

const escape = (page: HTMLElement): void => {
  act(() => {
    page
      .querySelector("textarea")
      ?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
  });
};

test("leaving the editor asks only when there are changes, and drops them once the person says so", async () => {
  const asked: Served[] = [];

  const shown = {
    ...artifact({ kind: "markdown", versions: 2 }),
    ...viewed(2),
  };

  const page = await editing(serving(shown, asked), asked);

  const source = (): HTMLTextAreaElement | null =>
    page.querySelector("textarea[aria-label=Markdown]");

  await drawn(() => source()?.value === "same\nversion 2\n");

  escape(page);

  await drawn(() => source() === null);

  expect(named(page, "Discard")).toBeUndefined();

  act(() => {
    named(page, "More")?.click();
  });

  act(() => {
    item(page, "Edit")?.click();
  });

  await drawn(() => source()?.value === "same\nversion 2\n");

  typeInto(source(), "mine\n");
  escape(page);

  await drawn(() => named(page, "Discard") !== undefined);

  act(() => {
    asking(page, "Discard your changes?", "Discard");
  });

  await drawn(() => source() === null);

  expect(asked.some(({ method }) => method === "POST")).toBe(false);
  expect(page.querySelector("[role=status]")?.textContent ?? "").toBe("");
});

test("a version that doesn't load in the editor says so and loads on another try", async () => {
  const asked: Served[] = [];

  const shown = {
    ...artifact({ kind: "markdown", versions: 2 }),
    ...viewed(2),
  };

  const serve = serving(shown, asked);
  let failing = true;

  const page = await editing(async (url, init) => {
    if (failing && url.includes("/download")) {
      failing = false;

      return Response.json({ error: "down" }, { status: 503 });
    }

    return serve(url, init);
  }, asked);

  await drawn(() => named(page, "Try again") !== undefined);

  expect(page.querySelector("[role=alert]")?.textContent).toBe(
    "Version 2 didn't load. Check your connection and try again.",
  );

  expect(named(page, "Save as version 3")).toBeUndefined();
  expect(page.querySelector("textarea")?.disabled).toBe(true);

  act(() => {
    named(page, "Try again")?.click();
  });

  await drawn(
    () => page.querySelector("textarea")?.value === "same\nversion 2\n",
  );

  expect(page.querySelector("[role=alert]")).toBeNull();
  expect(named(page, "Save as version 3")).toBeDefined();
});

test("a version saved meanwhile by the person themselves says it was them", async () => {
  const asked: Served[] = [];
  let shown = { ...artifact({ kind: "markdown", versions: 2 }), ...viewed(2) };

  const page = await editing(
    async (url, init) => serving(shown, asked)(url, init),
    asked,
  );

  await drawn(
    () => page.querySelector("textarea")?.value === "same\nversion 2\n",
  );

  const third = viewed(3);

  shown = {
    ...artifact({ kind: "markdown", versions: 3 }),
    ...third,
    history: third.history.map((each) =>
      each.number === 3 ? { ...each, author: "user:ana", by: "Ana" } : each,
    ),
  };

  act(() => {
    changed("artifacts.artifacts");
  });

  await drawn(() => page.querySelector("[role=alert]") !== null);

  expect(page.querySelector("[role=alert] span")?.textContent).toBe(
    "You saved version 3 while you were editing.",
  );
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

test("a restored version shows in the chat as restored", async () => {
  const restored = { ...viewed(3) };

  const page = renderPart(
    web,
    "notice:artifact_version",
    { text: "Ana restored version 1", data: { artifact: "a1", version: 3 } },
    {
      fetch: serving(
        {
          ...artifact({ title: "Rollout plan", kind: "markdown", versions: 3 }),
          ...restored,
          history: restored.history.map((each) =>
            each.number === 3
              ? {
                  ...each,
                  author: "user:ana",
                  by: "Ana",
                  note: "restored version 1",
                }
              : each,
          ),
        },
        [],
      ),
    },
  );

  await drawn(() => page.textContent.includes("Rollout plan"));

  expect(page.textContent).toContain(
    "Ana restored version 1 as version 3 of Rollout plan",
  );
});

test("a version row without its version says only that there's a new one", async () => {
  const page = renderPart(
    web,
    "notice:artifact_version",
    { text: "Ana saved a version", data: { artifact: "a1" } },
    {
      fetch: serving(
        { ...artifact({ title: "Rollout plan" }), ...viewed(2) },
        [],
      ),
    },
  );

  await drawn(() => page.querySelector("a") !== null);

  expect(page.textContent).toContain("A new version of an artifact");

  expect(page.querySelector("a")?.getAttribute("href")).toBe(
    "#plugin/artifacts/a1",
  );
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
  await drawn(() => page.querySelector("aside[aria-label=Comments]") !== null);

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
      fetch: lively(async (url, init) => {
        await Promise.resolve();

        asked.push({ url, method: init?.method ?? "GET" });

        if (url.endsWith("/comments")) {
          return Response.json({ comments: [] });
        }

        return url.endsWith("/restore")
          ? Response.json({ version: 4 })
          : Response.json({ ...artifact({ versions: 3 }), ...viewed(3) });
      }),
    },
  );

  // The artifact loads, and then its comments.
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
      fetch: lively(async (url, init) => {
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
      }),
    },
  );

  // The artifact loads, and then its comments.
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

function frameOf(page: HTMLElement): {
  readonly tell: (data: object) => void;
  readonly told: () => readonly {
    pipoca?: string;
    pins?: unknown;
    on?: boolean;
  }[];
} {
  const frame = page.querySelector<HTMLIFrameElement>("iframe[src*='/view']");
  const window = frame?.contentWindow;
  const posted: { pipoca?: string }[] = [];

  if (window !== null && window !== undefined) {
    window.postMessage = (data: unknown) => {
      posted.push(data as { pipoca?: string });
    };
  }

  return {
    tell: (data) => {
      act(() => {
        dispatchEvent(
          new MessageEvent("message", { data, source: window ?? null }),
        );
      });
    },
    told: () => posted,
  };
}

const rect = { x: 120, y: 80, width: 200, height: 18 };

function commentMode(page: HTMLElement): void {
  act(() => {
    buttons(page)
      .find(
        (each) =>
          each.hasAttribute("aria-pressed") &&
          each.textContent.startsWith("Comment"),
      )
      ?.click();
  });
}

test("a comment is written where the person selected or clicked, of the kind they choose, and kept as a draft for Pi", async () => {
  const asked: Served[] = [];
  const comments: Comment[] = [];

  const page = renderPart(
    web,
    "overlay",
    {},
    {
      hash: "#session-1?artifact=a1",
      fetch: serving(
        { ...artifact({ versions: 2 }), ...viewed(2), askable: true },
        asked,
        { comments: () => comments },
      ),
    },
  );

  await opened(asked);

  let frame = frameOf(page);

  const box = (): HTMLFormElement | null =>
    page.querySelector("form[aria-label='New comment']");

  // Outside comment mode, and from anything but the page, a pick opens
  // nothing.
  frame.tell({ pipoca: "selection", text: "three times", rect });
  expect(box()).toBeNull();

  commentMode(page);

  act(() => {
    dispatchEvent(
      new MessageEvent("message", {
        data: { pipoca: "selection", text: "forged", rect },
        source: null,
      }),
    );
  });

  expect(box()).toBeNull();

  frame.tell({ pipoca: "selection", text: "three times", rect });

  await drawn(() => box() !== null);

  expect(
    page.querySelector("aside[aria-label=Comments]")?.textContent,
  ).toContain("You writing…three times");

  expect(box()?.textContent).toContain("three times");

  expect(box()?.textContent).toContain(
    "Saved as a draft for Pi. Send it now with @pi, or later with the others.",
  );

  // Scrolling the page moves the box, without pinning the page again.
  const pinned = (): number =>
    frame.told().filter((each) => each.pipoca === "pins").length;

  const before = pinned();

  frame.tell({ pipoca: "scroll", x: 0, y: 40 });
  frame.tell({ pipoca: "scroll", x: 0, y: 40 });

  expect(pinned()).toBe(before);
  expect(box()).not.toBeNull();

  // Escape in the box drops it, and leaves the viewer open.
  act(() => {
    box()
      ?.querySelector("textarea")
      ?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
  });

  expect(box()).toBeNull();
  expect(page.querySelector("dialog")).not.toBeNull();

  // So does Escape in the page.
  frame.tell({ pipoca: "selection", text: "three times", rect });
  await drawn(() => box() !== null);
  frame.tell({ pipoca: "escape" });
  expect(box()).toBeNull();

  // A comment being written belongs to the version it's on.
  frame.tell({ pipoca: "selection", text: "three times", rect });
  await drawn(() => box() !== null);

  act(() => {
    history.replaceState(null, "", "#session-1?artifact=a1&v=1");
    dispatchEvent(new HashChangeEvent("hashchange"));
  });

  await drawn(() => versionMenu(page)?.textContent === "Version 1 of 2");

  expect(box()).toBeNull();
  expect(page.textContent).not.toContain("You writing…");

  act(() => {
    history.replaceState(null, "", "#session-1?artifact=a1");
    dispatchEvent(new HashChangeEvent("hashchange"));
  });

  await drawn(() => versionMenu(page)?.textContent === "Version 2 · latest");

  expect(box()).toBeNull();

  // The page is drawn again for that version.
  frame = frameOf(page);

  // In comment mode, clicking an element picks it.
  frame.tell({
    pipoca: "element",
    selector: "body > div:nth-of-type(1) > span:nth-of-type(4)",
    label: "Nov 3",
    rect,
  });

  await drawn(() => box() !== null);

  expect(box()?.textContent).toContain("On “Nov 3”");

  act(() => {
    [...(box()?.querySelectorAll("button") ?? [])]
      .find((each) => each.textContent === "Question")
      ?.click();
  });

  typeInto(
    box()?.querySelector("textarea[aria-label='Comment text']") ?? null,
    "Is this the retry?",
  );

  comments.push(
    thread({
      id: "new",
      author: "You",
      kind: "question",
      quote: "Nov 3",
      element: "body > div:nth-of-type(1) > span:nth-of-type(4)",
      body: "Is this the retry?",
    }),
  );

  await act(async () => {
    box()?.requestSubmit();
    await until(() => asked.some(({ method }) => method === "POST"));
  });

  expect(asked.find(({ method }) => method === "POST")).toEqual({
    url: "/api/ext/artifacts/artifacts/a1/comments",
    method: "POST",
    body: {
      version: 2,
      body: "Is this the retry?",
      kind: "question",
      toPi: false,
      quote: "Nov 3",
      element: "body > div:nth-of-type(1) > span:nth-of-type(4)",
    },
  });

  // The new thread takes focus, and the header says where it went.
  await drawn(() => named(page, "Comment 1 by You") !== undefined);

  expect(box()).toBeNull();
  expect(document.activeElement).toBe(named(page, "Comment 1 by You") ?? null);

  expect(page.querySelector("[role=status]")?.textContent).toBe(
    "Saved as a draft for Pi",
  );
});

function thread(o: Partial<Comment> & { readonly id: string }): Comment {
  return {
    kind: "comment",
    version: 2,
    parent: null,
    author: "Ana",
    byPi: false,
    quote: "",
    element: "",
    body: "A comment",
    sentBy: null,
    resolved: false,
    resolvedByPi: false,
    createdAt: Date.now(),
    reactions: [],
    ...o,
  };
}

test("drafts for Pi are listed with the page's pins, and the checked ones go to Pi together", async () => {
  const asked: Served[] = [];

  const comments = [
    thread({
      id: "t1",
      kind: "question",
      quote: "three times",
      body: "Attempts or retries?",
    }),
    thread({ id: "t2", author: "Rui", body: "Keep this chart" }),
    thread({
      id: "t3",
      author: "You",
      quote: "Nov 3",
      element: "body > span:nth-of-type(4)",
      body: "Add the error rate",
    }),
    thread({ id: "t4", body: "Already asked", sentBy: "Ana" }),
    thread({
      id: "t5",
      quote: "old wording",
      body: "Done",
      resolved: true,
      resolvedByPi: true,
    }),
    // An element is pinned only on its own version; quoted text on any.
    thread({
      id: "t6",
      version: 1,
      quote: "Header",
      element: "body > h1:nth-of-type(1)",
      body: "Bigger",
      sentBy: "Rui",
    }),
    thread({
      id: "t7",
      version: 1,
      quote: "p95",
      body: "Which percentile?",
      sentBy: "Rui",
    }),
  ];

  const serve = serving(
    { ...artifact({ versions: 2 }), ...viewed(2), askable: true },
    asked,
    { comments: () => comments },
  );

  let sends = 0;
  let resolves = 0;

  const page = renderPart(
    web,
    "overlay",
    {},
    {
      hash: "#session-1?artifact=a1&comments=1",
      fetch: lively(async (url, init) => {
        if (url.endsWith("/send") && (sends += 1) === 1) {
          return Response.json({ error: "Pi is offline" }, { status: 503 });
        }

        if (url.endsWith("/resolve") && (resolves += 1) === 1) {
          return Response.json({ error: "Try later" }, { status: 503 });
        }

        if (url.endsWith("/t2/resolve")) {
          comments[1] = thread({
            id: "t2",
            author: "Rui",
            body: "Keep this chart",
            resolved: true,
          });
        }

        return serve(url, init);
      }),
    },
  );

  await opened(asked);

  const aside = (): HTMLElement | null =>
    page.querySelector("aside[aria-label=Comments]");

  await drawn(() => aside()?.textContent.includes("Attempts") === true);

  const frame = frameOf(page);

  expect(aside()?.textContent).toContain("3 threads not sent to Pi");
  expect(named(page, "Send 3 to Pi")).toBeDefined();
  expect(named(page, "Open 6")?.getAttribute("aria-pressed")).toBe("true");
  expect(aside()?.textContent).toContain("Pi handles them in one turn");
  expect(aside()?.textContent).toContain("Sent to Pi by Ana");
  expect(aside()?.textContent).toContain("Question");
  expect(aside()?.textContent).toContain("on “Nov 3”");

  act(() => {
    [...page.querySelectorAll("label")]
      .find((each) => each.textContent === "Send comment 2 to Pi")
      ?.querySelector("input")
      ?.click();
  });

  expect(named(page, "Send 2 to Pi")).toBeDefined();
  expect(aside()?.textContent).toContain("Left out of this send");

  expect(aside()?.textContent).toContain("The one left out stays a draft");

  // A pin on the page opens its thread, and the page marks it.
  frame.tell({ pipoca: "pin", n: 3 });

  await drawn(
    () => document.activeElement?.textContent === "Thread on “Nov 3”",
  );

  await drawn(() =>
    Bun.deepEquals(
      frame
        .told()
        .filter((each) => each.pipoca === "pins")
        .at(-1)?.pins,
      [
        { n: 1, quote: "three times", selector: "", active: false },
        {
          n: 3,
          quote: "Nov 3",
          selector: "body > span:nth-of-type(4)",
          active: true,
        },
        { n: 7, quote: "p95", selector: "", active: false },
      ],
    ),
  );

  expect(
    frame
      .told()
      .filter((each) => each.pipoca === "commenting")
      .at(-1)?.on,
  ).toBe(true);

  // Back at the list, focus is on the thread's card again.
  act(() => {
    named(page, "All comments")?.click();
  });

  expect(document.activeElement?.getAttribute("aria-label")).toBe(
    "Comment 3 by You",
  );

  // A send that fails says so, and can be tried again.
  act(() => {
    named(page, "Send 2 to Pi")?.click();
  });

  await drawn(() => aside()?.textContent.includes("Pi is offline") === true);

  await act(async () => {
    named(page, "Send 2 to Pi")?.click();
    await until(() => asked.some(({ url }) => url.endsWith("/send")));
  });

  expect(asked.find(({ url }) => url.endsWith("/send"))?.body).toEqual({
    threads: ["t1", "t3"],
  });

  // The banner's button is gone once sent, so focus goes to the list's
  // heading and the header says what happened.
  await drawn(() => !(aside()?.textContent.includes("Pi is offline") ?? true));
  expect(page.querySelector("[role=status]")?.textContent).toBe("Sent 2 to Pi");
  expect(document.activeElement?.textContent).toBe("Comments");

  // A thread takes replies, and can be resolved.
  act(() => {
    named(page, "Comment 2 by Rui")?.click();
  });

  const reply = (): HTMLFormElement | null =>
    page.querySelector("form[aria-label=Reply]");

  typeInto(reply()?.querySelector("textarea") ?? null, "Agreed");

  // A second press while the first is on its way sends nothing.
  act(() => {
    reply()?.requestSubmit();
  });

  await act(async () => {
    reply()?.requestSubmit();

    await until(() =>
      asked.some(
        ({ method, url }) => method === "POST" && url.endsWith("/comments"),
      ),
    );
  });

  await drawn(() => reply()?.querySelector("textarea")?.value === "");

  expect(
    asked
      .filter(
        ({ method, url }) => method === "POST" && url.endsWith("/comments"),
      )
      .map(({ body }) => body),
  ).toEqual([{ version: 2, body: "Agreed", parent: "t2", toPi: false }]);

  act(() => {
    named(page, "Resolve")?.click();
  });

  await drawn(() => aside()?.textContent.includes("Try later") === true);

  // A second press while the first is on its way sends nothing.
  act(() => {
    named(page, "Resolve")?.click();
  });

  await act(async () => {
    named(page, "Resolve")?.click();
    await until(() => asked.some(({ url }) => url.endsWith("/resolve")));
  });

  await drawn(
    () => page.querySelector("[role=status]")?.textContent === "Resolved",
  );

  expect(asked.filter(({ url }) => url.endsWith("/resolve"))).toHaveLength(1);

  expect(asked.find(({ url }) => url.endsWith("/resolve"))).toEqual({
    url: "/api/ext/artifacts/artifacts/a1/comments/t2/resolve",
    method: "POST",
    body: { resolved: true },
  });

  expect(named(page, "Reopen")).toBeDefined();
  expect(reply()).toBeNull();

  // The resolved thread isn't open any more, so focus goes to the list.
  act(() => {
    named(page, "All comments")?.click();
  });

  await drawn(() => document.activeElement?.textContent === "Comments");

  act(() => {
    named(page, "Resolved 2")?.click();
  });

  expect(aside()?.textContent).toContain("Resolved by Pi");
  expect(aside()?.textContent).not.toContain("Attempts or retries?");
});

test("people who only view read the comments but don't write them", async () => {
  const asked: Served[] = [];

  const viewer = renderPart(
    web,
    "overlay",
    {},
    {
      hash: "#session-1?artifact=a1&comments=1",
      fetch: serving(
        { ...artifact({ versions: 1 }), ...viewed(1), access: "view" },
        asked,
      ),
    },
  );

  await opened(asked);

  const frame = frameOf(viewer);

  // Turning comments off and on again never puts the page in comment mode.
  commentMode(viewer);
  commentMode(viewer);

  act(() => {
    viewer
      .querySelector("iframe[src*='/view']")
      ?.dispatchEvent(new Event("load"));
  });

  frame.tell({ pipoca: "selection", text: "three times", rect });

  expect(viewer.querySelector("form[aria-label='New comment']")).toBeNull();

  await drawn(() => viewer.textContent.includes("No comments yet."));

  expect(viewer.textContent).toContain(
    "You can read comments here but not add them.",
  );

  expect(named(viewer, "Comment on the whole page")).toBeUndefined();

  const modes = frame.told().filter((each) => each.pipoca === "commenting");

  expect(modes.length).toBeGreaterThan(0);
  expect(modes.every((each) => each.on === false)).toBe(true);
});

test("comments that can't be loaded say so, and the page still shows", async () => {
  const asked: Served[] = [];
  const serve = serving({ ...artifact(), ...viewed(1) }, asked);

  const page = renderPart(
    web,
    "overlay",
    {},
    {
      hash: "#session-1?artifact=a1&comments=1",
      fetch: lively(async (url, init) =>
        url.endsWith("/comments")
          ? Response.json({ error: "down" }, { status: 500 })
          : serve(url, init),
      ),
    },
  );

  await drawn(() => page.textContent.includes("Comments couldn't be loaded."));

  expect(page.querySelector("iframe[src*='/view']")).not.toBeNull();
  expect(page.textContent).not.toContain("Select text or click");
});

test("a comment can be on the whole page, for people who can't select", async () => {
  const asked: Served[] = [];
  const serve = serving({ ...artifact({ versions: 1 }), ...viewed(1) }, asked);
  let failing = false;

  const page = renderPart(
    web,
    "overlay",
    {},
    {
      hash: "#session-1?artifact=a1&comments=1",
      fetch: lively(async (url, init) =>
        failing && init?.method === "POST"
          ? Response.json({ error: "Disk full" }, { status: 507 })
          : serve(url, init),
      ),
    },
  );

  await opened(asked);

  await drawn(() => named(page, "Comment on the whole page") !== undefined);

  expect(page.textContent).toContain(
    "Select text or click part of the page to comment on it.",
  );

  act(() => {
    named(page, "Comment on the whole page")?.focus();
    named(page, "Comment on the whole page")?.click();
  });

  const box = (): HTMLFormElement | null =>
    page.querySelector("form[aria-label='New comment']");

  expect(box()?.textContent).toContain("On the whole page");

  expect(box()?.textContent).toContain(
    "Pi can't be asked about this artifact, so this comment is for people.",
  );

  expect(document.activeElement).toBe(box()?.querySelector("textarea") ?? null);

  // Cancel gives focus back to what opened the box.
  act(() => {
    named(page, "Cancel")?.click();
  });

  expect(box()).toBeNull();

  expect(document.activeElement).toBe(
    named(page, "Comment on the whole page") ?? null,
  );

  // So does Escape.
  act(() => {
    named(page, "Comment on the whole page")?.focus();
    named(page, "Comment on the whole page")?.click();
  });

  const key = (init: KeyboardEventInit): void => {
    act(() => {
      box()
        ?.querySelector("textarea")
        ?.dispatchEvent(
          new KeyboardEvent("keydown", { bubbles: true, ...init }),
        );
    });
  };

  key({ key: "Escape" });

  expect(box()).toBeNull();

  expect(document.activeElement).toBe(
    named(page, "Comment on the whole page") ?? null,
  );

  act(() => {
    named(page, "Comment on the whole page")?.focus();
    named(page, "Comment on the whole page")?.click();
  });

  // Ctrl+Enter with nothing written sends nothing.
  key({ key: "Enter", ctrlKey: true });
  await act(async () => Promise.resolve());

  expect(asked.some(({ method }) => method === "POST")).toBe(false);

  typeInto(box()?.querySelector("textarea") ?? null, "Shorter, please");

  // A save that fails keeps the box and says why.
  failing = true;

  act(() => {
    box()?.requestSubmit();
  });

  await drawn(() => box()?.textContent.includes("Disk full") === true);

  failing = false;
  key({ key: "Enter", ctrlKey: true });

  await act(async () => {
    await until(() =>
      asked.some(
        ({ method, url }) => method === "POST" && url.endsWith("/comments"),
      ),
    );
  });

  expect(
    asked.find(
      ({ method, url }) => method === "POST" && url.endsWith("/comments"),
    )?.body,
  ).toEqual({
    version: 1,
    body: "Shorter, please",
    kind: "comment",
    toPi: false,
  });

  await drawn(() => box() === null);

  expect(page.querySelector("[role=status]")?.textContent).toBe(
    "Comment saved",
  );
});

test("a pin opens its thread from the page with the comments closed, and @pi sends a new comment at once", async () => {
  const asked: Served[] = [];

  const page = renderPart(
    web,
    "overlay",
    {},
    {
      hash: "#session-1?artifact=a1",
      fetch: serving(
        { ...artifact({ versions: 2 }), ...viewed(2), askable: true },
        asked,
        {
          comments: () => [
            thread({ id: "t1", quote: "three times", body: "Which one?" }),
          ],
        },
      ),
    },
  );

  await opened(asked);

  const frame = frameOf(page);

  expect(page.querySelector("aside[aria-label=Comments]")).toBeNull();

  frame.tell({ pipoca: "pin", n: 1 });

  await drawn(
    () => document.activeElement?.textContent === "Thread on “three times”",
  );

  await drawn(
    () =>
      frame
        .told()
        .filter((each) => each.pipoca === "commenting")
        .at(-1)?.on === true,
  );

  act(() => {
    named(page, "All comments")?.click();
  });

  act(() => {
    named(page, "Comment on the whole page")?.click();
  });

  typeInto(
    page.querySelector("textarea[aria-label='Comment text']"),
    "@pi add a date",
  );

  await act(async () => {
    page
      .querySelector<HTMLFormElement>("form[aria-label='New comment']")
      ?.requestSubmit();

    await until(() => asked.some(({ method }) => method === "POST"));
  });

  await drawn(
    () => page.querySelector("[role=status]")?.textContent === "Sent to Pi",
  );
});

// What the viewer told the server about being here, without its page id.
function told(beats: readonly Served[]): unknown[] {
  return beats
    .filter(({ method }) => method === "POST")
    .map(({ body, keepalive }) => {
      const { page, ...rest } = body as { page: unknown };

      expect(typeof page).toBe("string");

      return keepalive === true ? { ...rest, keepalive } : rest;
    });
}

test("a thread is a small chat: who's here, reactions, mentions and who's typing", async () => {
  const asked: Served[] = [];
  const beats: Served[] = [];
  let here: Presence[] = [{ name: "Rui", typing: null }];
  let held: (() => void) | undefined;
  let refusals = 0;

  const comments = [
    thread({
      id: "t1",
      author: "Rui",
      quote: "A sender retries with exponential backoff for 24 hours",
      body: "Too long. @Ana what do you think?",
      sentBy: "Rui",
      reactions: [{ emoji: "👍", people: ["Ana"], mine: false }],
    }),
    thread({
      id: "t2",
      parent: "t1",
      author: "Pi",
      byPi: true,
      body: "x@Ana @Anabel @ana @AxB @Zed @pi",
    }),
    thread({ id: "t3", author: "Bo", quote: "merchant", body: "Which one?" }),
  ];

  const serve = serving(
    { ...artifact({ versions: 2 }), ...viewed(2), askable: true },
    asked,
    {
      people: ["A.B", "Bo", "Rui"],
      here: () => here,
      beats,
      comments: () => comments,
    },
  );

  const page = renderPart(
    web,
    "overlay",
    {},
    {
      hash: "#session-1?artifact=a1&comments=1",
      fetch: async (url, init) => {
        if (url.endsWith("/t2/reactions") && (refusals += 1) === 1) {
          return Response.json({ error: "Try later" }, { status: 503 });
        }

        if (url.endsWith("/t1/reactions") && typeof init?.body === "string") {
          const { on } = JSON.parse(init.body) as { on: boolean };

          await new Promise<void>((resolve) => {
            held = resolve;
          });

          comments[0] = thread({
            ...comments[0],
            id: "t1",
            reactions: [
              { emoji: "👍", people: on ? ["Ana", "You"] : ["Ana"], mine: on },
            ],
          });
        }

        return serve(url, init);
      },
    },
  );

  await opened(asked);

  await drawn(
    () =>
      page.querySelector("[aria-label='Also here: Rui']") !== null &&
      named(page, "Comment 1 by Rui") !== undefined,
  );

  expect(told(beats)[0]).toEqual({ here: true });

  // A card says how many replies its thread has and whether Pi has it.
  const card = named(page, "Comment 1 by Rui");

  expect(
    card
      ?.getAttribute("aria-describedby")
      ?.split(" ")
      .map((id) => document.getElementById(id)?.textContent),
  ).toEqual([
    "Too long. @Ana what do you think?",
    "1 reply",
    "Sent to Pi by Rui",
  ]);

  act(() => {
    card?.click();
  });

  const section = (): HTMLElement | null =>
    page.querySelector("section[aria-label=Thread]");

  // A long quote keeps its start and end, and says all of it on hover.
  const title = section()?.querySelector("h3");

  expect(title?.textContent).toBe("Thread on “A sender … 24 hours”");

  expect(title?.getAttribute("title")).toBe(
    "A sender retries with exponential backoff for 24 hours",
  );

  expect(title?.parentElement?.textContent).toContain("Sent to Pi");

  const messages = (): Element[] => [
    ...(section()?.querySelectorAll("ol[aria-label=Messages] > li") ?? []),
  ];

  expect(
    messages().map((each) => each.querySelector("b")?.textContent),
  ).toEqual(["Rui", "Pi"]);

  // Only whole names of people who can see it, the viewer's own and Pi's
  // stand out.
  const bold = (at: number): (string | null)[] =>
    [...(messages()[at]?.querySelectorAll("p b") ?? [])].map(
      (each) => each.textContent,
    );

  expect(bold(0)).toEqual(["@Ana"]);
  expect(bold(1)).toEqual(["@ana", "@pi"]);

  // A reaction is added to, and a second press before it lands does
  // nothing; once it's back, pressing it again takes it off.
  const pill = (): HTMLButtonElement | undefined =>
    buttons(page).find(
      (each) =>
        each.getAttribute("aria-label")?.startsWith("Thumbs up from") === true,
    );

  act(() => {
    pill()?.click();
  });

  await act(async () => until(() => held !== undefined));

  expect(pill()?.getAttribute("aria-disabled")).toBe("true");

  act(() => {
    pill()?.click();
  });

  act(() => {
    held?.();
    held = undefined;
  });

  await drawn(() => pill()?.getAttribute("aria-pressed") === "true");

  expect(pill()?.getAttribute("aria-label")).toBe("Thumbs up from Ana, You");

  act(() => {
    pill()?.click();
  });

  await act(async () => until(() => held !== undefined));

  act(() => {
    held?.();
    held = undefined;
  });

  await drawn(() => pill()?.getAttribute("aria-pressed") === "false");

  expect(
    asked
      .filter(({ url }) => url.endsWith("/reactions"))
      .map(({ body }) => body),
  ).toEqual([
    { emoji: "👍", on: true },
    { emoji: "👍", on: false },
  ]);

  // Any of the four can be picked from the message's menu, again after a
  // try that failed.
  const celebrate = (): void => {
    act(() => {
      messages()[1]
        ?.querySelector<HTMLButtonElement>(
          "button[aria-label='Add a reaction']",
        )
        ?.click();
    });

    act(() => {
      [...page.querySelectorAll<HTMLButtonElement>("[role=menuitem]")]
        .find((each) => each.textContent.includes("Celebrate"))
        ?.click();
    });
  };

  celebrate();
  await drawn(() => messages()[1]?.textContent.includes("Try later") === true);

  celebrate();

  await act(async () =>
    until(
      () =>
        asked.filter(({ url }) => url.endsWith("/t2/reactions")).length === 1,
    ),
  );

  expect(
    asked
      .filter(({ url }) => url.endsWith("/t2/reactions"))
      .map(({ body }) => body),
  ).toEqual([{ emoji: "🎉", on: true }]);

  // @ lists the people who can see it and Pi; arrows move and wrap, and
  // Enter picks.
  const box = (): HTMLTextAreaElement | null =>
    page.querySelector("form[aria-label=Reply] textarea");

  const options = (): string[] =>
    [...page.querySelectorAll("[role=listbox][aria-label=People] li")].map(
      (each) => each.querySelector("span")?.textContent ?? "",
    );

  typeInto(box(), "Fine by me @");

  expect(options()).toEqual(["@pi", "@A.B", "@Bo", "@Rui"]);

  // A name that starts with what's typed comes before one that has it.
  typeInto(box(), "Fine by me @b");

  expect(options()).toEqual(["@Bo", "@A.B"]);

  typeInto(box(), "Fine by me @");

  act(() => {
    box()?.focus();

    box()?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }),
    );
  });

  act(() => {
    box()?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
  });

  expect(box()?.value).toBe("Fine by me @Rui ");

  // Typing tells the others once in a burst, and sending says it stopped.
  await act(async () =>
    until(() => told(beats).some((each) => Bun.deepEquals(each, typingIn))),
  );

  expect(
    told(beats).filter((each) => Bun.deepEquals(each, typingIn)),
  ).toHaveLength(1);

  await act(async () => {
    page
      .querySelector<HTMLFormElement>("form[aria-label=Reply]")
      ?.requestSubmit();

    await until(() =>
      told(beats).some((each) => Bun.deepEquals(each, stopped)),
    );
  });

  expect(
    asked
      .filter(
        ({ method, url }) => method === "POST" && url.endsWith("/comments"),
      )
      .map(({ body }) => body),
  ).toEqual([
    { version: 2, body: "Fine by me @Rui", parent: "t1", toPi: false },
  ]);

  await drawn(() => box()?.value === "");

  // Who else types here shows under the messages, and not who types in
  // another thread.
  const typing = (): string | undefined =>
    section()?.querySelector("[role=status]")?.textContent;

  here = [
    { name: "Rui", typing: "t1" },
    { name: "Bo", typing: "t1" },
  ];

  changed("artifacts.presence-a1");
  await drawn(() => typing() === "Rui and Bo are typing…");

  here = [{ name: "Rui", typing: "t3" }];

  changed("artifacts.presence-a1");
  await drawn(() => typing() === "");

  // A pin opens its own thread with an empty reply box, and the typing
  // others saw in the last one stops.
  typeInto(box(), "Half a thought");

  await act(async () =>
    until(() => told(beats).some((each) => Bun.deepEquals(each, typingIn))),
  );

  const stops = told(beats).filter((each) =>
    Bun.deepEquals(each, stopped),
  ).length;

  frameOf(page).tell({ pipoca: "pin", n: 2 });

  await drawn(
    () =>
      section()?.querySelector("h3")?.textContent === "Thread on “merchant”",
  );

  expect(box()?.value).toBe("");

  await act(async () =>
    until(
      () =>
        told(beats).filter((each) => Bun.deepEquals(each, stopped)).length >
        stops,
    ),
  );

  // Leaving the page says so, even as it closes.
  await act(async () => {
    dispatchEvent(new Event("pagehide"));

    await until(() => told(beats).some((each) => Bun.deepEquals(each, gone)));
  });

  expect(told(beats).at(-1)).toEqual({ here: false, keepalive: true });
});

const typingIn = { here: true, typing: "t1" };
const stopped = { here: true, typing: null };
const gone = { here: false, keepalive: true };

test("people who only view read a thread but don't react or reply", async () => {
  const asked: Served[] = [];

  const page = renderPart(
    web,
    "overlay",
    {},
    {
      hash: "#session-1?artifact=a1&comments=1",
      fetch: serving(
        { ...artifact({ versions: 2 }), ...viewed(2), access: "view" },
        asked,
        {
          comments: () => [
            thread({
              id: "t1",
              body: "Ship it",
              reactions: [{ emoji: "🎉", people: ["Bo"], mine: false }],
            }),
          ],
        },
      ),
    },
  );

  await opened(asked);
  await drawn(() => named(page, "Comment 1 by Ana") !== undefined);

  act(() => {
    named(page, "Comment 1 by Ana")?.click();
  });

  expect(named(page, "Celebrate from Bo")?.disabled).toBe(true);
  expect(named(page, "Add a reaction")).toBeUndefined();
  expect(named(page, "Resolve")).toBeUndefined();
  expect(page.querySelector("form[aria-label=Reply]")).toBeNull();
});
