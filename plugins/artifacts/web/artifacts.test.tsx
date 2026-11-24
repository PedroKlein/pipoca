import { expect, spyOn, test } from "bun:test";
import {
  AttachMenu,
  frameSandbox,
  type MountedSession,
  type SessionPartProps,
} from "@pipoca/plugins/web";
import {
  drafts,
  newSessions,
  renderPart,
  resize,
  sessionWith,
} from "@pipoca/plugins/web/testing";
import { until } from "@pipoca/testing/until";
import { act, type ReactElement, useState } from "react";
import type {
  ActivityItem,
  ArtifactSummary,
  ArtifactView,
  Comment,
  Presence,
  Template,
} from "../src/artifacts";
import type { Systems, SystemSummary, SystemView } from "../src/systems";
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
    "Pedro on the whole pageAdd the error rate",
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
  return async (url, init) => {
    return url.endsWith("/presence") || url.endsWith("/people")
      ? Response.json({ people: [] })
      : fetch(url, init);
  };
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

test("Dock pins the viewer beside the page, stays chosen for the person, and is offered only on wide windows", async () => {
  const asked: Served[] = [];
  const Overlay = web.slots?.overlay;
  const Dock = web.slots?.dock;

  const both = {
    both: () => (
      <>
        {Overlay !== undefined && <Overlay />}
        {Dock !== undefined && <Dock />}
      </>
    ),
  };

  const page = renderPart(
    { ...web, slots: both },
    "both",
    {},
    {
      hash: "#session-1?artifact=a1",
      width: 1280,
      fetch: serving(
        { ...artifact({ title: "Rollout" }), ...viewed(1) },
        asked,
      ),
    },
  );

  await opened(asked);

  const dock = (): HTMLButtonElement | undefined =>
    named(page, "Dock beside the page");

  expect(page.querySelector("dialog[open] h2")?.textContent).toBe("Rollout");
  expect(dock()?.getAttribute("aria-pressed")).toBe("false");

  act(() => {
    dock()?.click();
  });

  await drawn(() => page.querySelector("aside h2")?.textContent === "Rollout");

  expect(page.querySelector("dialog[open]")).toBeNull();

  expect(page.querySelector("aside")?.getAttribute("aria-labelledby")).toBe(
    page.querySelector("aside h2")?.id ?? "",
  );

  expect(dock()?.getAttribute("aria-pressed")).toBe("true");

  // Another page the person opens docks it too.
  const later = renderPart(
    { ...web, slots: both },
    "both",
    {},
    { fetch: serving({ ...artifact({ title: "Rollout" }), ...viewed(1) }, []) },
  );

  await drawn(() => later.querySelector("aside h2")?.textContent === "Rollout");
  expect(later.querySelector("dialog[open]")).toBeNull();

  // Pi's card in the chat says where it opens.
  const card = renderPart(
    web,
    "session.toolCall:publish_artifact",
    {
      session: sessionWith({}),
      call: {
        id: "call-1",
        name: "publish_artifact",
        args: { path: "plan.md" },
        status: "done",
        result: { text: "", details: { id: "a1" }, failed: false },
      },
    },
    { fetch: serving({ ...artifact({ title: "Rollout" }), ...viewed(1) }, []) },
  );

  await drawn(() => card.textContent.includes("Rollout"));
  expect(card.textContent).toContain("Open beside the chat · version 1");

  // Too narrow for both, it opens over the page with no Dock.
  act(() => {
    resize(900);
  });

  await drawn(
    () => page.querySelector("dialog[open] h2")?.textContent === "Rollout",
  );

  expect(page.querySelector("aside")).toBeNull();
  expect(dock()).toBeUndefined();

  act(() => {
    resize(1280);
  });

  await drawn(() => dock()?.getAttribute("aria-pressed") === "true");

  act(() => {
    dock()?.click();
  });

  await drawn(
    () => page.querySelector("dialog[open] h2")?.textContent === "Rollout",
  );
});

test("on a phone the viewer moves versions into More, keeps Share and Download at the bottom, and shows comments as a sheet over the page", async () => {
  const asked: Served[] = [];

  const page = renderPart(
    web,
    "overlay",
    {},
    {
      hash: "#session-1?artifact=a1",
      width: 390,
      fetch: serving(
        { ...artifact({ title: "Rollout", versions: 2 }), ...viewed(2) },
        asked,
        {
          comments: () => [
            thread({ id: "t1", quote: "Rollout", body: "Sooner?" }),
          ],
        },
      ),
    },
  );

  // The page exists once drawn.
  const downloads = spyOn(location, "assign").mockImplementation(
    () => undefined,
  );

  try {
    await opened(asked);

    expect(page.querySelector("dialog[open] h2 + span")?.textContent).toBe(
      "Version 2 · latest",
    );

    expect(versionMenu(page)).toBeUndefined();

    act(() => {
      named(page, "More")?.click();
    });

    expect(item(page, "Version 1")).toBeDefined();
    expect(item(page, "Compare versions")).toBeDefined();
    expect(item(page, "Download")).toBeUndefined();

    act(() => {
      named(page, "More")?.click();
    });

    const bar = page.querySelector("[aria-label='Artifact actions']");

    expect(
      [...(bar?.querySelectorAll("button") ?? [])].map(
        (each) => each.textContent,
      ),
    ).toEqual(["Share", "Download"]);

    act(() => {
      named(page, "Download")?.click();
    });

    expect(downloads).toHaveBeenCalledWith(
      expect.stringMatching(/\/artifacts\/a1\/download\?v=2$/),
    );

    // The sheet goes, and comment mode stays for picking a passage.
    commentMode(page);

    await drawn(
      () => page.querySelector("aside[aria-label=Comments]") !== null,
    );

    act(() => {
      named(page, "Back to the page")?.click();
    });

    expect(page.querySelector("aside[aria-label=Comments]")).toBeNull();

    expect(
      buttons(page)
        .find((each) => each.textContent.startsWith("Comment"))
        ?.getAttribute("aria-pressed"),
    ).toBe("true");

    // A pin on the page brings its thread up in the sheet.
    frameOf(page).tell({ pipoca: "pin", n: 1 });

    expect(
      page.querySelector("aside[aria-label=Comments]")?.textContent,
    ).toContain("Sooner?");

    act(() => {
      named(page, "Back to the page")?.click();
    });

    commentMode(page);

    expect(page.querySelector("aside[aria-label=Comments]")).not.toBeNull();

    // A plain artifact has no questions to roll up.
    expect(
      buttons(page).some((each) => each.textContent.startsWith("Questions")),
    ).toBe(false);

    act(() => {
      named(page, "Back to the page")?.click();
    });

    // Wider again, the list is back beside the page.
    act(() => {
      resize(1280);
    });

    await drawn(
      () => page.querySelector("aside[aria-label=Comments]") !== null,
    );

    expect(named(page, "Back to the page")).toBeUndefined();

    commentMode(page);

    expect(page.querySelector("aside[aria-label=Comments]")).toBeNull();
  } finally {
    downloads.mockRestore();
  }
});

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
    "Mark as design doc",
    "Save as template…",
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

test("a restored version and an accepted edit show in the chat as what they were", async () => {
  for (const note of ["restored version 1", "accepted Pi's suggested edit"]) {
    const made = { ...viewed(3) };

    const page = renderPart(
      web,
      "notice:artifact_version",
      { text: "Ana saved version 3", data: { artifact: "a1", version: 3 } },
      {
        fetch: serving(
          {
            ...artifact({
              title: "Rollout plan",
              kind: "markdown",
              versions: 3,
            }),
            ...made,
            history: made.history.map((each) =>
              each.number === 3
                ? { ...each, author: "user:ana", by: "Ana", note }
                : each,
            ),
          },
          [],
        ),
      },
    );

    await drawn(() => page.textContent.includes("Rollout plan"));

    expect(page.textContent).toContain(
      `Ana ${note} as version 3 of Rollout plan`,
    );

    page.remove();
  }
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
    "Save as template…",
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

test("opening an artifact marks it opened once, not on the reloads after other changes", async () => {
  const asked: string[] = [];

  renderPart(
    web,
    "overlay",
    {},
    {
      hash: "#session-1?artifact=a1",
      fetch: async (url) => {
        await Promise.resolve();
        asked.push(url);

        return url.endsWith("/comments")
          ? Response.json({ comments: [] })
          : Response.json({ ...artifact({}), ...viewed(1) });
      },
    },
  );

  const reads = () => asked.filter((url) => /\/artifacts\/a1(\?|$)/.test(url));

  await act(async () => until(() => reads().length === 1));

  act(() => {
    changed("artifacts.artifacts");
  });

  await act(async () => until(() => reads().length === 2));

  expect(reads()).toEqual([
    "/api/ext/artifacts/artifacts/a1?opened=1",
    "/api/ext/artifacts/artifacts/a1",
  ]);
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
    type: o.kind ?? "html",
    template: null,
    sessionId: "session-1",
    sessionTitle: "Why did checkout slow down?",
    owner: "Ana",
    yours: true,
    audience: "you",
    sharedWith: [],
    openComments: 0,
    versions: 1,
    living: false,
    named: o.versions ?? 1,
    updatedAt: 0,
    openedAt: null,
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
      label: null,
    })),
    access: "steer",
    ownSession: false,
    shares: [],
    pinned: false,
    doc: null,
  };
}

const slots = { page: web.pages?.find(({ path }) => path === "")?.Page };

test("the team's workspace has an Artifacts page with only the team's artifacts", async () => {
  const asked: string[] = [];
  const hub = web.pages?.find(({ area }) => area === "hub");

  const team = { page: hub?.Page };

  expect(hub?.label).toBe("Artifacts");

  const page = renderPart(
    { ...web, slots: team },
    "page",
    { path: "" },
    {
      hash: "#team/plugin/artifacts/team-artifacts",
      fetch: async (url) => {
        await Promise.resolve();

        asked.push(url);

        return Response.json({
          artifacts: [
            artifact({ id: "a1", title: "Checkout latency" }),
            artifact({ id: "a2", title: "Bo's plan", yours: false }),
            artifact({ id: "a3", title: "Rollout", audience: "team" }),
          ],
        });
      },
    },
  );

  await act(async () => until(() => asked.length === 1));

  expect(
    [...page.querySelectorAll("[aria-label=Artifacts] li h2")].map(
      (each) => each.textContent,
    ),
  ).toEqual(["Rollout"]);

  expect(page.querySelector("[aria-label=Show]")).toBeNull();
});

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

  const { IntersectionObserver: watcher } = globalThis;

  // Every card is in view, once the list loads.
  globalThis.IntersectionObserver = class {
    readonly seen: (entries: { isIntersecting: boolean }[]) => void;

    constructor(seen: (entries: { isIntersecting: boolean }[]) => void) {
      this.seen = seen;
    }

    observe(): void {
      this.seen([{ isIntersecting: true }]);
    }

    disconnect(): void {
      // Nothing to stop.
    }
  } as unknown as typeof IntersectionObserver;

  await act(async () => until(() => asked.length === 1));

  const titles = (): string[] =>
    [...page.querySelectorAll("[aria-label=Artifacts] li h2")].map(
      (each) => each.textContent,
    );

  expect(titles()).toEqual(["Checkout latency", "Billing flow"]);
  expect(page.textContent).toContain("Page · v1 · shared with 2");
  expect(page.textContent).toContain("Page · v1 · only you");
  expect(page.querySelector("[title='2 open comments']")).not.toBeNull();

  // A card's first screen runs the page's scripts, and nothing that pops
  // over the gallery.
  await drawn(
    () => page.querySelectorAll("[aria-label=Artifacts] iframe").length > 0,
  );

  const sandboxes = [
    ...page.querySelectorAll("[aria-label=Artifacts] iframe"),
  ].map((each) => each.getAttribute("sandbox"));

  globalThis.IntersectionObserver = watcher;

  expect(sandboxes).toEqual(["allow-scripts", "allow-scripts"]);

  const show = (label: string): void => {
    act(() => {
      [...page.querySelectorAll<HTMLButtonElement>("[aria-label=Show] button")]
        .find((each) => each.textContent === label)
        ?.click();
    });
  };

  show("Shared with me 1");
  expect(titles()).toEqual(["Bo's plan"]);
  expect(page.textContent).toContain("from Bo");
  show("Team 1");
  expect(titles()).toEqual(["Rollout"]);
  show("Mine 2");

  const toggleCommented = (): void => {
    act(() => {
      [...page.querySelectorAll<HTMLButtonElement>("button")]
        .find((each) => each.textContent === "Open comments")
        ?.click();
    });
  };

  toggleCommented();
  expect(titles()).toEqual(["Checkout latency"]);
  toggleCommented();

  const choose = (label: string, value: string): void => {
    const select = page.querySelector<HTMLSelectElement>(
      `select[aria-label=${label}]`,
    );

    act(() => {
      if (select !== null) {
        select.value = value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
  };

  choose("Kind", "markdown");
  expect(page.textContent).toContain("Nothing matches.");
  choose("Kind", "");

  const search = page.querySelector<HTMLInputElement>("input[type=search]");

  act(() => {
    if (search !== null) {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set?.call(search, "draw the");

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

test("the gallery puts the ones the person opened last first, or the latest changed when asked", async () => {
  const page = renderPart(
    { ...web, slots },
    "page",
    { path: "" },
    {
      hash: "#plugin/artifacts",
      fetch: async () => {
        await Promise.resolve();

        return Response.json({
          artifacts: [
            artifact({ id: "a1", title: "Changed last", updatedAt: 30 }),
            artifact({ id: "a2", title: "Never opened", updatedAt: 20 }),
            artifact({
              id: "a3",
              title: "Opened last",
              updatedAt: 5,
              openedAt: 100,
            }),
            artifact({
              id: "a4",
              title: "Opened before",
              updatedAt: 10,
              openedAt: 50,
            }),
          ],
        });
      },
    },
  );

  const titles = (): string[] =>
    [...page.querySelectorAll("[aria-label=Artifacts] li h2")].map(
      (each) => each.textContent,
    );

  await drawn(() => titles().length === 4);

  expect(titles()).toEqual([
    "Opened last",
    "Opened before",
    "Changed last",
    "Never opened",
  ]);

  const order = page.querySelector<HTMLSelectElement>(
    "select[aria-label=Order]",
  );

  act(() => {
    if (order !== null) {
      order.value = "changed";
      order.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });

  expect(titles()).toEqual([
    "Changed last",
    "Never opened",
    "Opened before",
    "Opened last",
  ]);
});

test("a Project's artifacts are the ones its Sessions published, with no shelves", async () => {
  const asked: string[] = [];

  let published = [
    artifact({ id: "a1", title: "Checkout latency" }),
    artifact({ id: "a2", title: "Rollout", audience: "team" }),
    artifact({ id: "a3", title: "Bo's plan", yours: false, owner: "Bo" }),
  ];

  const page = renderPart(
    web,
    "project.artifacts",
    { sessions: ["s1", "s2"] },
    {
      fetch: async (url) => {
        await Promise.resolve();
        asked.push(url);

        return Response.json({ artifacts: published });
      },
    },
  );

  await drawn(() => page.textContent.includes("Checkout latency"));

  expect(asked).toEqual(["/api/ext/artifacts/artifacts?sessions=s1%2Cs2"]);

  expect(
    [...page.querySelectorAll("[aria-label=Artifacts] li h2")].map(
      (each) => each.textContent,
    ),
  ).toEqual(["Checkout latency", "Rollout", "Bo's plan"]);

  expect(page.querySelector("[aria-label=Search]")).not.toBeNull();
  expect(page.querySelector("[aria-label=Show]")).toBeNull();

  // With nothing published, it says how the first one gets there.
  published = [];

  act(() => {
    changed("artifacts.artifacts");
  });

  await drawn(() => page.textContent.includes("Nothing published"));

  expect(page.textContent).toContain(
    "Nothing published yet. Ask Pi to publish a page, or open a file in the folder and choose Publish as artifact.",
  );

  expect(page.querySelector("[aria-label=Search]")).toBeNull();
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

interface SharesPut {
  readonly url: string;
  readonly method: string;
  readonly body: { readonly shares: readonly { name: string; role: string }[] };
}

const onServer = [
  { id: "ana", name: "Ana", here: true },
  { id: "robin", name: "Robin" },
  { id: "rob", name: "Rob" },
  { id: "bo", name: "Bo" },
  { id: "bob", name: "Bob Lee", here: true },
  { id: "clea", name: "Clea" },
  { id: "cy", name: "Cy" },
];

// The artifact page with its Share dialog open, over a fake server that
// keeps the shares it's sent. A refused save answers 400 with the reason,
// and held saves wait until let() answers the oldest.
async function sharing({
  shown = {},
  shares: first = [],
  path = "a1",
  peopleFail = false,
  refuse = () => undefined,
  held = false,
}: {
  readonly shown?: Partial<ArtifactSummary>;
  readonly shares?: readonly { userId: string; name: string; role: string }[];
  readonly path?: string;
  readonly peopleFail?: boolean;
  readonly refuse?: (put: SharesPut, index: number) => string | undefined;
  readonly held?: boolean;
} = {}) {
  const puts: SharesPut[] = [];
  const waiting: (() => void)[] = [];
  const copied: string[] = [];
  let shares = first;
  let loads = 0;

  const page = renderPart(
    { ...web, slots },
    "page",
    { path },
    {
      fetch: async (url, init) => {
        await Promise.resolve();

        if (url === "/api/people") {
          return peopleFail
            ? Response.json({ error: "down", message: "down" }, { status: 500 })
            : Response.json(onServer);
        }

        if (url.endsWith("/presence") || url.endsWith("/people")) {
          return Response.json({ people: [] });
        }

        if (url.endsWith("/comments")) {
          return Response.json({ comments: [] });
        }

        if (url.endsWith("/shares")) {
          const put: SharesPut = {
            url,
            method: init?.method ?? "GET",
            body: JSON.parse(init?.body as string) as SharesPut["body"],
          };

          const index = puts.push(put) - 1;

          if (held) {
            await new Promise<void>((resolve) => {
              waiting.push(resolve);
            });
          }

          const refused = refuse(put, index);

          if (refused !== undefined) {
            return Response.json(
              { error: "bad_request", message: refused },
              { status: 400 },
            );
          }

          shares = put.body.shares.map((each) => ({
            ...each,
            userId: onServer.find(({ name }) => name === each.name)?.id ?? "",
          }));

          return Response.json({ shares });
        }

        loads += 1;

        return Response.json({
          ...artifact({ versions: 2, ...shown }),
          ...viewed(2),
          shares,
        });
      },
    },
  );

  const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");

  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        await Promise.resolve();
        copied.push(text);
      },
    },
  });

  const dialog = (): HTMLDialogElement =>
    page.querySelector("dialog") ?? document.createElement("dialog");

  const search = (): HTMLInputElement =>
    dialog().querySelector("input[role=combobox]") ??
    document.createElement("input");

  const shown_ = (element: Element): string =>
    [...(element.children[1]?.children ?? [])]
      .map((each) => each.textContent)
      .join(" · ");

  const open = async (): Promise<void> => {
    await drawn(() =>
      buttons(page).some((each) => each.textContent === "Share"),
    );

    act(() => {
      buttons(page)
        .find((each) => each.textContent === "Share")
        ?.click();
    });

    await drawn(() => dialog().open);
  };

  await open();

  return {
    page,
    puts,
    copied,
    dialog,
    // Someone else changes who has it, and the page hears about it.
    elsewhere: async (
      next: readonly { userId: string; name: string; role: string }[],
    ) => {
      shares = next;
      const before = loads;

      await act(async () => {
        changed("artifacts.artifacts");
        await until(() => loads > before);
      });
    },
    search,
    open,
    let: async () => {
      await act(async () => {
        waiting.shift()?.();
        await until(() => waiting.length > 0 || puts.length > 0);
      });
    },
    restore: () => {
      if (clipboard === undefined) {
        Reflect.deleteProperty(navigator, "clipboard");
      } else {
        Object.defineProperty(navigator, "clipboard", clipboard);
      }
    },
    listed: () => [...dialog().querySelectorAll("[role=option]")].map(shown_),
    rows: () =>
      [...dialog().querySelectorAll("ul[aria-labelledby] li")].map((row) => {
        const role = row.querySelector("select")?.value;

        return role === undefined ? shown_(row) : `${shown_(row)} (${role})`;
      }),
    note: () => dialog().querySelector("p:has(svg)")?.textContent ?? "",
    button: (label: string) =>
      buttons(dialog()).find((each) => each.textContent === label),
    type: (text: string) => {
      act(() => {
        search().focus();
        Reflect.set(HTMLInputElement.prototype, "value", text, search());
        search().dispatchEvent(new Event("input", { bubbles: true }));
      });
    },
    press: (key: string) => {
      act(() => {
        search().dispatchEvent(
          new KeyboardEvent("keydown", { key, bubbles: true }),
        );
      });
    },
    choose: (label: string, value: string) => {
      act(() => {
        const select = dialog().querySelector<HTMLSelectElement>(
          `select[aria-label='${label}']`,
        );

        if (select !== null) {
          Reflect.set(HTMLSelectElement.prototype, "value", value, select);
          select.dispatchEvent(new Event("change", { bubbles: true }));
        }
      });
    },
  };
}

test("sharing picks people on the server, gives each a role, and copies a link to the latest or one version", async () => {
  const share = await sharing({ path: "a1/v/1" });

  try {
    const { dialog, search, listed, rows, note, button, type, press } = share;

    expect(dialog().querySelector("h2")?.textContent).toBe("Share “Report”");
    expect(rows()).toEqual(["Ana (you) · The Session is yours"]);
    expect(document.activeElement).toBe(search());

    expect(note()).toBe(
      "Only you can send threads to Pi, with Send to Pi in the comments or by writing @pi. Every viewer signs in to Pipoca; there are no public links.",
    );

    // Names starting with what's typed first, then a word that does, then
    // the rest. The viewer isn't offered.
    type("b");
    await drawn(() => listed().length > 0);

    expect(listed()).toEqual(["Bo", "Bob Lee · Online now", "Robin", "Rob"]);
    expect(dialog().textContent).toContain("People on this Pipoca server");
    expect(dialog().textContent).toContain("an admin invites them first");
    expect(button("Add")?.disabled).toBe(true);

    type(" bo ");

    expect(listed()).toEqual(["Bo", "Bob Lee · Online now"]);
    expect(button("Add")?.disabled).toBe(false);

    type("le");

    expect(listed()).toEqual(["Bob Lee · Online now", "Clea"]);
    expect(button("Add")?.disabled).toBe(true);

    type("Zed");

    expect(listed()).toEqual([]);
    expect(search().getAttribute("aria-expanded")).toBe("false");

    expect(dialog().textContent).toContain(
      "No one called “Zed” signs in here.",
    );

    expect(button("Add")?.disabled).toBe(true);

    // Arrows move and wrap; Escape closes only the list, and an arrow opens
    // it again.
    type("b");

    const active = (): string | undefined =>
      [...dialog().querySelectorAll("[role=option]")].find(
        (each) => each.id === search().getAttribute("aria-activedescendant"),
      )?.children[1]?.children[0]?.textContent;

    expect(active()).toBe("Bo");
    press("ArrowUp");
    expect(active()).toBe("Rob");

    expect(
      dialog().querySelector("[aria-selected=true]")?.children[1]?.textContent,
    ).toBe("Rob");

    press("ArrowDown");
    press("ArrowDown");
    expect(active()).toBe("Bob Lee");
    press("Escape");

    expect(listed()).toEqual([]);
    expect(dialog().open).toBe(true);

    press("ArrowDown");
    expect(active()).toBe("Bo");
    press("ArrowDown");
    press("Enter");

    expect(search().value).toBe("Bob Lee");
    expect(listed()).toEqual([]);

    // Add saves at once, with the role picked for new people.
    await act(async () => {
      button("Add")?.click();
      await until(() => share.puts.length === 1);
    });

    expect(share.puts).toEqual([
      {
        url: "/api/ext/artifacts/artifacts/a1/shares",
        method: "PUT",
        body: { shares: [{ name: "Bob Lee", role: "comment" }] },
      },
    ]);

    await drawn(() => rows().length === 2);
    expect(search().value).toBe("");
    expect(rows()[1]).toBe("Bob Lee (comment)");
    expect(note()).toStartWith("Comments from Bob Lee stay between people.");

    // People already named aren't offered again. Typed in any case, a whole
    // name can be added too.
    type("b");
    expect(listed()).toEqual(["Bo", "Robin", "Rob"]);

    act(() => {
      dialog()
        .querySelector("[role=option]")
        ?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });

    expect(search().value).toBe("Bo");
    share.choose("Role for new people", "view");

    await act(async () => {
      button("Add")?.click();
      await until(() => share.puts.length === 2);
    });

    expect(share.puts[1]?.body).toEqual({
      shares: [
        { name: "Bob Lee", role: "comment" },
        { name: "Bo", role: "view" },
      ],
    });

    await drawn(() => rows().length === 3);
    expect(note()).toStartWith("Comments from Bob Lee stay between people.");

    // Each person's role changes on its own.
    await act(async () => {
      share.choose("Role for Bo", "comment");
      await until(() => share.puts.length === 3);
    });

    expect(share.puts[2]?.body).toEqual({
      shares: [
        { name: "Bob Lee", role: "comment" },
        { name: "Bo", role: "comment" },
      ],
    });

    await drawn(() =>
      note().startsWith("Comments from Bob Lee and Bo stay between people."),
    );

    await act(async () => {
      share.choose("Role for Bob Lee", "view");
      await until(() => share.puts.length === 4);
    });

    expect(share.puts[3]?.body).toEqual({
      shares: [
        { name: "Bob Lee", role: "view" },
        { name: "Bo", role: "comment" },
      ],
    });

    // Removing someone saves at once and leaves focus in the search.
    await act(async () => {
      const remove = dialog().querySelector<HTMLButtonElement>(
        "[aria-label='Remove Bo']",
      );

      remove?.focus();
      remove?.click();

      await until(() => share.puts.length === 5);
    });

    expect(share.puts[4]?.body).toEqual({
      shares: [{ name: "Bob Lee", role: "view" }],
    });

    await drawn(() => rows().length === 2);
    expect(document.activeElement).toBe(search());

    await drawn(() =>
      note().startsWith(
        "People you add can read it and can't send threads to Pi.",
      ),
    );

    // The link opens the latest version, or only the one shown.
    const origin = `${location.origin}${location.pathname}`;

    await act(async () => {
      button("Copy link")?.click();
      await until(() => share.copied.length === 1);
    });

    expect(share.copied).toEqual([`${origin}#plugin/artifacts/a1`]);
    await drawn(() => button("Copied") !== undefined);

    act(() => {
      button("Version 1 only")?.click();
    });

    await act(async () => {
      button("Copied")?.click();
      await until(() => share.copied.length === 2);
    });

    expect(share.copied[1]).toBe(`${origin}#plugin/artifacts/a1/v/1`);

    // Done closes, and the dialog opens again on what was saved.
    act(() => {
      button("Done")?.click();
    });

    await drawn(() => !dialog().open);
    await share.open();
    await drawn(() => rows().length === 2);
    expect(rows()[1]).toBe("Bob Lee (view)");
  } finally {
    share.restore();
  }
});

test("a refused save says why and keeps what was typed, and quick changes save in order", async () => {
  const share = await sharing({
    shares: [
      { userId: "bo", name: "Bo", role: "view" },
      { userId: "bob", name: "Bob Lee", role: "view" },
    ],
    held: true,
    refuse: ({ body }, index) =>
      index === 0 || body.shares.some(({ name }) => name === "Rob")
        ? "no one is called Rob"
        : undefined,
  });

  try {
    const { dialog, search, rows, button, type, press } = share;

    // A second change waits for the first. The first one failing after
    // the second was made doesn't undo it.
    act(() => {
      share.choose("Role for Bo", "comment");
    });

    act(() => {
      share.choose("Role for Bob Lee", "comment");
    });

    expect(rows().slice(1)).toEqual(["Bo (comment)", "Bob Lee (comment)"]);
    await act(async () => until(() => share.puts.length === 1));
    expect(share.puts).toHaveLength(1);

    await share.let();
    await act(async () => until(() => share.puts.length === 2));

    expect(share.puts[1]?.body).toEqual({
      shares: [
        { name: "Bo", role: "comment" },
        { name: "Bob Lee", role: "comment" },
      ],
    });

    expect(dialog().textContent).not.toContain("Couldn't save");

    // Done waits for the save, and Share opens again on it before the
    // artifact reloads.
    act(() => {
      button("Done")?.click();
    });

    await act(async () => Promise.resolve());
    expect(dialog().open).toBe(true);
    // A reload while it saves doesn't replace what's being saved.
    await share.elsewhere([]);
    await share.let();
    await drawn(() => !dialog().open);
    await share.open();
    expect(rows().slice(1)).toEqual(["Bo (comment)", "Bob Lee (comment)"]);

    // The newest save refused puts back what was saved, and says why.
    type("rob");
    await drawn(() => share.listed().length > 0);
    press("Enter");

    act(() => {
      button("Add")?.click();
    });

    expect(search().value).toBe("");
    expect(rows()).toHaveLength(4);
    await act(async () => until(() => share.puts.length === 3));

    // Done waiting on it stays open for the refusal, so it isn't missed.
    act(() => {
      button("Done")?.click();
    });

    await share.let();

    await drawn(() =>
      dialog().textContent.includes(
        "Couldn't save who has access: no one is called Rob",
      ),
    );

    expect(dialog().open).toBe(true);
    expect(search().value).toBe("Rob");
    expect(rows().slice(1)).toEqual(["Bo (comment)", "Bob Lee (comment)"]);

    // Asked again, it closes, and opens without the old refusal.
    act(() => {
      button("Done")?.click();
    });

    await drawn(() => !dialog().open);
    await share.open();
    expect(dialog().textContent).not.toContain("Couldn't save");

    // The next change clears it.
    act(() => {
      share.choose("Role for Bo", "view");
    });

    expect(dialog().textContent).not.toContain("Couldn't save");
    await act(async () => until(() => share.puts.length === 4));
    await share.let();
    await drawn(() => rows()[1] === "Bo (view)");
  } finally {
    share.restore();
  }
});

test("sharing someone else's artifact starts from who has it and never offers the owner or the viewer", async () => {
  const share = await sharing({
    shown: { owner: "Cy", yours: false },
    shares: [{ userId: "bo", name: "Bo", role: "view" }],
  });

  try {
    const { rows, listed, type, button } = share;

    expect(rows()).toEqual(["Cy", "Bo (view)"]);

    type("b");
    await drawn(() => listed().length > 0);
    expect(listed()).toEqual(["Bob Lee · Online now", "Robin", "Rob"]);

    type("cy");
    expect(listed()).toEqual([]);
    type("ana");
    expect(listed()).toEqual([]);

    type("bob lee");

    await act(async () => {
      button("Add")?.click();
      await until(() => share.puts.length === 1);
    });

    expect(share.puts[0]?.body).toEqual({
      shares: [
        { name: "Bo", role: "view" },
        { name: "Bob Lee", role: "comment" },
      ],
    });
  } finally {
    share.restore();
  }
});

test("Share opens again on changes made elsewhere, and says when no one can send to Pi", async () => {
  const share = await sharing({
    shown: { sessionId: null },
    refuse: ({ body }) =>
      body.shares.some(({ role }) => role === "comment")
        ? "comments are off"
        : undefined,
  });

  try {
    expect(share.note()).toBe(
      "No one can send its threads to Pi, because it has no Session. Every viewer signs in to Pipoca; there are no public links.",
    );

    act(() => {
      share.button("Done")?.click();
    });

    await drawn(() => !share.dialog().open);
    await share.elsewhere([{ userId: "cy", name: "Cy", role: "view" }]);
    await share.open();

    expect(share.rows()).toEqual(["Ana (you)", "Cy (view)"]);

    // A refusal goes back to that list too.
    await act(async () => {
      share.choose("Role for Cy", "comment");
      await until(() => share.puts.length === 1);
    });

    await drawn(() => share.dialog().textContent.includes("comments are off"));
    expect(share.rows()).toEqual(["Ana (you)", "Cy (view)"]);
  } finally {
    share.restore();
  }
});

test("when the people on the server don't load, the search says so instead of finding no one", async () => {
  const share = await sharing({ peopleFail: true });

  try {
    share.type("bo");

    await drawn(() =>
      share
        .dialog()
        .textContent.includes("The people on this server didn't load."),
    );

    expect(share.rows()).toEqual(["Ana (you) · The Session is yours"]);
    expect(share.button("Add")?.disabled).toBe(true);
  } finally {
    share.restore();
  }
});

test("a team artifact opens for the whole team, so its link is all there is to share", async () => {
  const share = await sharing({
    shown: { audience: "team", owner: "Team", yours: false },
  });

  try {
    const { dialog, note, button } = share;

    expect(dialog().querySelector("input[role=combobox]")).toBeNull();
    expect(dialog().textContent).toContain("Everyone on the team opens it");

    expect(note()).toBe(
      "Every viewer signs in to Pipoca; there are no public links.",
    );

    await act(async () => {
      button("Copy link")?.click();
      await until(() => share.copied.length === 1);
    });

    expect(share.copied).toEqual([
      `${location.origin}${location.pathname}#plugin/artifacts/a1`,
    ]);
  } finally {
    share.restore();
  }
});

function frameOf(page: HTMLElement): {
  readonly tell: (data: object) => void;
  readonly told: () => readonly {
    pipoca?: string;
    pins?: unknown;
    lines?: unknown;
    on?: boolean;
    section?: number;
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
    file: "",
    body: "A comment",
    sentBy: null,
    resolved: false,
    resolvedByPi: false,
    createdAt: Date.now(),
    reactions: [],
    suggestion: null,
    deletable: false,
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
    // A thread carries over to newer versions: its element, or its text.
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
        {
          n: 6,
          quote: "Header",
          selector: "body > h1:nth-of-type(1)",
          active: false,
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

  // Nothing it says after that, such as a stop, can bring it back.
  typeInto(box(), "Late");

  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  expect(told(beats).at(-1)).toEqual(gone);
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

test("people delete what they may after saying yes, and a thread Pi started shows as Pi's", async () => {
  const asked: Served[] = [];

  let comments = [
    thread({ id: "t1", author: "Ana", byPi: true, body: "Is Friday firm?" }),
    thread({
      id: "t2",
      parent: "t1",
      author: "You",
      body: "Yes",
      deletable: true,
    }),
    thread({ id: "t3", parent: "t1", author: "Bo", body: "No" }),
  ];

  const page = renderPart(
    web,
    "overlay",
    {},
    {
      hash: "#session-1?artifact=a1&comments=1",
      fetch: async (url, init) => {
        if (init?.method === "DELETE") {
          comments = comments.filter(({ id }) => !url.endsWith(`/${id}`));
        }

        return serving(
          { ...artifact({ versions: 2 }), ...viewed(2), askable: true },
          asked,
          { comments: () => comments },
        )(url, init);
      },
    },
  );

  await opened(asked);
  await drawn(() => named(page, "Comment 1 by Pi") !== undefined);

  expect(named(page, "Send to Pi")).toBeUndefined();

  act(() => {
    named(page, "Comment 1 by Pi")?.click();
  });

  expect(page.textContent).toContain(
    "Pi started this thread: replies wake it until it's resolved.",
  );

  expect(
    buttons(page)
      .map((each) => each.getAttribute("aria-label"))
      .filter((label) => label?.startsWith("More for") === true),
  ).toEqual(["More for this reply"]);

  act(() => {
    named(page, "More for this reply")?.click();
  });

  act(() => {
    item(page, "Delete reply")?.click();
  });

  await drawn(() => page.querySelector("dialog[open]") !== null);

  act(() => {
    asking(page, "Delete this reply?", "Cancel");
  });

  await act(async () => Promise.resolve());
  expect(asked.some(({ method }) => method === "DELETE")).toBe(false);

  act(() => {
    named(page, "More for this reply")?.click();
  });

  act(() => {
    item(page, "Delete reply")?.click();
  });

  await drawn(() => page.querySelector("dialog[open]") !== null);

  act(() => {
    asking(page, "Delete this reply?", "Delete");
  });

  await drawn(() => !page.textContent.includes("Yes"));

  expect(asked.filter(({ method }) => method === "DELETE")).toEqual([
    { url: "/api/ext/artifacts/artifacts/a1/comments/t2", method: "DELETE" },
  ]);

  expect(page.querySelector("[role=status]")?.textContent).toBe(
    "Reply deleted",
  );
});

test("Pi's suggested edit shows what goes and what comes, and someone who steers accepts it as the next version or rejects it", async () => {
  for (const [button, accept, caption] of [
    ["Accept", true, "Accepted by You as version 6"],
    ["Reject", false, "Rejected by You"],
  ] as const) {
    await decided(button, accept, caption);
  }
});

async function decided(
  button: string,
  accept: boolean,
  caption: string,
): Promise<void> {
  const asked: Served[] = [];

  const edit = {
    find: "A sender retries with exponential backoff for 24 hours",
    replace: "A sender retries with exponential backoff for 12 hours",
    version: 5,
    by: null,
    saved: null,
  };

  let state: "open" | "accepted" | "rejected" = "open";

  const comments = () => [
    thread({ id: "t1", body: "@pi propose a shorter window", sentBy: "You" }),
    thread({
      id: "t2",
      parent: "t1",
      author: "You",
      byPi: true,
      body: "12 hours covers the March outage.",
      suggestion:
        state === "open"
          ? { ...edit, state }
          : { ...edit, state, by: "You", saved: accept ? 6 : null },
    }),
  ];

  const serve = serving({ ...artifact({ versions: 5 }), ...viewed(5) }, asked, {
    comments,
  });

  const page = renderPart(
    web,
    "overlay",
    {},
    {
      hash: "#session-1?artifact=a1&comments=1",
      fetch: async (url, init) => {
        if (url.endsWith("/suggestion")) {
          asked.push({
            url,
            method: init?.method ?? "GET",
            body: JSON.parse(
              typeof init?.body === "string" ? init.body : "null",
            ) as unknown,
          });

          state = accept ? "accepted" : "rejected";
          changed("artifacts.artifacts");

          return Response.json({ version: 6 });
        }

        return serve(url, init);
      },
    },
  );

  await opened(asked);
  await drawn(() => named(page, "Comment 1 by Ana") !== undefined);

  act(() => {
    named(page, "Comment 1 by Ana")?.click();
  });

  const figure = (): HTMLElement | null =>
    page.querySelector("figure[aria-label='Suggested edit']");

  await drawn(() => figure() !== null);

  expect(figure()?.querySelector("del")?.textContent).toBe(
    `Takes out: ${edit.find}`,
  );

  expect(figure()?.querySelector("ins")?.textContent).toBe(
    `Puts in: ${edit.replace}`,
  );

  expect(figure()?.querySelector("figcaption")?.textContent).toContain(
    "Accepting saves version 6",
  );

  act(() => {
    named(page, button)?.click();
  });

  await drawn(
    () => figure()?.querySelector("figcaption")?.textContent === caption,
  );

  expect(asked.find(({ url }) => url.endsWith("/suggestion"))).toMatchObject({
    url: "/api/ext/artifacts/artifacts/a1/comments/t2/suggestion",
    method: "PUT",
    body: { accept },
  });

  expect(named(page, "Reject")).toBeUndefined();
  page.remove();
}

test("people who can't steer see Pi's suggested edit wait for someone who can", async () => {
  const asked: Served[] = [];

  const page = renderPart(
    web,
    "overlay",
    {},
    {
      hash: "#session-1?artifact=a1&comments=1",
      fetch: serving(
        { ...artifact({ versions: 2 }), ...viewed(2), access: "comment" },
        asked,
        {
          comments: () => [
            thread({ id: "t1", body: "Shorter?", sentBy: "Ana" }),
            thread({
              id: "t2",
              parent: "t1",
              byPi: true,
              body: "",
              suggestion: {
                find: "24 hours",
                replace: "12 hours",
                version: 2,
                state: "open",
                by: null,
                saved: null,
              },
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

  await drawn(
    () => page.querySelector("figure[aria-label='Suggested edit']") !== null,
  );

  expect(named(page, "Accept")).toBeUndefined();

  expect(
    page.querySelector("figure[aria-label='Suggested edit'] figcaption")
      ?.textContent,
  ).toBe("Waiting for someone who steers the Session");

  // A suggestion with nothing to say draws no empty paragraph.
  const pi = [...page.querySelectorAll("ol[aria-label=Messages] > li")].at(-1);

  expect(pi?.querySelector("p")).toBeNull();
});

test("Publish as artifact in the file viewer uploads the file's bytes, publishes it in its Session and opens the artifact instead", async () => {
  const asked: { url: string; method: string; body?: unknown }[] = [];

  const page = renderPart(
    web,
    "file.actions",
    {
      session: "session-1",
      file: "joined-latency.csv",
      download:
        "/api/ext/files/sessions/session-1/files/outputs?path=joined-latency.csv",
    },
    {
      hash: "#session-1?session=session-1&file=outputs%2Fjoined-latency.csv",
      fetch: async (url, init) => {
        await Promise.resolve();

        const method = init?.method ?? "GET";

        asked.push({
          url,
          method,
          ...(typeof init?.body === "string" && {
            body: JSON.parse(init.body) as unknown,
          }),
        });

        if (url.includes("/api/ext/files/")) {
          return new Response("day,ms\n");
        }

        if (url.includes("/finish")) {
          return Response.json({ hash: "b".repeat(64) });
        }

        if (url.includes("_blobs/browser/")) {
          return Response.json({ offset: 7 });
        }

        return Response.json({
          id: "a9",
          title: "joined-latency.csv",
          version: 1,
          kind: "csv",
        });
      },
    },
  );

  const button = page.querySelector("button");
  const entries = history.length;

  expect(button?.textContent).toBe("Publish as artifact");

  await act(async () => {
    button?.click();
    await until(() => location.hash.includes("artifact=a9"));
  });

  // The artifact takes the file's place, so Back doesn't reopen the file.
  expect(history.length).toBe(entries);

  expect(
    asked.filter(({ url }) => url.endsWith("/api/ext/artifacts/artifacts")),
  ).toEqual([
    {
      url: "/api/ext/artifacts/artifacts",
      method: "POST",
      body: {
        session: "session-1",
        name: "joined-latency.csv",
        hash: "b".repeat(64),
      },
    },
  ]);

  expect(location.hash).toBe("#session-1?artifact=a9");
});

test("Publish names the artifact by the file's own name, and says when the file didn't download", async () => {
  const asked: string[] = [];

  const page = renderPart(
    web,
    "file.actions",
    {
      session: "session-1",
      file: "data/joined.csv",
      download: "/api/ext/files/x",
    },
    {
      fetch: async (url, init) => {
        await Promise.resolve();
        asked.push(`${init?.method ?? "GET"} ${url}`);

        return new Response("gone", { status: 404 });
      },
    },
  );

  act(() => {
    page.querySelector("button")?.click();
  });

  await drawn(() => page.textContent.includes("didn't download"));

  expect(page.textContent).toContain("joined.csv didn't download (404).");
  expect(asked).toEqual(["GET /api/ext/files/x"]);
});

test("a file that can't be an artifact, such as a spreadsheet, offers no Publish", () => {
  const page = renderPart(web, "file.actions", {
    session: "session-1",
    file: "book.xlsx",
    download: "/x",
  });

  expect(page.querySelector("button")).toBeNull();
});

test("the Files menu lists the Session's artifacts first, and one opens over the page", async () => {
  const asked: string[] = [];

  renderPart(
    web,
    "session.panel",
    { session: sessionWith({}) },
    {
      hash: "#session-1",
      fetch: async (url) => {
        await Promise.resolve();
        asked.push(url);

        return Response.json({
          artifacts: [
            artifact({ id: "a1", title: "Checkout latency", versions: 4 }),
          ],
        });
      },
    },
  );

  await drawn(() => document.querySelector("[aria-label='Files, 1']") !== null);

  expect(asked).toEqual(["/api/ext/artifacts/artifacts?sessions=session-1"]);

  act(() => {
    document
      .querySelector<HTMLButtonElement>("[aria-label='Files, 1']")
      ?.click();
  });

  const row = document.querySelector<HTMLButtonElement>(
    "section[aria-label=Artifacts] button",
  );

  expect(row?.textContent).toBe("Checkout latencyv4");

  const filter = document.querySelector<HTMLInputElement>(
    "input[aria-label='Filter files']",
  );

  const typed = (text: string): void => {
    act(() => {
      if (filter !== null) {
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )?.set?.call(filter, text);

        filter.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
  };

  typed("plan");

  expect(
    document.querySelectorAll("section[aria-label=Artifacts] button"),
  ).toHaveLength(0);

  typed("latency");

  act(() => {
    document
      .querySelector<HTMLButtonElement>("section[aria-label=Artifacts] button")
      ?.click();
  });

  expect(location.hash).toBe("#session-1?artifact=a1");
});

test("the + menu attaches an artifact as text that names its id and version for Pi", async () => {
  const Fill = web.slots?.["session.attach"];
  const added: unknown[] = [];
  const asked: string[] = [];

  const attachSlots = {
    attach: () =>
      Fill === undefined ? null : (
        <AttachMenu label="Attach files" onFiles={() => undefined}>
          <Fill
            session={sessionWith({})}
            add={(attachment) => {
              added.push(attachment);
            }}
          />
        </AttachMenu>
      ),
  };

  renderPart(
    { ...web, slots: attachSlots },
    "attach",
    {},
    {
      fetch: async (url) => {
        await Promise.resolve();
        asked.push(url);

        return Response.json({
          artifacts: [
            artifact({
              id: "a1",
              title: "Checkout latency",
              versions: 4,
              sessionId: "session-2",
              sessionTitle: "Why did checkout slow down?",
            }),
            artifact({ id: "a2", title: "Rollout plan" }),
          ],
        });
      },
    },
  );

  act(() => {
    document
      .querySelector<HTMLButtonElement>("button[aria-label='Attach files']")
      ?.click();
  });

  act(() => {
    [...document.querySelectorAll<HTMLButtonElement>("[role=group] button")]
      .find((each) => each.textContent === "An artifact…")
      ?.click();
  });

  const row = (): HTMLButtonElement | undefined =>
    document.querySelector<HTMLButtonElement>(
      "ul[aria-label='Attach an artifact'] button",
    ) ?? undefined;

  await drawn(() => row() !== undefined);

  // Only what this Session's Pi can read, saying which Session made it when
  // another did. The menu's design system row loads what's picked.
  expect(asked.filter((url) => !url.includes("/systems?"))).toEqual([
    "/api/ext/artifacts/artifacts?for=session-1",
  ]);

  expect(
    [
      ...document.querySelectorAll(
        "ul[aria-label='Attach an artifact'] button",
      ),
    ].map((each) => each.textContent),
  ).toEqual([
    "Checkout latencyPage · v4 · from Why did checkout slow down?",
    "Rollout planPage · v1",
  ]);

  act(() => {
    row()?.click();
  });

  expect(added).toEqual([
    {
      key: "artifact:a1",
      title: "Checkout latency",
      icon: "file-text",
      detail: "artifact · version 4",
      text: 'Attached: the artifact "Checkout latency" (a1), version 4. Read it with read_artifact.',
    },
  ]);

  // Focus goes back to the composer after the test's last click.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
});

// What a screen reader reads of it, word by word.
function readOut(element: Element): string {
  const copy = element.cloneNode(true) as Element;

  for (const hidden of copy.querySelectorAll("[aria-hidden=true]")) {
    hidden.remove();
  }

  return [...copy.childNodes]
    .map((each) => each.textContent?.trim() ?? "")
    .filter((each) => each !== "")
    .join(" ");
}

function designDoc(doc: object = {}) {
  return {
    ...artifact({ title: "Webhooks v2", owner: "Team", audience: "team" }),
    ...viewed(1),
    doc: {
      type: "design",
      status: "review",
      marked: "file",
      reviewers: [],
      ...doc,
    },
  };
}

const questions = [
  thread({
    id: "q1",
    version: 1,
    kind: "question",
    quote: "24 hours",
    body: "Too long?",
  }),
  thread({
    id: "q2",
    version: 1,
    kind: "question",
    body: "Per endpoint?",
    resolved: true,
  }),
  thread({ id: "c1", version: 1, quote: "in order", body: "Per merchant" }),
];

test("a design doc says so, shows its status and reviewers, and a reviewer approves or asks for changes", async () => {
  const asked: Served[] = [];

  const page = renderPart(
    web,
    "overlay",
    {},
    {
      hash: "#session-1?artifact=a1",
      fetch: serving(
        designDoc({
          reviewers: [
            { name: "Ana", you: false, verdict: "approved" },
            { name: "Rui", you: false, verdict: "changes" },
            { name: "Bo", you: true, verdict: null },
          ],
        }),
        asked,
        { comments: () => questions },
      ),
    },
  );

  await opened(asked);
  await drawn(() => page.textContent.includes("open question"));

  expect(page.querySelector("dialog[open] h2 + span")?.textContent).toStartWith(
    "Design doc · ",
  );

  expect(page.querySelector("[aria-label='Status: In review']")).not.toBeNull();

  const bar = page.querySelector<HTMLElement>("[aria-label=Review]");

  expect([...(bar?.querySelectorAll("li") ?? [])].map(readOut)).toEqual([
    "Ana Approved",
    "Rui Changes asked",
    "You Not yet",
  ]);

  expect(bar?.textContent).toContain("1 open question · 1 resolved");

  const approve = bar === null ? undefined : named(bar, "Approve");

  expect(approve?.getAttribute("aria-pressed")).toBe("false");

  act(() => {
    approve?.click();
  });

  await drawn(() => asked.some(({ method }) => method === "PUT"));

  expect(asked.filter(({ method }) => method === "PUT")).toEqual([
    {
      url: "/api/ext/artifacts/artifacts/a1/review",
      method: "PUT",
      body: { verdict: "approved" },
    },
  ]);

  // Someone who isn't reviewing gives no verdict.
  const other = renderPart(
    web,
    "overlay",
    {},
    {
      fetch: serving(
        {
          ...designDoc({
            reviewers: [{ name: "Ana", you: false, verdict: "approved" }],
          }),
          access: "comment",
        },
        [],
      ),
    },
  );

  await drawn(() => other.querySelector("[aria-label=Review]") !== null);
  expect(named(other, "Approve")).toBeUndefined();
  expect(named(other, "Add reviewer")).toBeUndefined();
  expect(named(other, "Take Ana off the review")).toBeUndefined();

  // A reviewer's own verdict shows on its button.
  const reviewing = renderPart(
    web,
    "overlay",
    {},
    {
      fetch: serving(
        designDoc({
          reviewers: [{ name: "Bo", you: true, verdict: "changes" }],
        }),
        [],
      ),
    },
  );

  await drawn(() => named(reviewing, "Ask for changes") !== undefined);

  expect(
    named(reviewing, "Ask for changes")?.getAttribute("aria-pressed"),
  ).toBe("true");

  expect(named(reviewing, "Approve")?.getAttribute("aria-pressed")).toBe(
    "false",
  );

  expect(other.querySelector("[aria-label='Status: In review']")?.tagName).toBe(
    "SPAN",
  );
});

const queueOptions = [
  {
    key: "A",
    title: "Postgres table",
    heading: "Option A: Postgres table",
    summary: "No new service.",
    voters: ["Ana", "You"],
  },
  {
    key: "B",
    title: "NATS JetStream",
    heading: "Option B: NATS JetStream",
    summary: "Fast.",
    voters: [],
  },
  {
    key: "C",
    title: "change nothing",
    heading: "Option C: change nothing",
    summary: "",
    voters: [],
  },
];

function decisionDoc(decision: object = {}, doc: object = {}) {
  return designDoc({
    reviewers: [
      { name: "Ana", you: false, verdict: null },
      { name: "Rui", you: false, verdict: null },
      { name: "Bo", you: true, verdict: null },
    ],
    decision: {
      options: queueOptions,
      abstained: [],
      yours: { option: "A" },
      votes: true,
      votedReviewers: 2,
      chosen: null,
      writing: false,
      ...decision,
    },
    ...doc,
  });
}

async function openDecision(shown: object, asked: Served[] = []) {
  const page = renderPart(
    web,
    "overlay",
    {},
    { hash: "#session-1?artifact=a1", fetch: serving(shown, asked) },
  );

  await drawn(() => page.querySelector("[aria-label=Votes]") !== null);

  return page;
}

const putsOf = (asked: readonly Served[]): Served[] =>
  asked.filter(({ method }) => method === "PUT");

test("a decision record says how many voted in its status and its row, and its page writes who voted under each option", async () => {
  const page = await openDecision(
    decisionDoc({
      options: queueOptions.map((each) =>
        each.key === "A" ? { ...each, voters: ["Ana"] } : each,
      ),
      abstained: ["Rui"],
      yours: null,
    }),
  );

  expect(named(page, "Status: In review · 2 of 3 voted")).toBeDefined();

  const votes = page.querySelector<HTMLElement>("[aria-label=Votes]");

  expect(readOut(votes ?? page)).toStartWith(
    "Options 2 of 3 voted · Rui abstained",
  );

  expect(votes?.querySelector("h3")).toBeNull();

  const frame = frameOf(page);

  act(() => {
    page.querySelector("iframe")?.dispatchEvent(new Event("load"));
  });

  expect(frame.told().find((each) => each.pipoca === "lines")).toEqual({
    pipoca: "lines",
    lines: [
      { heading: "Option A: Postgres table", text: "Ana", strong: true },
      { heading: "Option B: NATS JetStream", text: "No votes", strong: false },
      { heading: "Option C: change nothing", text: "No votes", strong: false },
      {
        heading: "Open questions",
        text: "Kept by Pi from the threads",
        strong: false,
      },
    ],
  });
});

test("a reader votes for an option of a decision record or abstains, and sees which they chose", async () => {
  const asked: Served[] = [];
  const page = await openDecision(decisionDoc(), asked);
  const mine = page.querySelector<HTMLElement>("[aria-label='Your vote']");

  expect(
    [...(mine?.querySelectorAll("button") ?? [])].map((each) => [
      each.textContent,
      each.getAttribute("aria-pressed"),
    ]),
  ).toEqual([
    ["A", "true"],
    ["B", "false"],
    ["C", "false"],
    ["Abstain", "false"],
  ]);

  act(() => {
    named(page, "Option B, NATS JetStream")?.click();
  });

  act(() => {
    named(page, "Abstain")?.click();
  });

  await drawn(() => putsOf(asked).length === 2);

  expect(putsOf(asked)).toEqual([
    {
      url: "/api/ext/artifacts/artifacts/a1/vote",
      method: "PUT",
      body: { option: "B" },
    },
    {
      url: "/api/ext/artifacts/artifacts/a1/vote",
      method: "PUT",
      body: { option: null },
    },
  ]);

  const abstaining = await openDecision(
    decisionDoc({ yours: { option: null } }),
  );

  expect(named(abstaining, "Abstain")?.getAttribute("aria-pressed")).toBe(
    "true",
  );

  expect(
    named(abstaining, "Option A, Postgres table")?.getAttribute("aria-pressed"),
  ).toBe("false");
});

test("whoever steers marks a decision record Decided on the option most voted for, or picks one when none leads", async () => {
  const asked: Served[] = [];

  const page = await openDecision(
    decisionDoc({
      options: queueOptions.map((each) => ({
        ...each,
        voters: { A: ["Ana"], B: ["Bo", "Rui"], C: [] }[each.key] ?? [],
      })),
    }),
    asked,
  );

  expect(named(page, "Mark Decided: A")).toBeUndefined();

  act(() => {
    named(page, "Mark Decided: B")?.click();
  });

  await drawn(() => putsOf(asked).length === 1);

  expect(putsOf(asked)[0]).toEqual({
    url: "/api/ext/artifacts/artifacts/a1/status",
    method: "PUT",
    body: { status: "decided", option: "B" },
  });

  const tied = await openDecision(
    decisionDoc({
      options: queueOptions.map((each) => ({
        ...each,
        voters: { A: [], B: ["Bo"], C: ["Rui"] }[each.key] ?? [],
      })),
    }),
  );

  expect(
    buttons(tied).some((each) => each.textContent.startsWith("Mark Decided:")),
  ).toBe(false);

  act(() => {
    named(tied, "Mark Decided")?.click();
  });

  expect(menuItems(tied).map(readOut)).toEqual([
    "Option B, NATS JetStream",
    "Option C, change nothing",
    "Option A, Postgres table",
  ]);

  const none = await openDecision(
    decisionDoc({
      options: queueOptions.map((each) => ({ ...each, voters: [] })),
      yours: null,
    }),
  );

  expect(named(none, "Mark Decided")).toBeDefined();
});

test("a decision record's status menu decides on any of its options and checks the one it's decided on", async () => {
  const asked: Served[] = [];
  const page = await openDecision(decisionDoc(), asked);

  act(() => {
    named(page, "Status: In review · 2 of 3 voted")?.click();
  });

  expect(menuItems(page).map(readOut)).toEqual([
    "Draft",
    "In review",
    "Decided: Option A, Postgres table",
    "Decided: Option B, NATS JetStream",
    "Decided: Option C, change nothing",
  ]);

  act(() => {
    item(page, "Decided: Option B")?.click();
  });

  await drawn(() => putsOf(asked).length === 1);

  expect(putsOf(asked)[0]).toMatchObject({
    url: "/api/ext/artifacts/artifacts/a1/status",
    body: { status: "decided", option: "B" },
  });

  const settled = await openDecision(
    decisionDoc(
      { chosen: { key: "B", title: "NATS JetStream" } },
      { status: "decided" },
    ),
  );

  act(() => {
    named(settled, "Status: Decided")?.click();
  });

  expect(
    menuItems(settled).map((each) => each.getAttribute("aria-checked")),
  ).toEqual(["false", "false", "false", "true", "false"]);

  // Its colours are the status's own.
  expect(named(settled, "Status: Decided")?.className).not.toContain(
    "bg-transparent",
  );
});

test("someone who only views a decision record sees the votes and gives none", async () => {
  const page = await openDecision({
    ...decisionDoc(
      { yours: null, votes: false, abstained: ["Rui"] },
      { reviewers: [] },
    ),
    access: "view",
  });

  expect(page.querySelector("[aria-label='Your vote']")).toBeNull();
  expect(named(page, "Mark Decided: A")).toBeUndefined();

  expect(readOut(page.querySelector("[aria-label=Votes]") ?? page)).toBe(
    "Options 3 voted · Rui abstained",
  );
});

test("a decided record names its option while Pi writes the Decision section, and Save as is keeps the text as it is", async () => {
  const asked: Served[] = [];

  const page = await openDecision(
    decisionDoc(
      { chosen: { key: "A", title: "Postgres table" }, writing: true },
      { status: "decided" },
    ),
    asked,
  );

  const votes = page.querySelector<HTMLElement>("[aria-label=Votes]");

  expect(votes?.querySelector("[role=status]")?.textContent).toBe(
    "Decided on Option A, Postgres table. Pi is writing the Decision section",
  );

  expect(page.querySelector("[aria-label='Your vote']")).toBeNull();
  expect(named(page, "Mark Decided")).toBeUndefined();

  const frame = frameOf(page);

  act(() => {
    page.querySelector("iframe")?.dispatchEvent(new Event("load"));
  });

  expect(frame.told().find((each) => each.pipoca === "lines")).toMatchObject({
    lines: [{ text: "Ana, You", badge: "Decided" }, {}, {}, {}],
  });

  act(() => {
    named(page, "Save as is")?.click();
  });

  await drawn(() => putsOf(asked).length === 1);

  expect(putsOf(asked)[0]).toMatchObject({
    url: "/api/ext/artifacts/artifacts/a1/status",
    body: { status: "decided", option: "A", ask: false },
  });
});

test("marking a decision record Decided moves focus to what it says now", async () => {
  const shown: object = decisionDoc();
  const page = await openDecision(shown);

  act(() => {
    named(page, "Mark Decided: A")?.click();
  });

  Object.assign(
    shown,
    decisionDoc(
      { chosen: { key: "A", title: "Postgres table" }, writing: true },
      { status: "decided" },
    ),
  );

  act(() => {
    changed("artifacts.artifacts");
  });

  await drawn(() => document.activeElement?.getAttribute("role") === "status");

  expect(document.activeElement?.textContent).toStartWith(
    "Decided on Option A",
  );
});

test("an option keyed by its heading's text shows that text", async () => {
  const asked: Served[] = [];

  const page = await openDecision(
    decisionDoc({
      options: [
        {
          key: "Keep retries",
          title: "Keep retries",
          heading: "Keep retries",
          summary: "",
          voters: [],
        },
      ],
      yours: null,
    }),
    asked,
  );

  expect(named(page, "Keep retries")?.textContent).toBe("Keep retries");

  act(() => {
    named(page, "Keep retries")?.click();
  });

  await drawn(() => putsOf(asked).length === 1);
  expect(putsOf(asked)[0]).toMatchObject({ body: { option: "Keep retries" } });
});

test("a doc's own Open questions section stands for the outline's roll-up", async () => {
  const page = renderPart(
    web,
    "overlay",
    {},
    {
      hash: "#session-1?artifact=a1",
      width: 1280,
      fetch: serving(designDoc(), [], { comments: () => questions }),
    },
  );

  await drawn(() => page.querySelector("iframe") !== null);

  const frame = frameOf(page);

  frame.tell({
    pipoca: "outline",
    sections: [
      { text: "Context", level: 2, threads: [1] },
      { text: "Open questions", level: 2, threads: [] },
    ],
    tops: [],
    scrolled: 0,
  });

  const outline = page.querySelector<HTMLElement>("nav[aria-label=Outline]");

  await drawn(() => (outline?.querySelectorAll("li").length ?? 0) > 0);

  expect(
    [...(outline?.querySelectorAll("li") ?? [])].map(
      (each) => each.textContent,
    ),
  ).toEqual(["Context1 open", "Open questions1 open"]);

  act(() => {
    if (outline !== null) {
      buttons(outline)
        .find((each) => each.textContent.startsWith("Open questions"))
        ?.click();
    }
  });

  await drawn(
    () => page.querySelector("[aria-label='Open questions']") !== null,
  );

  expect(frame.told().some((each) => each.pipoca === "goto")).toBe(false);
});

test("reviewers who voted are counted by who they are, not by the names shown", async () => {
  const page = await openDecision(
    decisionDoc({
      options: queueOptions.map((each) => ({ ...each, voters: ["Ana"] })),
      votedReviewers: 1,
    }),
  );

  expect(named(page, "Status: In review · 1 of 3 voted")).toBeDefined();
});

test("a decided record whose Options section is gone still names its option, and can be saved as is", async () => {
  const asked: Served[] = [];

  const page = await openDecision(
    decisionDoc(
      {
        options: [],
        chosen: { key: "A", title: "Postgres table" },
        writing: true,
      },
      { status: "decided" },
    ),
    asked,
  );

  expect(
    page.querySelector("[aria-label=Votes] [role=status]")?.textContent,
  ).toBe(
    "Decided on Option A, Postgres table. Pi is writing the Decision section",
  );

  act(() => {
    named(page, "Save as is")?.click();
  });

  await drawn(() => putsOf(asked).length === 1);

  expect(putsOf(asked)[0]).toMatchObject({
    body: { status: "decided", option: "A", ask: false },
  });
});

test("whoever steers a design doc sets its status and reviewers, and marks or unmarks it", async () => {
  const asked: Served[] = [];

  // What the server has now, changed as the test goes.
  const shown: object = {
    ...artifact({ title: "Plan" }),
    ...viewed(1),
    doc: null,
  };

  const page = renderPart(
    web,
    "overlay",
    {},
    {
      hash: "#session-1?artifact=a1",
      fetch: serving(shown, asked, { people: ["Bo", "Rui"] }),
    },
  );

  await opened(asked);

  const puts = (): Served[] => asked.filter(({ method }) => method === "PUT");

  act(() => {
    named(page, "More")?.click();
  });

  act(() => {
    item(page, "Mark as design doc")?.click();
  });

  await drawn(() => puts().length === 1);

  expect(puts()[0]).toMatchObject({
    url: "/api/ext/artifacts/artifacts/a1/doc",
    body: { type: "design" },
  });

  Object.assign(
    shown,
    designDoc({
      status: "draft",
      marked: "person",
      reviewers: [{ name: "Bo", you: false, verdict: null }],
    }),
  );

  act(() => {
    changed("artifacts.artifacts");
  });

  await drawn(() => page.querySelector("[aria-label=Review]") !== null);

  act(() => {
    named(page, "Status: Draft")?.click();
  });

  act(() => {
    item(page, "Decided")?.click();
  });

  await drawn(() => puts().length === 2);

  expect(puts()[1]).toMatchObject({
    url: "/api/ext/artifacts/artifacts/a1/status",
    body: { status: "decided" },
  });

  act(() => {
    named(page, "Add reviewer")?.click();
  });

  expect(menuItems(page).map(readOut)).toEqual(["Rui"]);

  act(() => {
    menuItems(page)
      .find((each) => readOut(each) === "Rui")
      ?.click();
  });

  await drawn(() => puts().length === 3);

  expect(puts()[2]).toMatchObject({
    url: "/api/ext/artifacts/artifacts/a1/reviewers",
    body: { reviewers: ["Bo", "Rui"] },
  });

  act(() => {
    named(page, "Take Bo off the review")?.click();
  });

  await drawn(() => puts().length === 4);
  expect(puts()[3]).toMatchObject({ body: { reviewers: [] } });

  act(() => {
    named(page, "More")?.click();
  });

  act(() => {
    item(page, "Not a design doc")?.click();
  });

  await drawn(() => puts().length === 5);

  expect(puts()[4]).toMatchObject({
    url: "/api/ext/artifacts/artifacts/a1/doc",
    body: { type: null },
  });
});

test("a design doc's outline lists its sections with their open threads, goes to one, and rolls up open questions", async () => {
  const asked: Served[] = [];

  const page = renderPart(
    web,
    "overlay",
    {},
    {
      hash: "#session-1?artifact=a1",
      width: 1280,
      fetch: serving(designDoc(), asked, { comments: () => questions }),
    },
  );

  await opened(asked);
  await drawn(() => page.querySelector("iframe") !== null);

  const frame = frameOf(page);

  frame.tell({
    pipoca: "outline",
    sections: [
      { text: "Webhooks v2", level: 1, threads: [] },
      { text: "Context", level: 2, threads: [] },
      { text: "Decision", level: 2, threads: [1, 3] },
    ],
    tops: [
      { n: 1, top: 340 },
      { n: 3, top: 300 },
    ],
    scrolled: 0,
  });

  const outline = page.querySelector<HTMLElement>("nav[aria-label=Outline]");

  // The title isn't a section of its own.
  expect(
    [...(outline?.querySelectorAll("li") ?? [])].map(
      (each) => each.textContent,
    ),
  ).toEqual(["Context", "Decision2 open", "Open questions1 open"]);

  act(() => {
    if (outline !== null) {
      buttons(outline)
        .find((each) => each.textContent.startsWith("Decision"))
        ?.click();
    }
  });

  expect(frame.told().at(-1)).toEqual({ pipoca: "goto", section: 2 });

  act(() => {
    if (outline !== null) {
      buttons(outline)
        .find((each) => each.textContent.startsWith("Open questions"))
        ?.click();
    }
  });

  await drawn(
    () => page.querySelector("[aria-label='Open questions']") !== null,
  );

  expect(
    [
      ...page.querySelectorAll(
        "[aria-label='Open questions'] li button[aria-label^=Comment]",
      ),
    ].map((each) => each.getAttribute("aria-label")),
  ).toEqual(["Comment 1 by Ana"]);

  // In the margin the cards go in the page's order, each moved down to its
  // passage, with no sheet to put away.
  act(() => {
    named(page, "Open 2")?.click();
  });

  await drawn(
    () => page.querySelector("[aria-label='Open comments'] li") !== null,
  );

  const cards = [
    ...page.querySelectorAll<HTMLElement>("[aria-label='Open comments'] li"),
  ];

  expect(cards.map((each) => each.dataset["thread"])).toEqual(["c1", "q1"]);
  expect(cards[0]?.style.marginTop).toBe("300px");
  expect(named(page, "Back to the page")).toBeUndefined();

  // Docked, there's no room for the outline.
  act(() => {
    named(page, "Dock beside the page")?.click();
  });

  await drawn(() => page.querySelector("dialog[open]") === null);
  expect(page.querySelector("nav[aria-label=Outline]")).toBeNull();

  act(() => {
    named(page, "Dock beside the page")?.click();
  });
});

test("Activity lists what's for the person, opens each where it happened and marks it read, and says what they're told of where", async () => {
  const asked: Served[] = [];

  const entry = (o: Partial<ActivityItem> & { readonly id: string }) => ({
    kind: "mention" as const,
    artifact: "a1" as string | null,
    session: null as string | null,
    title: "Webhooks v2 delivery design",
    thread: "t1",
    quote: "retries",
    by: "Rui",
    byPi: false,
    suggested: false,
    excerpt: "Works for me. @Ana ok to accept?",
    doc: null,
    version: 5,
    at: Date.now() - 1000,
    read: false,
    ...o,
  });

  let read = new Set<string>();

  const mine = () => {
    const items = [
      entry({ id: "i1" }),
      entry({
        id: "i2",
        kind: "review",
        by: "Pedro",
        thread: null,
        quote: "",
        excerpt: "",
        doc: "design",
      }),
      entry({
        id: "i3",
        kind: "reply",
        by: "Pi",
        byPi: true,
        suggested: true,
        excerpt: "12 hours covers the March outage",
      }),
      entry({
        id: "i4",
        kind: "comment",
        artifact: "a2",
        title: "Rollout checklist",
        thread: "t9",
        excerpt: "Add a step",
      }),
      entry({
        id: "i5",
        artifact: null,
        session: "s7",
        title: "Launch prep",
        thread: null,
        quote: "",
        excerpt: "@ana can you check the rollout?",
      }),
    ].map((each) => ({ ...each, read: read.has(each.id) }));

    return { items, unread: items.filter((each) => !each.read).length };
  };

  let settings = { asked: true, replies: true, comments: false };

  const page = renderPart(
    web,
    "page:activity",
    { path: "" },
    {
      hash: "#plugin/artifacts/activity",
      fills: { "activity.channel": () => <> · push</> },
      fetch: async (url, init) => {
        await Promise.resolve();

        const body =
          typeof init?.body === "string"
            ? (JSON.parse(init.body) as Record<string, unknown>)
            : undefined;

        asked.push({ url, method: init?.method ?? "GET", body });

        if (url.endsWith("/activity/read")) {
          const ids = body?.["ids"] as string[] | undefined;

          read = new Set(ids ?? mine().items.map(({ id }) => id));
          changed("artifacts.artifacts");

          return Response.json({ read: true });
        }

        if (url.endsWith("/activity/settings")) {
          if (init?.method === "PUT") {
            settings = { ...settings, [String(body?.["topic"])]: body?.["on"] };
          }

          return Response.json(settings);
        }

        if (url.includes("/activity?view=following")) {
          return Response.json({
            items: [
              entry({ id: "f1", read: true, kind: "reply", excerpt: "Me" }),
              entry({ id: "f2", read: true, kind: "comment" }),
            ],
            unread: 0,
          });
        }

        return Response.json(mine());
      },
    },
  );

  const rows = (): HTMLElement[] => [
    ...page.querySelectorAll<HTMLElement>("ul[aria-label=Activity] button"),
  ];

  await drawn(() => rows().length === 5);

  const text = (at: number): string =>
    (rows()[at]?.textContent ?? "").replaceAll("\u00a0", " ");

  expect(text(0)).toContain(
    "Unread: Rui mentioned you on Webhooks v2 delivery design",
  );

  expect(text(0)).toContain(
    "“Works for me. @Ana ok to accept?” · thread on retries · ",
  );

  expect(text(0)).toEndWith("Mention");

  // Only what was written gives way on a narrow row.
  expect(rows()[0]?.querySelector(".truncate")?.textContent).toBe(
    "“Works for me. @Ana ok to accept?",
  );

  expect(text(1)).toContain(
    "Pedro asked you to review Webhooks v2 delivery design",
  );

  expect(text(1)).toContain("Design doc · ");
  expect(text(2)).toContain("Pi suggested an edit in a thread you're in");
  expect(text(3)).toContain("Rui commented on Rollout checklist");
  expect(text(3)).toContain("Your artifact · ");
  expect(text(4)).toContain("Rui mentioned you in Launch prep");
  expect(text(4)).toContain("“@ana can you check the rollout?” · ");

  // A mention in team work opens that work.
  act(() => {
    rows()[4]?.click();
  });

  expect(location.hash).toBe("#s7");

  act(() => {
    location.hash = "#plugin/artifacts/activity";
  });

  await drawn(() => rows().length === 5);

  // A row opens the artifact at its thread and marks it read.
  act(() => {
    rows()[3]?.click();
  });

  expect(location.hash).toBe(
    "#plugin/artifacts/activity?artifact=a2&comments=1&thread=t9",
  );

  await drawn(() => !text(3).includes("Unread"));

  expect(
    asked
      .filter(({ url }) => url.endsWith("/activity/read"))
      .map(({ body }) => body),
  ).toEqual([{ ids: ["i5"] }, { ids: ["i4"] }]);

  act(() => {
    named(page, "Mark all read")?.click();
  });

  await drawn(() =>
    rows().every((each) => !each.textContent.includes("Unread")),
  );

  expect(named(page, "Mark all read")?.disabled).toBe(true);

  // What they're told of, and where.
  const card = page.querySelector("section[aria-labelledby=activity-settings]");

  expect(
    [...(card?.querySelectorAll("li") ?? [])].map((each) => [
      each.querySelector("span")?.textContent,
      each.querySelector("span + span")?.textContent,
      each.querySelector("[role=switch]")?.getAttribute("aria-checked"),
    ]),
  ).toEqual([
    ["Mentions and review requests", "Here · push", "true"],
    ["Replies in threads I'm in", "Here · push", "true"],
    ["Every new comment on my artifacts", "Here · push", "false"],
  ]);

  act(() => {
    card?.querySelectorAll<HTMLElement>("[role=switch]")[2]?.click();
  });

  await drawn(
    () =>
      card
        ?.querySelectorAll("[role=switch]")[2]
        ?.getAttribute("aria-checked") === "true",
  );

  expect(asked.findLast(({ method }) => method === "PUT")?.body).toEqual({
    topic: "comments",
    on: true,
  });

  // Everything they follow, without a mark of its own.
  act(() => {
    named(page, "Everything I follow")?.click();
  });

  await drawn(() => rows().length === 2);

  expect(text(0)).toContain("Rui replied in a thread you're in");

  // What they follow isn't always theirs.
  expect(text(1)).not.toContain("Your artifact");
  expect(named(page, "Mark all read")).toBeUndefined();
});

test("a link to another thread of the artifact open in the window opens that thread", async () => {
  const Gallery = slots.page;

  if (Gallery === undefined) {
    throw new Error("no gallery page");
  }

  const Page = Gallery;

  let go = (_path: string): void => undefined;

  function Moving(): ReactElement {
    const [path, setPath] = useState("a1/comments/t1");

    go = setPath;

    return <Page path={path} />;
  }

  const moving = { page: Moving };

  const page = renderPart(
    { ...web, slots: moving },
    "page",
    {},
    {
      hash: "#plugin/artifacts/a1/comments/t1",
      fetch: lively(async (url) => {
        await Promise.resolve();

        return url.endsWith("/comments")
          ? Response.json({
              comments: [
                thread({ id: "t1", quote: "three times" }),
                thread({ id: "t2", quote: "Nov 3" }),
              ],
            })
          : Response.json({ ...artifact({ versions: 2 }), ...viewed(2) });
      }),
    },
  );

  const title = (): string | null | undefined =>
    page.querySelector("h3")?.textContent;

  await drawn(() => title() === "Thread on “three times”");

  act(() => {
    go("a1/comments/t2");
  });

  await drawn(() => title() === "Thread on “Nov 3”");
});

test("a version Pi publishes while the artifact is open says so and compares it with the one before", async () => {
  let served = { ...artifact({ versions: 3 }), ...viewed(3) };

  const page = renderPart(
    { ...web, slots },
    "page",
    { path: "a1" },
    {
      hash: "#plugin/artifacts/a1",
      fetch: lively(async (url) => {
        await Promise.resolve();

        return url.endsWith("/comments")
          ? Response.json({ comments: [] })
          : Response.json(served);
      }),
    },
  );

  await drawn(() => page.textContent.includes("Version 3 · latest"));

  // What was there when it opened isn't news.
  expect(page.querySelector("[aria-label='New version']")).toBeNull();

  const four = viewed(4);

  served = {
    ...artifact({ versions: 4 }),
    ...four,
    history: four.history.map((each) =>
      each.number === 4
        ? { ...each, note: "Error rate next to the bars" }
        : each,
    ),
  };

  act(() => {
    changed("artifacts.artifacts");
  });

  await drawn(() => page.querySelector("[aria-label='New version']") !== null);

  expect(page.querySelector("[aria-label='New version']")?.textContent).toBe(
    "Pi published version 4 · “Error rate next to the bars”Compare with 3",
  );

  act(() => {
    named(page, "Compare with 3")?.click();
  });

  await drawn(
    () => page.querySelector("[aria-label='Back to version 4']") !== null,
  );
});

test("a save Pi makes on a living doc is named as the version menu names it", async () => {
  let served: object = {
    ...artifact({ versions: 1, living: true }),
    ...viewed(1),
  };

  const page = renderPart(
    { ...web, slots },
    "page",
    { path: "a1" },
    {
      hash: "#plugin/artifacts/a1",
      fetch: lively(async (url) => {
        await Promise.resolve();

        return url.endsWith("/comments")
          ? Response.json({ comments: [] })
          : Response.json(served);
      }),
    },
  );

  await drawn(() => versionMenu(page) !== undefined);

  const banner = (): string =>
    page.querySelector("[aria-label='New version'] span")?.textContent ?? "";

  const saved = (label: string | null, saves: number): void => {
    const shown = viewed(saves);

    served = {
      ...artifact({ versions: saves, living: true }),
      ...shown,
      history: shown.history.map((each) =>
        each.number === saves ? { ...each, label } : each,
      ),
    };

    act(() => {
      changed("artifacts.artifacts");
    });
  };

  saved(null, 2);
  await drawn(() => banner() !== "");
  expect(banner()).toBe("Pi edited it");

  saved("Decided by Ana", 3);
  await drawn(() => banner() !== "Pi edited it");
  expect(banner()).toBe("Pi published version 1 · Decided by Ana");
});

test("a Markdown doc lists its versions, then its edits by person and hour, names the latest as a version, and compares what changed since approval", async () => {
  const asked: Served[] = [];
  const hour = 60 * 60 * 1000;
  const now = Date.now();

  const save = (
    number: number,
    by: string,
    ago: number,
    label: string | null = null,
  ) => ({
    number,
    name: "plan.md",
    size: 10,
    author: by === "Pi" ? "session:session-1" : `user:${by.toLowerCase()}`,
    by,
    note: "",
    createdAt: now - ago,
    label,
  });

  const shown = (history: readonly object[], status = "review") => ({
    ...artifact({
      title: "Plan",
      kind: "markdown",
      versions: history.length,
      living: true,
      named: history.filter((each) => "label" in each && each.label !== null)
        .length,
    }),
    ...viewed(1),
    history,
    doc: {
      type: "design",
      status,
      marked: "person",
      reviewers: [{ name: "Ana", you: true, verdict: null }],
    },
  });

  // Pi's two edits in an hour, an approved one of Pi's, then Ana's two.
  let served = shown([
    save(1, "Pi", 5 * hour),
    save(2, "Pi", 4.5 * hour),
    save(3, "Pi", 3 * hour, "Approved by Bo"),
    save(4, "Ana", 20 * 60_000),
    save(5, "Ana", 5 * 60_000),
  ]);

  const fetch = serving(served, asked);

  const page = renderPart(
    web,
    "overlay",
    {},
    {
      hash: "#session-1?artifact=a1",
      fetch: async (url, init) =>
        url.endsWith("/artifacts/a1") && (init?.method ?? "GET") === "GET"
          ? Response.json(served)
          : fetch(url, init),
    },
  );

  await opened(asked);
  await drawn(() => versionMenu(page) !== undefined);

  expect(versionMenu(page)?.textContent).toBe("Latest");

  act(() => {
    versionMenu(page)?.click();
  });

  expect(menuItems(page).map((each) => each.textContent)).toEqual([
    "Version 1Approved by Bo · 3h ago",
    "Edited by Ana latest5m ago · 2 edits",
    "Edited by Pi3h ago",
    "Edited by Pi4h ago · 2 edits",
    "Compare versions…",
  ]);

  // Its review bar compares the latest text with the version approved.
  act(() => {
    versionMenu(page)?.click();
    named(page, "Changes since approval")?.click();
  });

  await drawn(() => page.textContent.includes("Comparing two versions"));

  expect(
    [...page.querySelectorAll("section[aria-label]")].map((each) =>
      each.getAttribute("aria-label"),
    ),
  ).toEqual(["Version 1", "Latest"]);

  act(() => {
    named(page, "Back to latest")?.click();
  });

  // Someone who steers it names the latest text.
  act(() => {
    named(page, "More")?.click();
  });

  act(() => {
    item(page, "Save version…")?.click();
  });

  const dialog = page.querySelector<HTMLElement>("dialog[open]");
  const field = dialog?.querySelector("input");

  act(() => {
    if (field !== null && field !== undefined) {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set?.call(field, "Sent to legal");

      field.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });

  act(() => {
    named(dialog ?? page, "Save version")?.click();
  });

  await act(async () =>
    until(() => asked.some(({ url }) => url.endsWith("/a1/label"))),
  );

  expect(asked.find(({ url }) => url.endsWith("/a1/label"))).toMatchObject({
    method: "POST",
    body: { label: "Sent to legal" },
  });

  // Once it's a version, the menu offers no Save version.
  served = shown([...served.history, save(6, "Ana", 0, "Sent to legal")]);

  act(() => {
    changed("artifacts.artifacts");
  });

  await drawn(() => versionMenu(page)?.textContent === "Version 2 · latest");

  act(() => {
    named(page, "More")?.click();
  });

  expect(item(page, "Save version…")).toBeUndefined();
});

test("above the composer, it says how many threads wait for Pi's turn to end", async () => {
  const asked: string[] = [];
  let threads = 2;

  const page = renderPart(
    web,
    "session.composer",
    { session: sessionWith({}) },
    {
      fetch: lively(async (url) => {
        await Promise.resolve();
        asked.push(url);

        return Response.json({ threads });
      }),
    },
  );

  await drawn(() => page.textContent.includes("waiting"));

  expect(asked[0]).toBe(
    `/api/ext/artifacts/waiting?session=${sessionWith({}).id}`,
  );

  expect(page.textContent).toBe(
    "2 more threads waitingPi reads them when this turn ends",
  );

  threads = 0;

  act(() => {
    changed("artifacts.artifacts");
  });

  await drawn(() => page.textContent === "");
});

test("a thread carries over to newer versions, and is Outdated only where its passage is gone, however long its quote", async () => {
  const asked: Served[] = [];

  const viewer = renderPart(
    web,
    "overlay",
    {},
    {
      hash: "#session-1?artifact=a1&comments=1",
      fetch: serving({ ...artifact({ versions: 3 }), ...viewed(3) }, asked, {
        comments: () => [
          thread({
            id: "t1",
            version: 1,
            element: "#intro",
            quote:
              "Async backup. Three levels of simplicity, from one key to many",
            body: "Lets discuss this?",
          }),
          thread({
            id: "t2",
            version: 1,
            quote: "Ship Friday",
            body: "Still true?",
          }),
          thread({ id: "t3", version: 3, body: "On the whole page" }),
        ],
      }),
    },
  );

  await opened(asked);
  await drawn(() => viewer.textContent.includes("Lets discuss this?"));

  const card = (said: string) =>
    [...viewer.querySelectorAll("li[data-thread]")].find((each) =>
      each.textContent.includes(said),
    );

  const outdated = (said: string) =>
    card(said)?.querySelector("[title^='What it']")?.textContent ?? null;

  // Until the page says what it pinned, nothing is called Outdated, and no
  // thread names the version it was written on.
  expect(outdated("Lets discuss")).toBeNull();
  expect(viewer.textContent).not.toContain("Version 1");

  frameOf(viewer).tell({
    pipoca: "outline",
    sections: [],
    tops: [{ n: 2, top: 120 }],
    scrolled: 0,
  });

  await drawn(() => outdated("Lets discuss") === "Outdated");

  // Outside the quote, which is cut short, so it always shows.
  expect(
    card("Lets discuss")?.querySelector(".truncate [title^='What it']"),
  ).toBeNull();

  expect(outdated("Still true?")).toBeNull();
  expect(outdated("On the whole page")).toBeNull();
});

test("a folder's page switches to its files, which say what the version changed in each, show each file's changes or whole text, and download as a .zip", async () => {
  const asked: string[] = [];
  const shown = { ...artifact({ title: "Orders", versions: 2 }), ...viewed(2) };

  const folder = {
    ...shown,
    history: shown.history.map((each, at) => ({
      ...each,
      name: "index.html",
      files: at === 0 ? 1 : 5,
      note: at === 0 ? "" : "moved the numbers into data/orders.json",
    })),
  };

  const texts: Readonly<Record<string, string>> = {
    "1:styles/app.css": ".kpi {\n  color: red;\n}\n",
    "2:styles/app.css": ".kpi {\n  color: green;\n  font-weight: 600;\n}\n",
    "1:index.html": "<h1>Order</h1>\n",
    "2:index.html": "<h1>Orders</h1>\n",
    "2:img/logo.svg": "<svg/>",
    "2:img/chart.png": "png",
    "1:styles/old.css": "p {}\n",
  };

  const page = renderPart(
    web,
    "overlay",
    {},
    {
      hash: "#session-1?artifact=a1",
      fetch: lively(async (url) => {
        await Promise.resolve();

        asked.push(url);

        const file = /\/download\?v=(\d+)&path=([^&]+)$/.exec(url);

        if (file !== null) {
          const text =
            texts[`${String(file[1])}:${decodeURIComponent(String(file[2]))}`];

          return text === undefined
            ? new Response(null, { status: 500 })
            : new Response(text);
        }

        if (url.endsWith("/files?v=2")) {
          return Response.json({
            entry: "index.html",
            files: [
              {
                path: "data/orders.json",
                size: 6,
                change: "added",
                lines: null,
              },
              { path: "img/chart.png", size: 3, change: "added", lines: null },
              { path: "img/logo.svg", size: 40, change: "same", lines: null },
              {
                path: "index.html",
                size: 16,
                change: "edited",
                lines: { added: 1, removed: 1 },
              },
              {
                path: "styles/app.css",
                size: 45,
                change: "edited",
                lines: { added: 2, removed: 1 },
              },
            ],
            removed: ["styles/old.css"],
            maxBytes: 52_428_800,
          });
        }

        return Response.json(
          url.endsWith("/comments") ? { comments: [] } : folder,
        );
      }),
    },
  );

  const downloads = spyOn(location, "assign").mockImplementation(
    () => undefined,
  );

  const lines = (): (string | null)[] =>
    [...page.querySelectorAll("pre div")].map((each) => each.textContent);

  const reads = (path: string): number =>
    asked.filter((url) => url.endsWith(`&path=${encodeURIComponent(path)}`))
      .length;

  try {
    await drawn(() => named(page, "Files 5") !== undefined);

    expect(page.querySelector("dialog[open]")?.textContent).toContain(
      "5 files · From “Why did checkout slow down?” · Only you",
    );

    expect(named(page, "Page")?.getAttribute("aria-pressed")).toBe("true");
    expect(named(page, "Comment")).toBeDefined();

    act(() => {
      named(page, "Files 5")?.click();
    });

    await drawn(
      () => page.querySelector("nav[aria-label=Files] button") !== null,
    );

    // Comments are on the page, so the files offer none.
    expect(named(page, "Comment")).toBeUndefined();

    const nav = page.querySelector("nav[aria-label=Files]");
    const rows = [...(nav?.querySelectorAll("button") ?? [])];

    expect(
      rows.map((each) => [
        each.getAttribute("aria-label"),
        [...each.querySelectorAll("[aria-hidden]")].map(
          (tag) => tag.textContent,
        ),
        each.getAttribute("aria-current"),
      ]),
    ).toEqual([
      [
        "index.html, entry file, 1 line added, 1 removed",
        ["entry", "+1 −1"],
        "true",
      ],
      ["data/orders.json, new", ["new"], null],
      ["img/chart.png, new", ["new"], null],
      ["img/logo.svg", [], null],
      ["styles/app.css, 2 lines added, 1 removed", ["+2 −1"], null],
      ["styles/old.css, removed", ["removed"], null],
    ]);

    expect(nav?.textContent).toContain(
      "2 files edited, 2 added, 1 removed, 1 the same. “moved the numbers into data/orders.json”",
    );

    expect(nav?.textContent).toContain(
      "Up to 200 files and 50.0 MB per version. The same file in two versions is stored once.",
    );

    await drawn(() => lines().length > 0);

    expect(page.querySelector("pre")?.getAttribute("aria-label")).toBe(
      "Changes",
    );

    expect(lines()).toEqual([
      "- removed: <h1>Order</h1>",
      "+ added: <h1>Orders</h1>",
      "  ",
    ]);

    act(() => {
      named(page, "styles/app.css, 2 lines added, 1 removed")?.click();
    });

    await drawn(() => lines()[1] === "- removed:   color: red;");

    expect(lines()).toEqual([
      "  .kpi {",
      "- removed:   color: red;",
      "+ added:   color: green;",
      "+ added:   font-weight: 600;",
      "  }",
      "  ",
    ]);

    const before = reads("styles/app.css");

    // The whole file is the text already read, so it shows at once.
    act(() => {
      named(page, "Whole file")?.click();
    });

    expect(page.querySelector("pre")?.getAttribute("aria-label")).toBe(
      "Whole file",
    );

    expect(lines()).toEqual([
      "  .kpi {",
      "    color: green;",
      "    font-weight: 600;",
      "  }",
      "  ",
    ]);

    expect(reads("styles/app.css")).toBe(before);

    // A file the version didn't change has only its whole text.
    act(() => {
      rows[3]?.click();
    });

    await drawn(() => lines()[0] === "  <svg/>");

    expect(named(page, "Whole file")).toBeUndefined();

    // A file the version took out shows what it was.
    act(() => {
      rows[5]?.click();
    });

    await drawn(() => lines()[0] === "- removed: p {}");

    expect(lines()).toEqual(["- removed: p {}"]);

    expect(named(page, "Whole file")).toBeUndefined();

    // A picture shows as itself.
    act(() => {
      rows[2]?.click();
    });

    await drawn(() => page.querySelector("img[alt='img/chart.png']") !== null);

    expect(
      page.querySelector("img[alt='img/chart.png']")?.getAttribute("src"),
    ).toStartWith("blob:");

    // A file that doesn't load says which.
    act(() => {
      rows[1]?.click();
    });

    await drawn(() =>
      page.textContent.includes("data/orders.json didn't load. Try again."),
    );

    act(() => {
      named(page, "Download .zip")?.click();
    });

    expect(downloads).toHaveBeenCalledWith(
      expect.stringMatching(/\/artifacts\/a1\/download\?v=2$/),
    );

    // The .zip is offered once, beside the files, not again under More.
    act(() => {
      named(page, "More")?.click();
    });

    expect(item(page, "Download")).toBeUndefined();

    act(() => {
      named(page, "More")?.click();
    });

    // A version of one file has no files to switch to.
    act(() => {
      versionMenu(page)?.click();
    });

    act(() => {
      item(page, "Version 1")?.click();
    });

    await drawn(() => named(page, "Files 5") === undefined);

    expect(page.querySelector("nav[aria-label=Files]")).toBeNull();
    expect(named(page, "Page")).toBeUndefined();
  } finally {
    downloads.mockRestore();
  }
});

function template(o: Partial<Template> = {}): Template {
  return {
    id: "slide-deck",
    name: "Slide deck",
    description: "Seven starting slides.",
    type: "slides",
    for: "present",
    scope: "builtin",
    entry: "deck.html",
    files: ["deck.html", "deck.css"],
    instructions: "Ask who the audience is.",
    example: false,
    by: "Pipoca",
    preview: "templates/slide-deck/files/deck.html",
    ...o,
  };
}

const someTemplates = [
  template(),
  template({
    id: "decision-record",
    name: "Decision record",
    description: "Options and a verdict.",
    type: "markdown",
    for: "discuss",
    entry: "decision.md",
    files: ["decision.md"],
    instructions: "Ask which decision this records.",
    preview: "templates/decision-record/files/decision.md",
  }),
  template({
    id: "t1",
    name: "Our review",
    description: "Timeline, impact and follow-ups.",
    type: "markdown",
    for: "discuss",
    scope: "server",
    entry: "review.md",
    files: ["review.md"],
    instructions: "",
    example: true,
    by: "Ana",
    preview: "artifacts/t1/view?v=1",
  }),
];

function pickerDialog(): HTMLDialogElement | undefined {
  return [...document.querySelectorAll("dialog")].find((each) =>
    each.textContent.includes("New artifact"),
  );
}

function tileInputs(root: ParentNode): HTMLInputElement[] {
  return [
    ...root.querySelectorAll<HTMLInputElement>(
      "[role=radiogroup][aria-label=Templates] input[type=radio]",
    ),
  ];
}

function tileTexts(root: ParentNode): string[] {
  return tileInputs(root).map(
    (each) => each.closest("label")?.textContent ?? "",
  );
}

function tabTexts(root: ParentNode): string[] {
  return [...root.querySelectorAll("[role=tab]")].map(
    (each) => each.textContent,
  );
}

// Types into a field as a person does, so React hears it.
function typeIn(
  field: HTMLInputElement | null | undefined,
  text: string,
): void {
  act(() => {
    if (field === null || field === undefined) {
      return;
    }

    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(field, text);

    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function templatesPage(
  fetch: (url: string, init?: RequestInit) => Promise<Response>,
): HTMLElement {
  return renderPart(
    { ...web, slots },
    "page",
    { path: "" },
    { hash: "#plugin/artifacts", fetch },
  );
}

function servingTemplates(
  templates: readonly Template[],
  asked: Served[] = [],
  own = true,
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

    if (init?.method === "POST") {
      return Response.json({ id: "a9" });
    }

    return Response.json(
      /\/templates(\?|$)/.test(url)
        ? {
            templates: own
              ? templates
              : templates.filter(({ scope }) => scope !== "mine"),
            own,
          }
        : { artifacts: [] },
    );
  };
}

async function openPicker(page: HTMLElement): Promise<HTMLDialogElement> {
  act(() => {
    named(page, "New")?.click();
  });

  await drawn(() => tileInputs(pickerDialog() ?? page).length > 0);

  const dialog = pickerDialog();

  if (dialog === undefined) {
    throw new Error("no picker");
  }

  return dialog;
}

test("Artifacts › New picks a template by whose it is and what it's for, and starts it with Pi in a new Session in the person's words", async () => {
  const page = templatesPage(servingTemplates(someTemplates));
  const dialog = await openPicker(page);

  expect(tabTexts(dialog)).toEqual(["Built in 2", "Server 1", "Mine 0"]);

  // Each tile is a radio of one group, captioned with what it holds, and
  // the blank one comes last.
  expect(tileTexts(dialog)).toEqual([
    "Slide deckSeven starting slides.",
    "Decision recordOptions and a verdict.",
    "BlankNothing to start from: tell Pi what to make.",
  ]);

  expect(new Set(tileInputs(dialog).map(({ name }) => name)).size).toBe(1);

  expect(tileInputs(dialog).map(({ checked }) => checked)).toEqual([
    true,
    false,
    false,
  ]);

  // Each tile draws its entry small, in the artifacts' sandbox.
  expect(dialog.querySelector("label iframe")?.getAttribute("src")).toBe(
    "/api/ext/artifacts/templates/slide-deck/files/deck.html",
  );

  expect(dialog.querySelector("label iframe")?.getAttribute("sandbox")).toBe(
    "allow-scripts",
  );

  // A deck's first slide shows whole, letterboxed at 16:9.
  const frames = [
    ...dialog.querySelectorAll<HTMLIFrameElement>("label iframe"),
  ];

  expect(frames[0]?.parentElement?.className).toContain("aspect-video");
  expect(frames[0]?.style.height).toBe("720px");
  expect(frames[1]?.parentElement?.className).not.toContain("aspect-video");

  act(() => {
    named(dialog, "Discuss")?.click();
  });

  expect(tileTexts(dialog)).toEqual(["Decision recordOptions and a verdict."]);
  expect(tabTexts(dialog)).toEqual(["Built in 1", "Server 1", "Mine 0"]);

  const rail = (): string => dialog.querySelector("aside")?.textContent ?? "";

  expect(rail()).toContain("Decision record");
  expect(rail()).toContain("Markdown · Discuss");
  expect(rail()).not.toContain("Design system");
  expect(rail()).toContain("Pi will be toldAsk which decision this records.");
  expect(rail()).toContain("Filesdecision.md");

  act(() => {
    named(dialog, "Start with Pi in a new Session…")?.click();
  });

  expect(newSessions).toEqual([
    {
      text: "Start from the Decision record template.",
      attachments: [
        {
          key: "template:decision-record",
          icon: "file-text",
          title: "Decision record",
          detail: "template · Markdown",
          text: 'The template "Decision record" (decision-record): start from it with start_artifact, then follow its instructions.',
        },
      ],
    },
  ]);

  expect(pickerDialog()).toBeUndefined();
});

test("the picker's search counts each tab's matches, says where the others are, and keeps the rail in place", async () => {
  const page = templatesPage(servingTemplates(someTemplates));
  const dialog = await openPicker(page);

  // Descriptions match too.
  typeIn(
    dialog.querySelector<HTMLInputElement>("input[type=search]"),
    "impact",
  );

  await drawn(() => tabTexts(dialog)[0] === "Built in 0");

  expect(tabTexts(dialog)).toEqual(["Built in 0", "Server 1", "Mine 0"]);
  expect(tileInputs(dialog)).toEqual([]);

  expect(dialog.textContent).toContain(
    "Nothing matches here. Server has some.",
  );

  expect(dialog.querySelector("aside")?.textContent).toContain(
    "No template picked",
  );

  act(() => {
    named(dialog, "Server 1")?.click();
  });

  expect(tileTexts(dialog)).toEqual([
    "Our reviewTimeline, impact and follow-ups.",
  ]);

  expect(dialog.querySelector("aside")?.textContent).toContain("saved by Ana");

  act(() => {
    named(dialog, "Mine 0")?.click();
  });

  typeIn(dialog.querySelector<HTMLInputElement>("input[type=search]"), "");

  await drawn(() => tabTexts(dialog)[0] === "Built in 2");

  expect(dialog.textContent).toContain(
    "Save an artifact as a template from its More menu, and it shows here.",
  );
});

test("a template of the person's own goes only with their own work, not the team's", async () => {
  const page = templatesPage(
    servingTemplates([
      ...someTemplates,
      template({ id: "t2", name: "Rollout", scope: "mine", type: "markdown" }),
    ]),
  );

  const dialog = await openPicker(page);

  act(() => {
    named(dialog, "Mine 1")?.click();
  });

  expect(dialog.querySelector("aside")?.textContent).toContain(
    "Yours alone, so it starts your own work, not the team's.",
  );

  act(() => {
    named(dialog, "Start with Pi in a new Session…")?.click();
  });

  expect(newSessions.map(({ attachments }) => attachments)).toMatchObject([
    [{ key: "template:t2", personal: true }],
  ]);
});

test("the blank tile opens the New session composer empty", async () => {
  const page = templatesPage(servingTemplates(someTemplates));
  const dialog = await openPicker(page);

  act(() => {
    tileInputs(dialog).at(-1)?.click();
  });

  expect(dialog.querySelector("aside")?.getAttribute("aria-label")).toBe(
    "Blank",
  );

  act(() => {
    named(dialog, "Start with Pi in a new Session…")?.click();
  });

  expect(newSessions).toEqual([{ text: "", attachments: [] }]);
});

test("the picker says why its templates didn't load, and loads them again on Retry", async () => {
  let failing = true;

  const page = templatesPage(async (url, init) => {
    if (url.endsWith("/templates") && failing) {
      await Promise.resolve();

      return Response.json({ message: "Down for a moment" }, { status: 500 });
    }

    return servingTemplates(someTemplates)(url, init);
  });

  act(() => {
    named(page, "New")?.click();
  });

  await drawn(() => (pickerDialog()?.textContent ?? "").includes("Retry"));

  const dialog = pickerDialog() ?? page;

  expect(dialog.textContent).toContain("Couldn't load the templates.");
  expect(named(page, "New")).toBeDefined();

  failing = false;

  act(() => {
    named(dialog, "Retry")?.click();
  });

  await drawn(() => tileInputs(dialog).length === 3);
});

test("what Pi will be told shows whole once asked", async () => {
  const long = `${"Ask who the audience is. ".repeat(20)}End.`;

  const page = templatesPage(
    servingTemplates([template({ instructions: long })]),
  );

  const dialog = await openPicker(page);
  const showAll = named(dialog, "Show all");

  expect(showAll?.getAttribute("aria-expanded")).toBe("false");

  act(() => {
    showAll?.click();
  });

  expect(named(dialog, "Show less")?.getAttribute("aria-expanded")).toBe(
    "true",
  );

  expect(dialog.querySelector("aside")?.textContent).toContain(long);
});

test("Start blank makes the person's own artifact from a Markdown template and opens it, and is off for the others", async () => {
  const asked: Served[] = [];
  const page = templatesPage(servingTemplates(someTemplates, asked));
  const dialog = await openPicker(page);

  expect(named(dialog, "Start blank and edit myself")?.disabled).toBe(true);

  expect(dialog.textContent).toContain(
    "Only Pi edits pages, slides and canvases",
  );

  act(() => {
    named(dialog, "Server 1")?.click();
  });

  expect(dialog.querySelector("aside")?.textContent).toContain(
    "Its files are an example to write from.",
  );

  await act(async () => {
    named(dialog, "Start blank and edit myself")?.click();
    await until(() => location.hash.includes("artifact=a9"));
  });

  expect(asked.at(-1)).toMatchObject({
    url: "/api/ext/artifacts/templates/t1/start",
    method: "POST",
    body: { title: "Our review" },
  });

  expect(location.hash).toBe("#plugin/artifacts?artifact=a9");
});

function plusMenu(
  fetch: (url: string, init?: RequestInit) => Promise<Response>,
  sent: string[] = [],
): MountedSession {
  const Fill = web.slots?.["session.attach"];

  const mounted = {
    ...sessionWith({}),
    send: async (text: string) => {
      await Promise.resolve();
      sent.push(text);
    },
  };

  const attachSlots = {
    attach: () =>
      Fill === undefined ? null : (
        <AttachMenu label="Attach files" onFiles={() => undefined}>
          <Fill session={mounted} add={() => undefined} />
        </AttachMenu>
      ),
  };

  renderPart({ ...web, slots: attachSlots }, "attach", {}, { fetch });

  act(() => {
    document
      .querySelector<HTMLButtonElement>("button[aria-label='Attach files']")
      ?.click();
  });

  act(() => {
    [...document.querySelectorAll<HTMLButtonElement>("[role=group] button")]
      .find((each) => each.textContent === "Start from template…")
      ?.click();
  });

  return mounted;
}

test("in team work, the + menu's templates leave out the person's own, which its Pi can't start from", async () => {
  const mine = template({ id: "t2", name: "Mine", scope: "mine" });
  const asked: Served[] = [];

  const mounted = plusMenu(
    servingTemplates([...someTemplates, mine], asked, false),
  );

  await drawn(() => tileInputs(pickerDialog() ?? document).length > 0);

  expect(asked.find(({ url }) => url.includes("/templates"))?.url).toBe(
    `/api/ext/artifacts/templates?session=${mounted.id}`,
  );

  expect(tabTexts(pickerDialog() ?? document)).toEqual([
    "Built in 2",
    "Server 1",
  ]);
});

test("the + menu's Start from template puts the picked one in this Session's composer, in the person's words", async () => {
  const sent: string[] = [];
  const before = drafts.length;
  const mounted = plusMenu(servingTemplates(someTemplates), sent);

  await drawn(() => tileInputs(pickerDialog() ?? document).length > 0);

  const dialog = pickerDialog() ?? document.body;

  expect(named(dialog, "Start blank and edit myself")).toBeUndefined();
  expect(tileTexts(dialog)).toHaveLength(2);
  expect(tabTexts(dialog)).toEqual(["Built in 2", "Server 1", "Mine 0"]);

  act(() => {
    named(dialog, "Start with Pi in this Session…")?.click();
  });

  expect(sent).toEqual([]);

  expect(drafts.slice(before)).toEqual([
    {
      sessionId: mounted.id,
      text: "Start from the Slide deck template.",
      attachments: [
        {
          key: "template:slide-deck",
          icon: "file-text",
          title: "Slide deck",
          detail: "template · Slides",
          text: 'The template "Slide deck" (slide-deck): start from it with start_artifact, then follow its instructions.',
        },
      ],
    },
  ]);
});

async function saveDialog(
  page: HTMLElement,
  asked: Served[],
): Promise<HTMLDialogElement | undefined> {
  await opened(asked);

  act(() => {
    named(page, "More")?.click();
  });

  act(() => {
    item(page, "Save as template")?.click();
  });

  return [...page.querySelectorAll("dialog")].find((each) =>
    each.textContent.includes("What the template keeps"),
  );
}

function keepsOf(root: ParentNode): { checked: boolean; disabled: boolean }[] {
  return [...root.querySelectorAll<HTMLInputElement>("input[name=keeps]")].map(
    ({ checked, disabled }) => ({ checked, disabled }),
  );
}

test("Save as template keeps the structure through Pi or everything as an example, for the person or, by an admin, the server", async () => {
  for (const admin of [false, true]) {
    const asked: Served[] = [];

    const page = renderPart(
      web,
      "overlay",
      {},
      {
        admin,
        hash: "#session-1?artifact=a1",
        fetch: serving(
          {
            ...artifact({ title: "Checkout latency", kind: "markdown" }),
            ...viewed(1),
            askable: true,
            ownSession: true,
          },
          asked,
        ),
      },
    );

    const dialog = (await saveDialog(page, asked)) ?? page;

    expect(dialog.textContent).toContain("From “Checkout latency” · Markdown");

    expect(keepsOf(dialog)).toEqual([
      { checked: true, disabled: false },
      { checked: false, disabled: false },
    ]);

    // What it's for picks as the New picker filters.
    expect(
      [
        ...dialog.querySelectorAll<HTMLButtonElement>(
          "[role=group][aria-label=For] button",
        ),
      ].map(
        (each) =>
          `${each.textContent}${each.getAttribute("aria-pressed") ?? ""}`,
      ),
    ).toEqual(["Presentfalse", "Discusstrue", "Designfalse", "Reportfalse"]);

    act(() => {
      named(dialog, "Report")?.click();
    });

    expect(named(dialog, "Everyone on the server") !== undefined).toBe(admin);

    if (admin) {
      act(() => {
        named(dialog, "Everyone on the server")?.click();
      });
    } else {
      expect(dialog.textContent).toContain(
        "Only admins share a template with everyone on the server.",
      );
    }

    act(() => {
      dialog
        .querySelectorAll<HTMLInputElement>("input[name=keeps]")[1]
        ?.click();
    });

    await act(async () => {
      named(dialog, "Save template")?.click();
      await until(() => asked.some(({ method }) => method === "POST"));
    });

    expect(asked.find(({ method }) => method === "POST")).toEqual({
      url: "/api/ext/artifacts/artifacts/a1/template",
      method: "POST",
      body: {
        name: "Checkout latency",
        for: "report",
        instructions: "",
        scope: admin ? "server" : "mine",
        keeps: "example",
      },
    });
  }
});

test("Save as template keeps everything when Pi can't make the structure for the person, and says why", async () => {
  // Gone, and someone else's Session.
  for (const askable of [false, true]) {
    const asked: Served[] = [];

    const page = renderPart(
      web,
      "overlay",
      {},
      {
        hash: "#session-1?artifact=a1",
        fetch: serving(
          {
            ...artifact({ title: "Plan", kind: "markdown" }),
            ...viewed(1),
            askable,
            ownSession: false,
          },
          asked,
        ),
      },
    );

    const dialog = (await saveDialog(page, asked)) ?? page;

    expect(keepsOf(dialog)).toEqual([
      { checked: false, disabled: true },
      { checked: true, disabled: false },
    ]);

    expect(dialog.textContent).toContain("for the person whose Session it is");
  }
});

function settingsOf(
  o: object,
  templates: readonly Template[] | undefined,
  asked: Served[],
): (url: string, init?: RequestInit) => Promise<Response> {
  const shown = serving(o, asked);

  return async (url, init) => {
    if (url.endsWith("/templates")) {
      await Promise.resolve();

      return templates === undefined
        ? Response.json({ message: "Down" }, { status: 500 })
        : Response.json({ templates });
    }

    return shown(url, init);
  };
}

test("Template settings change a template its person steers, and aren't offered on others", async () => {
  const mine = template({
    id: "a1",
    name: "Our review",
    description: "Timeline first.",
    type: "markdown",
    for: "discuss",
    scope: "mine",
    instructions: "UTC.",
  });

  const shown = (access: string, marked: boolean) => ({
    ...artifact({
      title: "Our review",
      kind: "markdown",
      sessionId: null,
      template: marked ? { scope: "mine", for: "discuss" } : null,
    }),
    ...viewed(1),
    access,
    askable: false,
    ownSession: false,
  });

  for (const [access, marked] of [
    ["view", true],
    ["steer", false],
  ] as const) {
    const asked: Served[] = [];

    const page = renderPart(
      web,
      "overlay",
      {},
      {
        hash: "#session-1?artifact=a1",
        fetch: settingsOf(shown(access, marked), [mine], asked),
      },
    );

    await opened(asked);

    act(() => {
      named(page, "More")?.click();
    });

    expect(item(page, "Template settings")).toBeUndefined();
  }

  const asked: Served[] = [];

  const page = renderPart(
    web,
    "overlay",
    {},
    {
      hash: "#session-1?artifact=a1",
      fetch: settingsOf(shown("steer", true), [mine], asked),
    },
  );

  await opened(asked);

  act(() => {
    named(page, "More")?.click();
  });

  act(() => {
    item(page, "Template settings")?.click();
  });

  await drawn(() => named(page, "Save") !== undefined);

  const dialog =
    [...page.querySelectorAll("dialog")].find((each) =>
      each.textContent.includes("Template settings"),
    ) ?? page;

  expect(dialog.querySelectorAll("input[name=keeps]")).toHaveLength(0);

  typeIn(
    [...dialog.querySelectorAll<HTMLInputElement>("input")].find(
      ({ value }) => value === "Timeline first.",
    ),
    "",
  );

  await act(async () => {
    named(dialog, "Save")?.click();
    await until(() => asked.some(({ method }) => method === "PUT"));
  });

  expect(asked.find(({ method }) => method === "PUT")).toEqual({
    url: "/api/ext/artifacts/artifacts/a1/template",
    method: "PUT",
    body: {
      name: "Our review",
      for: "discuss",
      description: "",
      instructions: "UTC.",
    },
  });
});

test("Template settings say when the template is gone, and offer Retry when the templates don't load", async () => {
  for (const templates of [[], undefined]) {
    const asked: Served[] = [];

    const page = renderPart(
      web,
      "overlay",
      {},
      {
        hash: "#session-1?artifact=a1",
        fetch: settingsOf(
          {
            ...artifact({
              kind: "markdown",
              sessionId: null,
              template: { scope: "mine", for: "discuss" },
            }),
            ...viewed(1),
            askable: false,
            ownSession: false,
          },
          templates,
          asked,
        ),
      },
    );

    await opened(asked);

    act(() => {
      named(page, "More")?.click();
    });

    act(() => {
      item(page, "Template settings")?.click();
    });

    const said =
      templates === undefined ? "Couldn't load the templates." : "is gone";

    await drawn(() => page.textContent.includes(said));

    expect(named(page, "Retry") !== undefined).toBe(templates === undefined);
  }
});

test("a template shows its tag in the gallery, which can show only templates", async () => {
  const asked: Served[] = [];

  const page = renderPart(
    { ...web, slots },
    "page",
    { path: "" },
    {
      hash: "#plugin/artifacts",
      fetch: async (url) => {
        await Promise.resolve();

        asked.push({ url, method: "GET" });

        return Response.json({
          artifacts: [
            artifact({
              id: "a1",
              title: "Our review",
              kind: "markdown",
              sessionId: null,
              template: { scope: "mine", for: "discuss" },
            }),
            artifact({ id: "a2", title: "Checkout latency" }),
          ],
        });
      },
    },
  );

  await drawn(
    () => page.querySelectorAll("ul[aria-label=Artifacts] li").length === 2,
  );

  const cards = (): string[] =>
    [...page.querySelectorAll("ul[aria-label=Artifacts] li")].map(
      (each) => each.textContent,
    );

  expect(cards()[0]).toContain("Our reviewTemplate");
  expect(cards()[0]).toContain("Markdown · v1 · only you");
  expect(cards()[1]).not.toContain("Template");

  act(() => {
    named(page, "Templates")?.click();
  });

  expect(cards()).toHaveLength(1);
});

test("Pi starting from a template shows in the chat as one row with what it copied", () => {
  const page = renderPart(web, "session.toolCall:start_artifact", {
    session: sessionWith({}),
    call: {
      id: "call-1",
      name: "start_artifact",
      args: { template: "slide-deck", title: "Webhooks v2" },
      status: "done",
      result: {
        text: "Copied",
        details: {
          template: "Slide deck",
          folder: "/s/plugins/artifacts/webhooks-v2",
          entry: "deck.html",
          files: 2,
        },
        failed: false,
      },
    },
  });

  expect(page.textContent).toBe(
    "Started from template Slide deck · 2 files in webhooks-v2",
  );
});

const deckSlides = [
  {
    selector: "body > section:nth-of-type(1)",
    title: "Webhooks v2",
    notes: "Say who you are.",
    steps: 0,
  },
  {
    selector: "body > section:nth-of-type(2)",
    title: "Retries moved off the request path",
    notes: "Lead with the p95.",
    steps: 2,
  },
  {
    selector: "body > section:nth-of-type(3)",
    title: "Questions",
    notes: "",
    steps: 0,
  },
];

function deckArtifact(o: object = {}) {
  return {
    ...artifact({ title: "Webhooks v2", type: "slides", living: true }),
    ...viewed(1),
    askable: true,
    ...o,
  };
}

function deckFrame(page: HTMLElement, version = 1): ReturnType<typeof frameOf> {
  const frame = page.querySelector<HTMLIFrameElement>(
    `iframe[src$='/view?v=${String(version)}']:not([aria-hidden])`,
  );

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

function shownSlide(frame: ReturnType<typeof frameOf>): unknown {
  return frame
    .told()
    .filter((each) => each.pipoca === "slide")
    .at(-1);
}

// Keeps what runs every 20 seconds, the heartbeats, to run them at once.
function beatsOf(every: (() => void)[]): { restore: () => void } {
  const interval = globalThis.setInterval;

  globalThis.setInterval = ((run: () => void, ms?: number) => {
    if (ms === 20_000) {
      every.push(run);
    }

    return interval(run, ms);
  }) as typeof setInterval;

  return {
    restore: () => {
      globalThis.setInterval = interval;
    },
  };
}

function pressKey(
  key: string,
  on: Element = document.activeElement ?? document.body,
  held: KeyboardEventInit = {},
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...held,
  });

  act(() => {
    on.dispatchEvent(event);
  });

  return event;
}

test("a deck shows one slide at a time with a rail of its slides and the notes under it, and keys and clicks step through its builds", async () => {
  const asked: Served[] = [];

  const page = renderPart(
    web,
    "overlay",
    {},
    {
      hash: "#session-1?artifact=a1",
      fetch: serving(deckArtifact(), asked, {
        comments: () => [
          thread({
            id: "t1",
            version: 1,
            quote: "Slide 2",
            element: "body > section:nth-of-type(2)",
            body: "Is that with the queue on?",
          }),
        ],
      }),
    },
  );

  await opened(asked);

  const frame = deckFrame(page);

  frame.tell({ pipoca: "deck", slides: deckSlides });

  const rail = (): HTMLButtonElement[] => [
    ...page.querySelectorAll<HTMLButtonElement>(
      "nav[aria-label=Slides] button",
    ),
  ];

  const notes = (): string =>
    page.querySelector("section[aria-label='Speaker notes'] p")?.textContent ??
    "";

  expect(rail().map((each) => each.getAttribute("aria-label"))).toEqual([
    "Slide 1 · Webhooks v2",
    "Slide 2 · Retries moved off the request path",
    "Slide 3 · Questions",
  ]);

  expect(rail()[0]?.getAttribute("aria-current")).toBe("true");
  expect(page.textContent).toContain("Slides · 3 slides");
  expect(notes()).toBe("Say who you are.");

  expect(
    [...page.querySelectorAll("nav[aria-label=Slides] iframe")].map((each) =>
      each.getAttribute("src"),
    ),
  ).toEqual(
    [0, 1, 2].map(
      (n) => `/api/ext/artifacts/artifacts/a1/view?v=1#slide=${String(n)}`,
    ),
  );

  expect(shownSlide(frame)).toEqual({ pipoca: "slide", slide: 0, step: 0 });

  pressKey("ArrowRight");

  expect(shownSlide(frame)).toEqual({ pipoca: "slide", slide: 1, step: 0 });
  expect(notes()).toBe("Lead with the p95.");
  expect(rail()[1]?.getAttribute("aria-current")).toBe("true");

  pressKey("ArrowRight");
  expect(shownSlide(frame)).toEqual({ pipoca: "slide", slide: 1, step: 1 });

  frame.tell({ pipoca: "key", key: "ArrowRight" });
  expect(shownSlide(frame)).toEqual({ pipoca: "slide", slide: 1, step: 2 });

  pressKey("ArrowRight");
  expect(shownSlide(frame)).toEqual({ pipoca: "slide", slide: 2, step: 0 });
  expect(notes()).toBe("This slide has no notes.");

  pressKey("ArrowLeft");
  expect(shownSlide(frame)).toEqual({ pipoca: "slide", slide: 1, step: 2 });

  pressKey("End");
  expect(shownSlide(frame)).toEqual({ pipoca: "slide", slide: 2, step: 0 });

  act(() => {
    rail()[0]?.click();
  });

  expect(shownSlide(frame)).toEqual({ pipoca: "slide", slide: 0, step: 0 });

  const field = document.createElement("input");
  page.append(field);

  act(() => {
    field.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
  });

  expect(shownSlide(frame)).toEqual({ pipoca: "slide", slide: 0, step: 0 });

  frame.tell({ pipoca: "pinned", pins: [{ n: 1, slide: 1 }] });

  expect(rail()[1]?.querySelector("[aria-label='1 comment']")).not.toBeNull();

  commentMode(page);
  await drawn(() => page.textContent.includes("Is that with the queue on?"));

  act(() => {
    [...page.querySelectorAll("aside[aria-label=Comments] button")]
      .find((each) => each.textContent.includes("Is that with the queue on?"))
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });

  expect(shownSlide(frame)).toEqual({ pipoca: "slide", slide: 1, step: 2 });
});

test("another version of a deck shows its own slides and pins, not the ones the last version reported", async () => {
  const asked: Served[] = [];

  const page = renderPart(
    web,
    "overlay",
    {},
    {
      hash: "#session-1?artifact=a1",
      fetch: serving(deckArtifact({ ...viewed(2), versions: 2 }), asked),
    },
  );

  await opened(asked);

  const rail = (): string[] =>
    [...page.querySelectorAll("nav[aria-label=Slides] button")].map(
      (each) => each.textContent,
    );

  const newer = deckFrame(page, 2);

  newer.tell({ pipoca: "deck", slides: deckSlides });
  newer.tell({ pipoca: "pinned", pins: [{ n: 1, slide: 1 }] });

  expect(rail()).toEqual(["1", "21", "3"]);

  act(() => {
    history.replaceState(null, "", "#session-1?artifact=a1&v=1");
    dispatchEvent(new HashChangeEvent("hashchange"));
  });

  await drawn(() => page.querySelector("iframe[src$='/view?v=1']") !== null);

  expect(rail()).toEqual([]);

  deckFrame(page, 1).tell({ pipoca: "deck", slides: deckSlides.slice(0, 2) });

  expect(rail()).toEqual(["1", "2"]);
});

test("keys move a deck only from inside its viewer, and not while someone types, uses a menu or holds a modifier", async () => {
  const asked: Served[] = [];

  const page = renderPart(
    web,
    "overlay",
    {},
    {
      hash: "#session-1?artifact=a1",
      fetch: serving(deckArtifact(), asked),
    },
  );

  await opened(asked);

  const frame = deckFrame(page);
  const notes = page.querySelector("section[aria-label='Speaker notes']");

  if (notes === null) {
    throw new Error("no notes");
  }

  const none = pressKey("ArrowRight", notes);

  expect(none.defaultPrevented).toBe(false);

  frame.tell({
    pipoca: "deck",
    slides: [...deckSlides.slice(0, 2), { ...deckSlides[2], steps: 1 }],
  });

  const at = (): unknown => {
    const { slide, step } = shownSlide(frame) as {
      slide: number;
      step: number;
    };

    return [slide, step];
  };

  expect(pressKey("End", notes).defaultPrevented).toBe(true);
  expect(at()).toEqual([2, 1]);

  pressKey("Home", notes);
  expect(at()).toEqual([0, 0]);

  for (const [key, then] of [
    ["ArrowDown", [1, 0]],
    ["PageDown", [1, 1]],
    [" ", [1, 2]],
    ["ArrowUp", [1, 1]],
    ["PageUp", [1, 0]],
  ] as const) {
    pressKey(key, notes);
    expect(at()).toEqual(then);
  }

  frame.tell({ pipoca: "key", key: "click" });
  expect(at()).toEqual([1, 1]);

  pressKey("ArrowRight", notes, { metaKey: true });
  pressKey("ArrowRight", notes, { ctrlKey: true });
  expect(at()).toEqual([1, 1]);

  const button = named(page, "All slides");

  if (button === undefined) {
    throw new Error("no All slides");
  }

  expect(pressKey(" ", button).defaultPrevented).toBe(false);
  expect(at()).toEqual([1, 1]);

  const outside = document.createElement("div");

  document.body.append(outside);
  expect(pressKey("ArrowRight", outside).defaultPrevented).toBe(false);
  expect(at()).toEqual([1, 1]);
  outside.remove();

  const field = document.createElement("textarea");

  notes.append(field);
  pressKey("ArrowRight", field);
  expect(at()).toEqual([1, 1]);
  field.remove();

  act(() => {
    named(page, "More")?.click();
  });

  const menu = page.querySelector("[role=menu]");

  if (menu === null) {
    throw new Error("no menu");
  }

  pressKey("ArrowDown", menu);
  expect(at()).toEqual([1, 1]);

  pressKey("Escape", menu);

  frame.tell({ pipoca: "key", key: "ArrowRight" });
  expect(at()).toEqual([1, 2]);

  pressKey("ArrowRight", notes);
  expect(at()).toEqual([2, 0]);

  frame.tell({ pipoca: "deck", slides: deckSlides.slice(0, 1) });
  expect(at()).toEqual([0, 0]);
});

test("the grid shows every slide, and asking Pi about one, moving, duplicating or deleting it, or a new slide, are comments sent to Pi", async () => {
  const asked: Served[] = [];

  const page = renderPart(
    web,
    "overlay",
    {},
    {
      hash: "#session-1?artifact=a1",
      fetch: serving(deckArtifact(), asked),
    },
  );

  await opened(asked);

  const frame = deckFrame(page);

  frame.tell({ pipoca: "deck", slides: deckSlides });
  frame.tell({ pipoca: "pinned", pins: [{ n: 1, slide: 1 }] });
  pressKey("ArrowRight", page.querySelector("nav[aria-label=Slides]") ?? page);
  pressKey("ArrowRight", page.querySelector("nav[aria-label=Slides]") ?? page);

  act(() => {
    named(page, "All slides")?.click();
  });

  const grid = (): HTMLElement | null =>
    page.querySelector("ul[aria-label='All slides']");

  const captions = (): string[] =>
    [...(grid()?.querySelectorAll(":scope > li") ?? [])].map(
      (each) => each.textContent,
    );

  expect(captions()).toEqual([
    "1 · Webhooks v2",
    "1 comment · 2 · Retries moved off the request path",
    "3 · Questions",
    "Ask Pi for a slide",
  ]);

  expect(page.textContent).toContain("3 slides · drag to reorder");

  pressKey("ArrowRight", grid() ?? page);

  expect(page.textContent).toContain("Back to slide 2");

  const reporter = page.querySelector<HTMLIFrameElement>(
    "iframe[aria-hidden][src$='/view?v=1']:not([title^='Slide'])",
  );

  expect(reporter?.getAttribute("tabindex")).toBe("-1");

  act(() => {
    dispatchEvent(
      new MessageEvent("message", {
        data: {
          pipoca: "deck",
          slides: [...deckSlides, { ...deckSlides[2], title: "Thanks" }],
        },
        source: reporter?.contentWindow ?? null,
      }),
    );
  });

  expect(captions().at(-2)).toBe("4 · Thanks");

  const sent = (): unknown[] =>
    asked
      .filter(
        ({ method, url }) => method === "POST" && url.endsWith("/comments"),
      )
      .map(({ body }) => body);

  const choose = async (slide: string, label: string): Promise<void> => {
    act(() => {
      named(page, `${slide}, ask Pi`)?.click();
    });

    const before = sent().length;

    act(() => {
      item(page, label)?.click();
    });

    await drawn(() => sent().length > before);
  };

  await choose(
    "Slide 2 · Retries moved off the request path",
    "Make it shorter",
  );

  expect(sent().at(-1)).toEqual({
    version: 1,
    body: "Make this slide shorter.",
    toPi: true,
    quote: "Slide 2 · Retries moved off the request path",
    element: "body > section:nth-of-type(2)",
  });

  await drawn(
    () => page.querySelector("[role=status]")?.textContent === "Sent to Pi",
  );

  await choose("Slide 2 · Retries moved off the request path", "Move later");

  expect(sent().at(-1)).toMatchObject({
    body: "Move this slide so it becomes slide 3.",
  });

  await choose("Slide 1 · Webhooks v2", "Duplicate");

  expect(sent().at(-1)).toMatchObject({
    body: "Duplicate this slide, right after it.",
    element: "body > section:nth-of-type(1)",
  });

  act(() => {
    named(page, "Slide 3 · Questions, ask Pi")?.click();
  });

  act(() => {
    item(page, "Delete slide")?.click();
  });

  const deleting = sent().length;

  await act(async () => {
    asking(page, "Ask Pi to delete slide 3?", "Cancel");
    await Promise.resolve();
  });

  expect(sent()).toHaveLength(deleting);

  act(() => {
    named(page, "Slide 3 · Questions, ask Pi")?.click();
  });

  act(() => {
    item(page, "Delete slide")?.click();
  });

  await act(async () => {
    asking(page, "Ask Pi to delete slide 3?", "Ask Pi to delete it");
    await until(() => sent().length > deleting);
  });

  expect(sent().at(-1)).toMatchObject({ body: "Delete this slide." });

  await choose("Slide 2 · Retries moved off the request path", "Move earlier");

  expect(sent().at(-1)).toMatchObject({
    body: "Move this slide so it becomes slide 1.",
  });

  const dragged = (from: number, to: number): void => {
    const slides = [...(grid()?.querySelectorAll(":scope > li") ?? [])];

    const drag = (type: string): Event => {
      const event = new Event(type, { bubbles: true, cancelable: true });

      Object.defineProperty(event, "dataTransfer", {
        value: { effectAllowed: "" },
      });

      return event;
    };

    act(() => {
      slides[from]?.dispatchEvent(drag("dragstart"));
    });

    act(() => {
      slides[to]?.dispatchEvent(drag("drop"));
    });
  };

  const dropping = sent().length;

  dragged(0, 2);
  await drawn(() => sent().length > dropping);

  expect(sent().at(-1)).toMatchObject({
    body: "Move this slide so it becomes slide 3.",
    element: "body > section:nth-of-type(1)",
  });

  act(() => {
    named(page, "Slide 1 · Webhooks v2, ask Pi")?.click();
  });

  expect(item(page, "Move earlier")).toBeUndefined();
  expect(item(page, "Move later")).not.toBeUndefined();

  act(() => {
    named(page, "Ask Pi for a slide")?.click();
  });

  typeInto(
    document.querySelector("dialog[open] textarea"),
    "The rollback plan",
  );

  const before = sent().length;

  await act(async () => {
    document
      .querySelector<HTMLFormElement>("dialog[open] form")
      ?.requestSubmit();

    await until(() => sent().length > before);
  });

  expect(sent().at(-1)).toEqual({
    version: 1,
    body: "Add a slide at the end: The rollback plan",
    toPi: true,
  });

  act(() => {
    named(page, "Open Slide 2 · Retries moved off the request path")?.click();
  });

  expect(grid()).toBeNull();

  const back = deckFrame(page);

  act(() => {
    page
      .querySelector("iframe[src$='/view?v=1']:not([aria-hidden])")
      ?.dispatchEvent(new Event("load"));
  });

  expect(shownSlide(back)).toEqual({ pipoca: "slide", slide: 1, step: 1 });

  act(() => {
    named(page, "All slides")?.click();
  });

  act(() => {
    named(page, "Open Slide 3 · Questions")?.click();
  });

  expect(
    page
      .querySelector("nav[aria-label=Slides] button[aria-current]")
      ?.getAttribute("aria-label"),
  ).toBe("Slide 3 · Questions");
});

test("only people who can ask Pi get the grid's requests, and Export prints the deck with or without its notes", async () => {
  const asked: Served[] = [];

  const page = renderPart(
    web,
    "overlay",
    {},
    {
      hash: "#session-1?artifact=a1",
      fetch: serving(
        deckArtifact({ askable: false, access: "comment" }),
        asked,
      ),
    },
  );

  await opened(asked);
  deckFrame(page).tell({ pipoca: "deck", slides: deckSlides });

  act(() => {
    named(page, "All slides")?.click();
  });

  expect(page.textContent).toContain("3 slides");
  expect(page.textContent).not.toContain("drag to reorder");
  expect(page.textContent).not.toContain("Ask Pi for a slide");
  expect(named(page, "Slide 1 · Webhooks v2, ask Pi")).toBeUndefined();

  const job = (title: string) => {
    const frame = page.querySelector<HTMLIFrameElement>(
      `iframe[title='${title}']`,
    );

    const posted: unknown[] = [];

    if (frame?.contentWindow !== null && frame?.contentWindow !== undefined) {
      frame.contentWindow.postMessage = (data: unknown) => {
        posted.push(data);
      };
    }

    act(() => {
      frame?.dispatchEvent(new Event("load"));
    });

    return {
      src: frame?.getAttribute("src"),
      posted,
      say: (data: unknown, from = frame?.contentWindow ?? null) => {
        act(() => {
          dispatchEvent(new MessageEvent("message", { data, source: from }));
        });
      },
      gone: () => page.querySelector(`iframe[title='${title}']`) === null,
    };
  };

  const exporting = (label: string): void => {
    act(() => {
      named(page, "Export")?.click();
    });

    act(() => {
      item(page, label)?.click();
    });
  };

  act(() => {
    named(page, "Export")?.click();
  });

  expect(menuItems(page).map((each) => each.textContent)).toEqual([
    "PDF, one page per slide",
    "PDF with speaker notes",
    "PNG of this slide",
    "PowerPoint (not planned)",
  ]);

  expect(
    item(page, "PowerPoint (not planned)")?.getAttribute("aria-disabled"),
  ).toBe("true");

  act(() => {
    item(page, "PDF with speaker notes")?.click();
  });

  const notes = job("Printing the deck");

  expect(notes.src).toBe("/api/ext/artifacts/artifacts/a1/view?v=1");
  expect(notes.posted).toEqual([{ pipoca: "print", notes: true }]);

  notes.say({ pipoca: "printed" }, window);
  expect(notes.gone()).toBe(false);

  notes.say({ pipoca: "printed" });
  expect(notes.gone()).toBe(true);

  exporting("PDF, one page per slide");

  const plain = job("Printing the deck");

  expect(plain.posted).toEqual([{ pipoca: "print", notes: false }]);

  plain.say({ pipoca: "printed" });

  act(() => {
    named(page, "Back to slide 1")?.click();
  });

  pressKey("ArrowRight", page.querySelector("nav[aria-label=Slides]") ?? page);

  act(() => {
    named(page, "All slides")?.click();
  });

  const saved: { href: string; download: string }[] = [];

  // Saving makes a link and clicks it, which the page would follow.
  Object.defineProperty(HTMLAnchorElement.prototype, "click", {
    configurable: true,
    value(this: HTMLAnchorElement) {
      saved.push({ href: this.href, download: this.download });
    },
  });

  try {
    exporting("PNG of this slide");

    const png = job("Drawing the slide");

    expect(png.src).toBe("/api/ext/artifacts/artifacts/a1/view?v=1#slide=1");
    expect(png.posted).toEqual([{ pipoca: "png" }]);

    act(() => {
      named(page, "Export")?.click();
    });

    expect(item(page, "PNG of this slide")?.getAttribute("aria-disabled")).toBe(
      "true",
    );

    act(() => {
      named(page, "Export")?.click();
    });

    png.say({ pipoca: "png", url: "data:image/png;base64,iVBORw0KGgoAAAAA" });

    expect(
      saved.map(({ href, download }) => [href.slice(0, 5), download]),
    ).toEqual([["blob:", "Webhooks v2 slide 2.png"]]);

    expect(png.gone()).toBe(true);

    exporting("PNG of this slide");

    job("Drawing the slide").say({
      pipoca: "png",
      url: "javascript:alert(1)",
    });

    expect(saved).toHaveLength(1);

    expect(page.textContent).toContain(
      "The slide couldn't be drawn as a picture.",
    );

    exporting("PNG of this slide");
    job("Drawing the slide").say({ pipoca: "png", error: "Needs a host." });

    expect(page.textContent).toContain("Needs a host.");

    const refused = (url: string, said: string): void => {
      exporting("PNG of this slide");

      const drawing = job("Drawing the slide");

      drawing.say({ pipoca: "png", url });

      expect(page.textContent).toContain(said);
      expect(drawing.gone()).toBe(true);
    };

    refused(
      "data:image/png;base64,@@@@",
      "The picture of the slide didn't decode.",
    );

    refused(
      "data:image/png;base64,R0lGODlhAQ==",
      "The picture of the slide isn't a PNG.",
    );

    refused(
      `data:image/png;base64,iVBORw0KGgo${"A".repeat(28_000_000)}`,
      "The picture of the slide is over 20 MB.",
    );

    expect(saved).toHaveLength(1);
  } finally {
    Reflect.deleteProperty(HTMLAnchorElement.prototype, "click");
  }
});

test("a picture of a slide that never comes stops after a while, so Export works again", async () => {
  const asked: Served[] = [];

  const page = renderPart(
    web,
    "overlay",
    {},
    {
      hash: "#session-1?artifact=a1",
      fetch: serving(deckArtifact(), asked),
    },
  );

  await opened(asked);
  deckFrame(page).tell({ pipoca: "deck", slides: deckSlides });

  const later: (() => void)[] = [];
  const timeout = globalThis.setTimeout;

  globalThis.setTimeout = ((run: () => void, ms?: number) => {
    if (ms === 30_000) {
      later.push(run);
    }

    return timeout(run, ms);
  }) as typeof setTimeout;

  try {
    act(() => {
      named(page, "More")?.click();
    });

    act(() => {
      item(page, "Export slide as PNG")?.click();
    });

    expect(
      page.querySelector("iframe[title='Drawing the slide']"),
    ).not.toBeNull();

    expect(later).toHaveLength(1);
  } finally {
    globalThis.setTimeout = timeout;
  }

  act(() => {
    for (const run of later) {
      run();
    }
  });

  expect(page.querySelector("iframe[title='Drawing the slide']")).toBeNull();
  expect(page.textContent).toContain("The slide took too long to draw.");
});

test("an older version of a deck asks Pi nothing, and More exports it", async () => {
  const asked: Served[] = [];

  const page = renderPart(
    web,
    "overlay",
    {},
    {
      hash: "#session-1?artifact=a1&v=1",
      fetch: serving(deckArtifact({ ...viewed(2), versions: 2 }), asked),
    },
  );

  await opened(asked);
  deckFrame(page).tell({ pipoca: "deck", slides: deckSlides });

  act(() => {
    named(page, "All slides")?.click();
  });

  expect(page.textContent).toContain("3 slides");
  expect(page.textContent).not.toContain("drag to reorder");
  expect(named(page, "Slide 1 · Webhooks v2, ask Pi")).toBeUndefined();
  expect(page.textContent).not.toContain("Ask Pi for a slide");

  act(() => {
    named(page, "More")?.click();
  });

  expect(
    menuItems(page)
      .map((each) => each.textContent)
      .filter((each) => each.startsWith("Export")),
  ).toEqual([
    "Export as PDF",
    "Export as PDF with notes",
    "Export slide as PNG",
  ]);
});

test("Present shows the slide, the next one, the notes and a timer against the talk's length, and shares the slide it's on until it ends", async () => {
  const asked: Served[] = [];
  const beats: Served[] = [];
  const every: (() => void)[] = [];
  const opens: unknown[][] = [];
  const started = Date.now();

  const page = renderPart(
    web,
    "overlay",
    {},
    {
      hash: "#session-1?artifact=a1",
      fetch: serving(deckArtifact(), asked, {
        beats,
        here: () => [
          { name: "Bo", typing: null, following: true },
          { name: "Cy", typing: null },
        ],
        comments: () => [
          thread({
            id: "t0",
            version: 1,
            author: "Cy",
            body: "Asked before it started",
            createdAt: started - 60_000,
          }),
          thread({
            id: "t1",
            version: 1,
            author: "Bo",
            body: "Is that 0 with the queue on?",
            createdAt: started + 60_000,
          }),
        ],
      }),
    },
  );

  // Rendering sets the page's globals anew.
  const timing = beatsOf(every);

  const opening = spyOn(globalThis, "open").mockImplementation(
    (...args: unknown[]) => {
      opens.push(args);

      return null;
    },
  );

  try {
    await opened(asked);

    deckFrame(page).tell({
      pipoca: "deck",
      duration: "15m",
      slides: deckSlides,
    });

    const shares = (): unknown[] =>
      asked
        .filter(({ url }) => url.includes("a1/presenting"))
        .map(({ method, body, url }) =>
          method === "PUT" ? body : `${method} ${url.split("/").at(-1) ?? ""}`,
        );

    const present = named(page, "Present");

    act(() => {
      present?.focus();
      present?.click();
    });

    const presenter = (): HTMLElement | null =>
      page.querySelector(
        "[role=dialog][aria-modal=true][aria-label='Presenter view']",
      );

    await drawn(() => shares().length > 1);

    const [, first] = shares() as [unknown, { page: string }];

    expect(shares()).toEqual([
      "GET presenting",
      { page: first.page, version: 1, slide: 0, step: 0, blank: false },
    ]);

    expect(presenter()?.getAttribute("data-theme")).toBe("dark");
    expect(document.activeElement).toBe(presenter());
    expect(page.querySelector("header")?.closest("[inert]")).not.toBeNull();
    expect(presenter()?.closest("[inert]")).toBeNull();

    expect(presenter()?.querySelector("[role=timer]")?.textContent).toBe(
      "00:00",
    );

    expect(presenter()?.textContent).toContain("00:00of 15:00");
    expect(presenter()?.textContent).toContain("1 following in Pipoca");
    expect(presenter()?.textContent).toContain("Say who you are.");
    expect(presenter()?.textContent).toContain("Slide 1 of 3");

    expect(
      presenter()?.querySelector("aside iframe")?.getAttribute("src"),
    ).toEndWith("#slide=1");

    expect(presenter()?.textContent).toContain(
      "Asked while you present · 1Bo: Is that 0 with the queue on?",
    );

    expect(beats.at(-1)?.body).toMatchObject({ following: false });

    pressKey("ArrowRight");
    await drawn(() => shares().length > 2);

    expect(shares().at(-1)).toMatchObject({ slide: 1, step: 0 });
    expect(presenter()?.textContent).toContain("Lead with the p95.");

    const sent = shares().length;

    expect(every).not.toHaveLength(0);

    act(() => {
      for (const run of every) {
        run();
      }
    });

    await drawn(() => shares().length > sent);
    expect(shares().at(-1)).toMatchObject({ slide: 1, step: 0 });

    pressKey("b");
    await drawn(() => shares().length > sent + 1);

    expect(shares().at(-1)).toMatchObject({ slide: 1, blank: true });

    expect(
      presenter()?.querySelector("[role=img][aria-label='Blank screen']"),
    ).not.toBeNull();

    pressKey("B");

    expect(
      presenter()?.querySelector("[aria-label='Blank screen']"),
    ).toBeNull();

    pressKey("s");
    expect(presenter()?.textContent).not.toContain("Lead with the p95.");
    pressKey("S");
    expect(presenter()?.textContent).toContain("Lead with the p95.");

    act(() => {
      named(page, "Open audience window")?.click();
    });

    expect(opens).toEqual([
      ["#plugin/artifacts/a1/audience", "_blank", "popup"],
    ]);

    pressKey("End");

    await drawn(
      () =>
        presenter()?.textContent.includes("This is the last slide.") === true,
    );

    pressKey("Escape");

    await drawn(
      () => shares().at(-1) === `DELETE presenting?page=${first.page}`,
    );

    expect(presenter()).toBeNull();
    expect(page.querySelector("[inert]")).toBeNull();
    expect(document.activeElement).toBe(named(page, "Present") ?? null);
    expect(page.querySelector("dialog[open]")).not.toBeNull();
  } finally {
    timing.restore();
    opening.mockRestore();
  }
});

test("the presenter's timer turns red once the talk runs over its length", async () => {
  const asked: Served[] = [];
  const now = Date.now();
  const clock = spyOn(Date, "now").mockImplementation(() => now);

  try {
    const page = renderPart(
      web,
      "overlay",
      {},
      {
        hash: "#session-1?artifact=a1",
        fetch: serving(deckArtifact(), asked),
      },
    );

    await opened(asked);

    deckFrame(page).tell({
      pipoca: "deck",
      duration: "0:02",
      slides: deckSlides,
    });

    act(() => {
      named(page, "Present")?.click();
    });

    const timer = (): Element | null => page.querySelector("[role=timer]");

    expect(timer()?.className).not.toContain("text-failed");

    clock.mockImplementation(() => now + 3000);

    await drawn(() => timer()?.textContent === "00:03");
    expect(timer()?.className).toContain("text-failed");
  } finally {
    clock.mockRestore();
  }
});

test("Present waits while someone else presents, unless you steer, and a refused share stops", async () => {
  for (const access of ["comment", "steer", "view"] as const) {
    const asked: Served[] = [];

    const ana = {
      by: "Ana",
      yours: false,
      slide: 0,
      step: 0,
      blank: false,
      since: 0,
    };

    const served = serving(deckArtifact({ access }), asked);

    const page = renderPart(
      web,
      "overlay",
      {},
      {
        hash: "#session-1?artifact=a1",
        fetch: async (url, init) => {
          if (url.endsWith("/presenting")) {
            asked.push({ url, method: init?.method ?? "GET" });

            return init?.method === "PUT"
              ? Response.json(
                  { error: "conflict", message: "Ana is presenting it." },
                  { status: 409 },
                )
              : Response.json({ presenting: ana });
          }

          return served(url, init);
        },
      },
    );

    await opened(asked);
    deckFrame(page).tell({ pipoca: "deck", slides: deckSlides });

    await drawn(() => page.textContent.includes("Ana is presenting"));

    const button = buttons(page).find((each) =>
      ["Present", "Take over"].includes(each.textContent),
    );

    if (access !== "steer") {
      expect(button?.textContent).toBe("Present");
      expect(button?.disabled).toBe(true);
      expect(button?.title).toBe("Ana is presenting");

      continue;
    }

    expect(button?.textContent).toBe("Take over");
    expect(button?.disabled).toBe(false);

    const every: (() => void)[] = [];
    const timing = beatsOf(every);

    act(() => {
      button?.click();
    });

    const puts = (): number =>
      asked.filter(({ method }) => method === "PUT").length;

    await drawn(() => page.textContent.includes("Ana is presenting it."));
    expect(puts()).toBe(1);
    timing.restore();
    expect(every).not.toHaveLength(0);

    act(() => {
      for (const run of every) {
        run();
      }
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(puts()).toBe(1);
  }
});

test("people who open a deck while it's presented follow the presenter's slide, until they move on their own", async () => {
  const asked: Served[] = [];
  const beats: Served[] = [];

  const talk = {
    by: "Ana",
    yours: false,
    version: 1,
    blank: false,
    since: 0,
  };

  let presenting: object | null = { ...talk, slide: 1, step: 1 };
  let loads = 0;

  const served = serving(
    deckArtifact({ access: "comment", askable: false }),
    asked,
    { beats },
  );

  const page = renderPart(
    web,
    "overlay",
    {},
    {
      hash: "#session-1?artifact=a1",
      fetch: async (url, init) => {
        if (url.endsWith("/presenting")) {
          loads += 1;

          return Response.json({ presenting });
        }

        return served(url, init);
      },
    },
  );

  await opened(asked);

  const frame = deckFrame(page);

  frame.tell({ pipoca: "deck", slides: deckSlides });

  const group = (): Element | null =>
    page.querySelector("[role=group][aria-label=Presenting]");

  const banner = (): string => group()?.textContent ?? "";

  const tell = async (next: object | null): Promise<void> => {
    const before = loads;

    presenting = next;
    changed("artifacts.presence-a1");

    await drawn(() => loads > before);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  };

  await drawn(() => banner().includes("Ana is presenting"));

  expect(group()?.getAttribute("aria-live")).toBe("polite");

  expect(banner()).toContain(
    "Ana is presenting, on slide 2. You follow their slide.",
  );

  expect(shownSlide(frame)).toEqual({ pipoca: "slide", slide: 1, step: 1 });

  await drawn(() =>
    beats.some(
      ({ body }) =>
        (body as { following?: boolean } | undefined)?.following === true,
    ),
  );

  frame.tell({ pipoca: "key", key: "click" });
  expect(banner()).toContain("You follow their slide.");
  expect(shownSlide(frame)).toEqual({ pipoca: "slide", slide: 1, step: 1 });

  await tell({ ...talk, slide: 2, step: 0, blank: true });

  await drawn(() => banner().includes("on slide 3"));
  expect(shownSlide(frame)).toEqual({ pipoca: "slide", slide: 2, step: 0 });

  expect(
    page.querySelector("[role=img][aria-label='Ana blanked the screen']"),
  ).not.toBeNull();

  await tell({ ...talk, slide: 2, step: 0 });

  expect(
    page.querySelector("[aria-label='Ana blanked the screen']"),
  ).toBeNull();

  pressKey("ArrowLeft");

  expect(shownSlide(frame)).toEqual({ pipoca: "slide", slide: 1, step: 2 });
  expect(banner()).toContain("Ana is presenting.Follow Ana");

  await drawn(() =>
    beats.some(
      ({ body }) =>
        (body as { following?: boolean } | undefined)?.following === false,
    ),
  );

  await tell({ ...talk, slide: 0, step: 0 });
  expect(banner()).toContain("Ana is presenting.Follow Ana");
  expect(shownSlide(frame)).toEqual({ pipoca: "slide", slide: 1, step: 2 });

  act(() => {
    named(page, "Follow Ana")?.click();
  });

  expect(shownSlide(frame)).toEqual({ pipoca: "slide", slide: 0, step: 0 });

  act(() => {
    named(page, "Stop following")?.click();
  });

  await tell({ ...talk, slide: 2, step: 0 });
  expect(banner()).toContain("Follow Ana");
  expect(shownSlide(frame)).toEqual({ pipoca: "slide", slide: 0, step: 0 });

  await tell({ ...talk, by: "Bo", since: 5, slide: 2, step: 0 });
  await drawn(() => banner().includes("You follow their slide."));
  expect(shownSlide(frame)).toEqual({ pipoca: "slide", slide: 2, step: 0 });

  commentMode(page);

  act(() => {
    named(page, "Comment on the whole page")?.click();
  });

  expect(
    page.querySelector("form[aria-label='New comment'] p")?.textContent,
  ).toBe("On “Slide 3 · Questions”");

  await tell({ ...talk, yours: true, slide: 1, step: 0 });
  await drawn(() => banner() === "");

  await tell(null);
  expect(banner()).toBe("");
});

test("followers open the version the presenter shows, and keep the one they chose once they stop", async () => {
  const asked: Served[] = [];
  let loads = 0;

  let presenting: object | null = {
    by: "Ana",
    yours: false,
    version: 1,
    blank: false,
    since: 0,
    slide: 1,
    step: 0,
  };

  const served = serving(
    deckArtifact({ ...viewed(2), versions: 2, access: "comment" }),
    asked,
  );

  const page = renderPart(
    web,
    "overlay",
    {},
    {
      hash: "#session-1?artifact=a1",
      fetch: async (url, init) => {
        if (url.endsWith("/presenting")) {
          loads += 1;

          return Response.json({ presenting });
        }

        return served(url, init);
      },
    },
  );

  await opened(asked);

  await drawn(() => location.hash === "#session-1?artifact=a1&v=1");

  const frame = deckFrame(page, 1);

  frame.tell({ pipoca: "deck", slides: deckSlides });
  expect(shownSlide(frame)).toEqual({ pipoca: "slide", slide: 1, step: 0 });

  const before = loads;

  presenting = { ...presenting, version: 2 };
  changed("artifacts.presence-a1");

  await drawn(
    () => loads > before && location.hash === "#session-1?artifact=a1",
  );

  await drawn(() => page.querySelector("iframe[src$='/view?v=2']") !== null);

  act(() => {
    named(page, "Stop following")?.click();
  });

  const unfollowedAt = loads;

  presenting = { ...presenting, version: 1 };
  changed("artifacts.presence-a1");

  await drawn(() => loads > unfollowedAt);

  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  expect(location.hash).toBe("#session-1?artifact=a1");
});

test("the audience window shows only the slide, following the presentation, yours too, and goes black when it's blanked", async () => {
  const Gallery = slots.page;

  if (Gallery === undefined) {
    throw new Error("no gallery page");
  }

  const Page = Gallery;
  const asked: Served[] = [];
  let loads = 0;

  let presenting: object | null = {
    by: "You",
    yours: true,
    version: 1,
    blank: false,
    since: 0,
    slide: 1,
    step: 1,
  };

  const served = serving(deckArtifact({ ...viewed(2), versions: 2 }), asked);

  function Audience(): ReactElement {
    return <Page path="a1/audience" />;
  }

  const audience = { page: Audience };

  const page = renderPart(
    { ...web, slots: audience },
    "page",
    {},
    {
      hash: "#plugin/artifacts/a1/audience",
      fetch: async (url, init) => {
        if (url.endsWith("/presenting")) {
          loads += 1;

          return Response.json({ presenting });
        }

        return served(url, init);
      },
    },
  );

  await drawn(
    () =>
      page.querySelector("iframe[src$='/view?v=1']:not([aria-hidden])") !==
      null,
  );

  const frame = deckFrame(page);

  frame.tell({ pipoca: "deck", slides: deckSlides });

  await drawn(() => {
    const shown = shownSlide(frame) as { slide?: number } | undefined;

    return shown?.slide === 1;
  });

  expect(shownSlide(frame)).toEqual({ pipoca: "slide", slide: 1, step: 1 });
  expect(page.querySelector("[data-theme=dark]")).not.toBeNull();
  expect(page.querySelector("nav, header, button")).toBeNull();

  const before = loads;

  presenting = { ...presenting, slide: 2, step: 0, blank: true };
  changed("artifacts.presence-a1");

  await drawn(
    () => loads > before && page.querySelector("[role=img]") !== null,
  );

  expect(shownSlide(frame)).toEqual({ pipoca: "slide", slide: 2, step: 0 });

  expect(page.querySelector("[role=img]")?.getAttribute("aria-label")).toBe(
    "Blank screen",
  );
});

const checkoutCanvas = {
  canvas: {
    title: "Checkout redesign",
    launch: "flows",
    pages: [
      { id: "flows", name: "Flows" },
      { id: "phone", name: "Phone" },
    ],
    boards: [
      {
        file: "Cart.html",
        x: 0,
        y: 0,
        w: 1280,
        h: 800,
        title: "A. Cart",
        page: "flows",
      },
      {
        file: "Pay.html",
        x: 1360,
        y: 0,
        w: 1280,
        h: 900,
        title: "B. Payment",
        page: "flows",
      },
      {
        file: "Small.html",
        x: 0,
        y: 0,
        w: 390,
        h: 844,
        title: "C. Phone",
        page: "phone",
      },
    ],
    notes: [
      {
        id: "t1",
        x: 0,
        y: -300,
        w: 360,
        text: "Checkout flow",
        page: "flows",
        heading: 1,
        color: "blue",
      },
      {
        id: "n1",
        x: 0,
        y: 1000,
        w: 360,
        text: "v2 puts the error inline on B.",
        page: "flows",
        heading: 0,
        color: "blue",
      },
    ],
    problems: [],
  },
  error: null,
  stickies: [
    {
      id: "s1",
      x: 620,
      y: 330,
      text: "A separate failed screen?",
      page: "flows",
      color: "yellow",
      author: "You",
      yours: true,
      deletable: true,
      createdAt: 0,
    },
    {
      id: "s2",
      x: 0,
      y: 1300,
      text: "Apple Pay first",
      page: "flows",
      color: "green",
      author: "Bo",
      yours: false,
      deletable: false,
      createdAt: 0,
    },
  ],
  changed: ["Pay.html"],
  added: [],
  removed: [],
  shared: [],
  against: 1,
};

function canvasArtifact(o: object = {}) {
  return {
    ...artifact({
      title: "Checkout redesign",
      type: "canvas",
      living: true,
      versions: 2,
    }),
    ...viewed(2),
    askable: true,
    ...o,
  };
}

function servingCanvas(
  asked: Served[],
  o: {
    readonly view?: object;
    readonly comments?: () => readonly Comment[];
    readonly artifact?: object;
  } = {},
): (url: string, init?: RequestInit) => Promise<Response> {
  const rest = serving(o.artifact ?? canvasArtifact(), asked, {
    ...(o.comments !== undefined && { comments: o.comments }),
  });

  return async (url, init) => {
    if (url.includes("/canvas?")) {
      await Promise.resolve();
      asked.push({ url, method: "GET" });

      return Response.json(o.view ?? checkoutCanvas);
    }

    return rest(url, init);
  };
}

async function openCanvas(page: HTMLElement): Promise<void> {
  await drawn(
    () => page.querySelector("[aria-roledescription=canvas]") !== null,
  );
}

function boardFrame(page: HTMLElement, path: string, version = 2) {
  const frame = page.querySelector<HTMLIFrameElement>(
    `iframe[src$='/view?v=${String(version)}&path=${encodeURIComponent(path)}']:not([aria-hidden])`,
  );

  const window = frame?.contentWindow;
  const posted: { pipoca?: string }[] = [];

  if (window !== null && window !== undefined) {
    window.postMessage = (data: unknown) => {
      posted.push(data as { pipoca?: string });
    };
  }

  return {
    frame,
    tell: (data: object) => {
      act(() => {
        dispatchEvent(
          new MessageEvent("message", { data, source: window ?? null }),
        );
      });
    },
    told: () => posted,
  };
}

function layer(page: HTMLElement): string {
  return (
    page
      .querySelector<HTMLElement>("[aria-roledescription=canvas] > div")
      ?.style.getPropertyValue("transform") ?? ""
  );
}

test("a canvas draws its page's boards each in its own frame, with Pi's notes, people's stickies, a list of boards and page tabs, and pans and zooms", async () => {
  const asked: Served[] = [];

  const page = renderPart(
    web,
    "overlay",
    {},
    {
      hash: "#session-1?artifact=a1",
      fetch: servingCanvas(asked, {
        comments: () => [
          thread({
            id: "t1",
            file: "Pay.html",
            quote: "Card number",
            element: "#card",
          }),
          thread({ id: "t2", file: "Pay.html", resolved: true }),
        ],
      }),
    },
  );

  await openCanvas(page);

  expect(asked.map(({ url }) => url)).toContain(
    "/api/ext/artifacts/artifacts/a1/canvas?v=2",
  );

  expect(page.textContent).toContain("Design canvas · 3 boards");

  expect(
    [
      ...page.querySelectorAll("[role=tablist][aria-label=Pages] [role=tab]"),
    ].map((each) => each.textContent),
  ).toEqual(["Flows 2", "Phone 1"]);

  const boards = (): string[] =>
    [...page.querySelectorAll("nav[aria-label=Boards] button")].map(
      (each) => each.textContent,
    );

  expect(boards()).toEqual(["A. Cart", "B. Payment1changed"]);

  expect(
    [
      ...page.querySelectorAll<HTMLIFrameElement>(
        "[aria-roledescription=canvas] iframe",
      ),
    ].map((each) => [each.getAttribute("src"), each.getAttribute("sandbox")]),
  ).toEqual([
    [
      "/api/ext/artifacts/artifacts/a1/view?v=2&path=Cart.html",
      "allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals allow-forms",
    ],
    [
      "/api/ext/artifacts/artifacts/a1/view?v=2&path=Pay.html",
      "allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals allow-forms",
    ],
  ]);

  expect(
    named(page, "Open B. Payment, changed in this version, 1 open comment"),
  ).toBeDefined();

  expect(page.textContent).toContain("Checkout flow");

  expect(page.querySelector("[role=note]")?.getAttribute("aria-label")).toBe(
    "Note from Pi: v2 puts the error inline on B.",
  );

  expect(
    named(
      page,
      "Sticky from You: A separate failed screen?. Arrow keys move it.",
    ),
  ).toBeDefined();

  expect(named(page, "Sticky from Bo: Apple Pay first")).toBeDefined();

  const surface = page.querySelector<HTMLElement>(
    "[aria-roledescription=canvas]",
  );

  expect(layer(page)).toBe("translate(40px, 40px) scale(1)");

  pressKey("+", surface ?? undefined);
  expect(named(page, "Zoom 125%, set to 100%")).toBeDefined();

  pressKey("ArrowRight", surface ?? undefined);
  expect(layer(page)).toContain("scale(1.25)");
  expect(layer(page)).not.toStartWith("translate(40px");

  pressKey("-", surface ?? undefined);
  expect(named(page, "Zoom 100%, set to 100%")).toBeDefined();

  act(() => {
    named(page, "Zoom in")?.click();
  });

  expect(named(page, "Zoom 125%, set to 100%")).toBeDefined();

  pressKey("0", surface ?? undefined);
  expect(layer(page)).toBe("translate(40px, 40px) scale(1)");

  const wheel = (init: WheelEventInit, held = false): void => {
    const event = new WheelEvent("wheel", {
      ...init,
      bubbles: true,
      cancelable: true,
    });

    Object.defineProperty(event, "ctrlKey", { value: held });

    act(() => {
      surface?.dispatchEvent(event);
    });
  };

  wheel({ deltaX: 0, deltaY: -100 });
  expect(layer(page)).toBe("translate(40px, 140px) scale(1)");

  wheel({ deltaY: -100 }, true);
  expect(layer(page)).toContain("scale(2.718");

  act(() => {
    [...page.querySelectorAll<HTMLButtonElement>("[role=tab]")]
      .find((each) => each.textContent.startsWith("Phone"))
      ?.click();
  });

  expect(boards()).toEqual(["C. Phone"]);
  expect(page.textContent).not.toContain("Apple Pay first");
  expect(layer(page)).toBe("translate(40px, 40px) scale(1)");
});

test("people add stickies to a canvas where they look, and edit, move and delete their own", async () => {
  const asked: Served[] = [];

  const page = renderPart(
    web,
    "overlay",
    {},
    { hash: "#session-1?artifact=a1", fetch: servingCanvas(asked) },
  );

  await openCanvas(page);

  act(() => {
    named(page, "Sticky")?.click();
  });

  const dialog = (): HTMLDialogElement | undefined =>
    [...page.querySelectorAll("dialog")].find(
      (each) => each.querySelector("h2")?.textContent === "New sticky",
    );

  await drawn(() => dialog() !== undefined);

  typeInto(dialog()?.querySelector("textarea") ?? null, "Inline error?");

  act(() => {
    [...(dialog()?.querySelectorAll("button") ?? [])]
      .find((each) => each.textContent === "Pink")
      ?.click();
  });

  await act(async () => {
    dialog()?.querySelector("form")?.requestSubmit();
    await until(() => asked.some(({ method }) => method === "POST"));
  });

  expect(asked.find(({ method }) => method === "POST")).toMatchObject({
    url: "/api/ext/artifacts/artifacts/a1/stickies",
    body: { page: "flows", text: "Inline error?", color: "pink" },
  });

  const mine = named(
    page,
    "Sticky from You: A separate failed screen?. Arrow keys move it.",
  );

  act(() => {
    mine?.focus();
  });

  expect(mine?.getAttribute("aria-current")).toBe("true");

  pressKey("ArrowDown", mine);

  await act(async () =>
    until(() => asked.some(({ method }) => method === "PUT")),
  );

  expect(asked.find(({ method }) => method === "PUT")).toEqual({
    url: "/api/ext/artifacts/artifacts/a1/stickies/s1",
    method: "PUT",
    body: { x: 620, y: 340 },
  });

  expect(mine?.style.top).toBe("340px");

  act(() => {
    named(page, "Edit sticky")?.click();
  });

  await drawn(() =>
    [...page.querySelectorAll("dialog h2")].some(
      (each) => each.textContent === "Edit sticky",
    ),
  );

  act(() => {
    named(page, "Delete sticky")?.click();
  });

  await act(async () =>
    until(() => asked.some(({ method }) => method === "DELETE")),
  );

  expect(asked.find(({ method }) => method === "DELETE")?.url).toBe(
    "/api/ext/artifacts/artifacts/a1/stickies/s1",
  );

  act(() => {
    named(page, "Sticky from Bo: Apple Pay first")?.focus();
  });

  expect(named(page, "Edit sticky")).toBeUndefined();
  expect(named(page, "Delete sticky")).toBeUndefined();
});

test("a board opens on its own with the comments made on it, and Play follows its links to other boards", async () => {
  const asked: Served[] = [];

  const comments: Comment[] = [
    thread({
      id: "t1",
      file: "Pay.html",
      quote: "Card number",
      element: "#card",
      body: "Inline error here",
    }),
    thread({ id: "t2", file: "Cart.html", body: "Cart is fine" }),
  ];

  const page = renderPart(
    web,
    "overlay",
    {},
    {
      hash: "#session-1?artifact=a1",
      fetch: servingCanvas(asked, { comments: () => comments }),
    },
  );

  await openCanvas(page);

  act(() => {
    named(
      page,
      "Open B. Payment, changed in this version, 1 open comment",
    )?.click();
  });

  await drawn(() => page.querySelector("h3")?.textContent === "B. Payment");

  expect(page.textContent).toContain("Checkout redesign · board 2 of 2");

  let board = boardFrame(page, "Pay.html");

  expect(board.frame).not.toBeNull();

  commentMode(page);
  await drawn(() => page.textContent.includes("Inline error here"));

  expect(
    page.querySelector("aside[aria-label=Comments]")?.textContent,
  ).not.toContain("Cart is fine");

  expect(
    board
      .told()
      .filter((each) => each.pipoca === "pins")
      .at(-1),
  ).toMatchObject({ pins: [{ n: 1, selector: "#card" }] });

  board.tell({
    pipoca: "element",
    selector: "#pay",
    label: "Pay €48.00",
    rect,
  });

  const box = (): HTMLFormElement | null =>
    page.querySelector("form[aria-label='New comment']");

  await drawn(() => box() !== null);

  typeInto(
    box()?.querySelector("textarea[aria-label='Comment text']") ?? null,
    "Orange?",
  );

  await act(async () => {
    box()?.requestSubmit();
    await until(() => asked.some(({ method }) => method === "POST"));
  });

  expect(asked.find(({ method }) => method === "POST")?.body).toEqual({
    version: 2,
    body: "Orange?",
    kind: "comment",
    toPi: false,
    quote: "Pay €48.00",
    element: "#pay",
    file: "Pay.html",
  });

  board.tell({ pipoca: "board", path: "Cart.html" });
  expect(page.querySelector("h3")?.textContent).toBe("B. Payment");

  act(() => {
    named(page, "Play")?.click();
  });

  board = boardFrame(page, "Pay.html");
  board.tell({ pipoca: "board", path: "Cart.html" });

  await drawn(() => page.querySelector("h3")?.textContent === "A. Cart");
  expect(boardFrame(page, "Cart.html").frame).not.toBeNull();

  boardFrame(page, "Cart.html").tell({
    pipoca: "board",
    path: "Elsewhere.html",
  });

  expect(page.querySelector("h3")?.textContent).toBe("A. Cart");

  act(() => {
    named(page, "Next board")?.click();
  });

  expect(page.querySelector("h3")?.textContent).toBe("B. Payment");

  act(() => {
    named(page, "Back to the canvas")?.click();
  });

  await openCanvas(page);
});

test("Compare shows the boards a version changed side by side, from the canvas or from one board", async () => {
  const asked: Served[] = [];

  const page = renderPart(
    web,
    "overlay",
    {},
    { hash: "#session-1?artifact=a1", fetch: servingCanvas(asked) },
  );

  await openCanvas(page);

  act(() => {
    named(page, "Open A. Cart")?.click();
  });

  await drawn(() => page.querySelector("h3")?.textContent === "A. Cart");
  expect(named(page, "Compare")).toBeUndefined();

  act(() => {
    named(page, "Next board")?.click();
  });

  act(() => {
    named(page, "Compare")?.click();
  });

  await drawn(() => page.textContent.includes("Comparing B. Payment"));

  expect(asked.map(({ url }) => url)).toContain(
    "/api/ext/artifacts/artifacts/a1/canvas?v=2&against=1",
  );

  const sides = (): (string | null)[] =>
    [...page.querySelectorAll("section[aria-label='B. Payment'] iframe")].map(
      (each) => each.getAttribute("src"),
    );

  expect(sides()).toEqual([
    "/api/ext/artifacts/artifacts/a1/view?v=1&path=Pay.html",
    "/api/ext/artifacts/artifacts/a1/view?v=2&path=Pay.html",
  ]);

  act(() => {
    named(page, "Back to latest")?.click();
  });

  await drawn(() => page.querySelector("h3")?.textContent === "B. Payment");
});

test("a canvas whose canvas.json is broken says why instead of drawing it", async () => {
  const asked: Served[] = [];

  const page = renderPart(
    web,
    "overlay",
    {},
    {
      hash: "#session-1?artifact=a1",
      fetch: servingCanvas(asked, {
        view: {
          canvas: null,
          error: "canvas.json isn't valid JSON: Unexpected token",
          stickies: [],
          changed: [],
          added: [],
          removed: [],
          shared: [],
          against: null,
        },
      }),
    },
  );

  await drawn(() => page.textContent.includes("This canvas can't be drawn"));

  expect(page.querySelector("[role=alert]")?.textContent).toContain(
    "canvas.json isn't valid JSON: Unexpected token",
  );
});

function canvasWith(o: {
  readonly canvas?: object;
  readonly stickies?: readonly object[];
  readonly view?: object;
}) {
  return {
    ...checkoutCanvas,
    ...o.view,
    canvas: { ...checkoutCanvas.canvas, ...o.canvas },
    stickies: o.stickies ?? checkoutCanvas.stickies,
  };
}

function surfaceOf(page: HTMLElement): HTMLElement | undefined {
  return (
    page.querySelector<HTMLElement>("[aria-roledescription=canvas]") ??
    undefined
  );
}

function tool(page: HTMLElement, name: string): HTMLButtonElement | undefined {
  return [
    ...page.querySelectorAll<HTMLButtonElement>(
      "[role=toolbar][aria-label=Canvas] button",
    ),
  ].find((each) => each.textContent === name);
}

test("a canvas opens on the page its canvas.json launches, with that page's notes and headings sized by their level", async () => {
  const asked: Served[] = [];

  const page = renderPart(
    web,
    "overlay",
    {},
    {
      hash: "#session-1?artifact=a1",
      fetch: servingCanvas(asked, {
        view: canvasWith({
          canvas: {
            launch: "phone",
            notes: [
              ...checkoutCanvas.canvas.notes,
              {
                id: "t2",
                x: 0,
                y: -200,
                w: 360,
                text: "Phone",
                page: "phone",
                heading: 1,
                color: "blue",
              },
              {
                id: "t3",
                x: 0,
                y: -100,
                w: 360,
                text: "Small screens",
                page: "phone",
                heading: 2,
                color: "blue",
              },
            ],
          },
        }),
      }),
    },
  );

  await openCanvas(page);

  expect(
    [...page.querySelectorAll("nav[aria-label=Boards] button")].map(
      (each) => each.textContent,
    ),
  ).toEqual(["C. Phone"]);

  expect(
    [
      ...page.querySelectorAll("[aria-roledescription=canvas] [role=heading]"),
    ].map((each) => [
      each.textContent,
      each.getAttribute("aria-level"),
      each.className.includes("text-[72px]"),
      each.className.includes("text-[48px]"),
    ]),
  ).toEqual([
    ["Phone", "3", true, false],
    ["Small screens", "4", false, true],
  ]);

  expect(page.textContent).not.toContain("Checkout flow");
  expect(page.querySelector("[role=note]")).toBeNull();
});

test("a canvas of one page has no page tabs", async () => {
  const asked: Served[] = [];

  const page = renderPart(
    web,
    "overlay",
    {},
    {
      hash: "#session-1?artifact=a1",
      fetch: servingCanvas(asked, {
        view: canvasWith({
          canvas: {
            pages: [{ id: "flows", name: "Flows" }],
            boards: checkoutCanvas.canvas.boards.slice(0, 2),
          },
        }),
      }),
    },
  );

  await openCanvas(page);

  expect(page.querySelector("[role=tablist][aria-label=Pages]")).toBeNull();

  expect(page.querySelectorAll("nav[aria-label=Boards] button")).toHaveLength(
    2,
  );
});

test("arrow keys pan a canvas every way but not from what's on it, the zoom is said aloud, and board titles stay small when zoomed out", async () => {
  const asked: Served[] = [];

  const page = renderPart(
    web,
    "overlay",
    {},
    { hash: "#session-1?artifact=a1", fetch: servingCanvas(asked) },
  );

  await openCanvas(page);

  const surface = surfaceOf(page);

  const announced = (): string | null | undefined =>
    page.querySelector("[aria-live=polite]")?.textContent;

  expect(announced()).toBe("Zoom 100%");

  for (const [key, moved] of [
    ["ArrowLeft", "translate(80px, 40px)"],
    ["ArrowRight", "translate(40px, 40px)"],
    ["ArrowUp", "translate(40px, 80px)"],
    ["ArrowDown", "translate(40px, 40px)"],
  ] as const) {
    pressKey(key, surface);
    expect(layer(page)).toBe(`${moved} scale(1)`);
  }

  const layered = page.querySelector<HTMLElement>(
    "[aria-roledescription=canvas] > div",
  );

  expect(layered?.textContent).toContain("B. Paymentchanged in this version");

  const others = named(page, "Sticky from Bo: Apple Pay first");

  act(() => {
    others?.focus();
  });

  const before = layer(page);
  const top = others?.style.top;

  pressKey("ArrowLeft", others);
  pressKey("+", others);

  expect(layer(page)).toBe(before);
  expect(others?.style.top).toBe(top);

  pressKey("0", surface);

  for (let times = 0; times < 8; times += 1) {
    pressKey("-", surface);
  }

  expect(announced()).toBe("Zoom 17%");

  const title = (): HTMLElement | undefined =>
    [
      ...page.querySelectorAll<HTMLElement>(
        "[aria-roledescription=canvas] span[aria-hidden]",
      ),
    ].find((each) => each.textContent === "A. Cart");

  expect(title()?.style.fontSize).toBe("60px");

  pressKey("-", surface);
  expect(title()).toBeUndefined();

  await act(async () => new Promise((resolve) => setTimeout(resolve, 450)));
  expect(asked.some(({ method }) => method === "PUT")).toBe(false);
});

test("tabbing to a board or sticky off screen brings it into view, and a person's own sticky steps by the zoom and saves once it rests", async () => {
  const asked: Served[] = [];

  const page = renderPart(
    web,
    "overlay",
    {},
    { hash: "#session-1?artifact=a1", fetch: servingCanvas(asked) },
  );

  await openCanvas(page);

  const surface = surfaceOf(page);

  act(() => {
    named(page, "Open B. Payment, changed in this version")?.focus();
  });

  expect(layer(page)).toBe("translate(-2000px, -450px) scale(1)");

  const mine = named(
    page,
    "Sticky from You: A separate failed screen?. Arrow keys move it.",
  );

  act(() => {
    mine?.focus();
  });

  expect(layer(page)).toBe("translate(-800px, -410px) scale(1)");

  pressKey("+", surface);
  pressKey("ArrowDown", mine);
  pressKey("ArrowDown", mine);
  pressKey("ArrowRight", mine);

  expect(mine?.style.top).toBe("346px");
  expect(mine?.style.left).toBe("628px");
  expect(asked.some(({ method }) => method === "PUT")).toBe(false);

  await act(async () =>
    until(() => asked.some(({ method }) => method === "PUT")),
  );

  await act(async () => new Promise((resolve) => setTimeout(resolve, 450)));

  expect(asked.filter(({ method }) => method === "PUT")).toEqual([
    {
      url: "/api/ext/artifacts/artifacts/a1/stickies/s1",
      method: "PUT",
      body: { x: 628, y: 346 },
    },
  ]);
});

test("dragging from someone else's sticky pans the canvas, and dragging their own moves it", async () => {
  const asked: Served[] = [];

  const page = renderPart(
    web,
    "overlay",
    {},
    { hash: "#session-1?artifact=a1", fetch: servingCanvas(asked) },
  );

  await openCanvas(page);

  const pointer = (type: string, on: Element | undefined, x: number): void => {
    act(() => {
      on?.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          pointerId: 1,
          clientX: x,
          clientY: 0,
        }),
      );
    });
  };

  const others = named(page, "Sticky from Bo: Apple Pay first");

  pointer("pointerdown", others, 0);
  pointer("pointermove", others, 50);
  pointer("pointerup", others, 50);

  expect(layer(page)).toBe("translate(90px, 40px) scale(1)");

  const mine = named(
    page,
    "Sticky from You: A separate failed screen?. Arrow keys move it.",
  );

  pointer("pointerdown", mine, 0);
  pointer("pointermove", mine, 30);
  pointer("pointerup", mine, 30);

  expect(layer(page)).toBe("translate(90px, 40px) scale(1)");

  await act(async () =>
    until(() => asked.some(({ method }) => method === "PUT")),
  );

  expect(asked.find(({ method }) => method === "PUT")?.body).toEqual({
    x: 650,
    y: 330,
  });
});

test("a new sticky is yellow unless chosen and goes where the person looks, and editing one sends what it says now", async () => {
  const asked: Served[] = [];

  const page = renderPart(
    web,
    "overlay",
    {},
    { hash: "#session-1?artifact=a1", fetch: servingCanvas(asked) },
  );

  await openCanvas(page);

  act(() => {
    tool(page, "Sticky")?.click();
  });

  const dialog = (title: string): HTMLDialogElement | undefined =>
    [...page.querySelectorAll("dialog")].find(
      (each) => each.querySelector("h2")?.textContent === title,
    );

  await drawn(() => dialog("New sticky") !== undefined);

  typeInto(
    dialog("New sticky")?.querySelector("textarea") ?? null,
    "Fewer steps",
  );

  await act(async () => {
    dialog("New sticky")?.querySelector("form")?.requestSubmit();
    await until(() => asked.some(({ method }) => method === "POST"));
  });

  expect(asked.find(({ method }) => method === "POST")?.body).toEqual({
    page: "flows",
    x: -220,
    y: -120,
    text: "Fewer steps",
    color: "yellow",
  });

  act(() => {
    named(
      page,
      "Sticky from You: A separate failed screen?. Arrow keys move it.",
    )?.focus();
  });

  act(() => {
    tool(page, "Edit sticky")?.click();
  });

  await drawn(() => dialog("Edit sticky") !== undefined);

  const field = dialog("Edit sticky")?.querySelector("textarea") ?? null;

  expect(field?.value).toBe("A separate failed screen?");

  typeInto(field, "One failed screen");

  await act(async () => {
    dialog("Edit sticky")?.querySelector("form")?.requestSubmit();
    await until(() => asked.some(({ method }) => method === "PUT"));
  });

  expect(asked.find(({ method }) => method === "PUT")).toEqual({
    url: "/api/ext/artifacts/artifacts/a1/stickies/s1",
    method: "PUT",
    body: { text: "One failed screen", color: "yellow" },
  });
});

test("someone who may delete another's sticky can delete it but not edit it, and stickies on a page that's gone are listed", async () => {
  const asked: Served[] = [];

  const page = renderPart(
    web,
    "overlay",
    {},
    {
      hash: "#session-1?artifact=a1",
      fetch: servingCanvas(asked, {
        view: canvasWith({
          stickies: [
            { ...checkoutCanvas.stickies[1], deletable: true },
            {
              ...checkoutCanvas.stickies[1],
              id: "s3",
              page: "old",
              text: "Where did this go?",
              deletable: true,
            },
          ],
        }),
      }),
    },
  );

  await openCanvas(page);

  act(() => {
    named(page, "Sticky from Bo: Apple Pay first")?.focus();
  });

  expect(tool(page, "Edit sticky")).toBeUndefined();
  expect(tool(page, "Delete sticky")).toBeDefined();

  const lost = page.querySelector(
    "section[aria-label='Stickies on a page that no longer exists']",
  );

  expect(lost?.textContent).toContain("Bo: Where did this go?");
  expect(surfaceOf(page)?.textContent).not.toContain("Where did this go?");

  act(() => {
    lost?.querySelector("button")?.click();
  });

  expect(lost?.querySelector("button")?.getAttribute("aria-current")).toBe(
    "true",
  );

  act(() => {
    tool(page, "Delete sticky")?.click();
  });

  await act(async () =>
    until(() => asked.some(({ method }) => method === "DELETE")),
  );

  expect(asked.find(({ method }) => method === "DELETE")?.url).toBe(
    "/api/ext/artifacts/artifacts/a1/stickies/s3",
  );
});

test("a comment on the whole canvas is written over it, Move and Comment switch commenting, and a board opened while commenting is commented on as a board", async () => {
  const asked: Served[] = [];

  const page = renderPart(
    web,
    "overlay",
    {},
    { hash: "#session-1?artifact=a1", fetch: servingCanvas(asked) },
  );

  await openCanvas(page);

  expect(tool(page, "Move")?.getAttribute("aria-pressed")).toBe("true");
  expect(page.querySelector("aside[aria-label=Comments]")).toBeNull();

  act(() => {
    tool(page, "Comment")?.click();
  });

  await drawn(() => page.querySelector("aside[aria-label=Comments]") !== null);

  expect(tool(page, "Comment")?.getAttribute("aria-pressed")).toBe("true");

  expect(
    page.querySelector("aside[aria-label=Comments]")?.textContent,
  ).toContain(
    "Open a board to comment on part of it, or comment on the whole canvas.",
  );

  act(() => {
    named(page, "Comment on the whole canvas")?.click();
  });

  const box = (): HTMLFormElement | null =>
    page.querySelector(
      "section[aria-label='Comment on the whole canvas'] form[aria-label='New comment']",
    );

  await drawn(() => box() !== null);

  expect(box()?.textContent).toContain("On the whole canvas");

  typeInto(
    box()?.querySelector("textarea[aria-label='Comment text']") ?? null,
    "Fewer boards?",
  );

  await act(async () => {
    box()?.requestSubmit();
    await until(() => asked.some(({ method }) => method === "POST"));
  });

  expect(asked.find(({ method }) => method === "POST")?.body).toEqual({
    version: 2,
    body: "Fewer boards?",
    kind: "comment",
    toPi: false,
  });

  act(() => {
    named(page, "Open A. Cart")?.click();
  });

  await drawn(() => page.querySelector("h3")?.textContent === "A. Cart");

  expect(
    page.querySelector("aside[aria-label=Comments]")?.textContent,
  ).toContain("Select text or click part of the board to comment on it.");

  act(() => {
    named(page, "Comment on the whole board")?.click();
  });

  await drawn(
    () => page.querySelector("form[aria-label='New comment']") !== null,
  );

  expect(
    page.querySelector("form[aria-label='New comment']")?.textContent,
  ).toContain("On the whole board");

  act(() => {
    named(page, "Back to the canvas")?.click();
  });

  await openCanvas(page);

  act(() => {
    tool(page, "Move")?.click();
  });

  await drawn(() => page.querySelector("aside[aria-label=Comments]") === null);
});

test("a thread on another board opens that board, and a board hides the switch to the canvas's files", async () => {
  const asked: Served[] = [];

  const page = renderPart(
    web,
    "overlay",
    {},
    {
      hash: "#session-1?artifact=a1",
      fetch: servingCanvas(asked, {
        artifact: canvasArtifact({
          history: viewed(2).history.map((each) => ({ ...each, files: 4 })),
        }),
        comments: () => [
          thread({ id: "t2", file: "Cart.html", body: "Cart is fine" }),
        ],
      }),
    },
  );

  await openCanvas(page);

  expect(named(page, "Files 4")).toBeDefined();

  commentMode(page);
  await drawn(() => page.textContent.includes("Cart is fine"));

  act(() => {
    page.querySelector<HTMLButtonElement>("[data-thread='t2'] button")?.click();
  });

  await drawn(() => page.querySelector("h3")?.textContent === "A. Cart");

  expect(named(page, "Files 4")).toBeUndefined();

  act(() => {
    named(page, "Play")?.click();
  });

  boardFrame(page, "Cart.html").tell({ pipoca: "board", path: "Pay.html" });

  await drawn(() => page.querySelector("h3")?.textContent === "B. Payment");

  expect(named(page, "Play")?.getAttribute("aria-pressed")).toBe("true");
});

test("Compare shows added boards beside the version without them, removed ones beside the one without them, and what shared files changed", async () => {
  const asked: Served[] = [];

  const added = {
    file: "New.html",
    x: 0,
    y: 1000,
    w: 1280,
    h: 800,
    title: "D. Receipt",
    page: "flows",
  };

  const page = renderPart(
    web,
    "overlay",
    {},
    {
      hash: "#session-1?artifact=a1",
      fetch: servingCanvas(asked, {
        view: canvasWith({
          canvas: { boards: [...checkoutCanvas.canvas.boards, added] },
          view: {
            added: ["New.html"],
            removed: [{ ...added, file: "Gone.html", title: "E. Failed" }],
            shared: ["app.css"],
          },
        }),
      }),
    },
  );

  await openCanvas(page);

  act(() => {
    versionMenu(page)?.click();
  });

  act(() => {
    item(page, "Compare versions…")?.click();
  });

  await drawn(() => page.textContent.includes("Comparing two versions"));

  await drawn(
    () => page.querySelector("section[aria-label='D. Receipt']") !== null,
  );

  const sides = (title: string): (string | null)[] =>
    [
      ...page.querySelectorAll(
        `section[aria-label='${title}'] iframe, section[aria-label='${title}'] .border-dashed`,
      ),
    ].map((each) => each.getAttribute("src") ?? each.textContent);

  expect(sides("B. Payment")).toEqual([
    "/api/ext/artifacts/artifacts/a1/view?v=1&path=Pay.html",
    "/api/ext/artifacts/artifacts/a1/view?v=2&path=Pay.html",
  ]);

  expect(sides("D. Receipt")).toEqual([
    "Not in version 1",
    "/api/ext/artifacts/artifacts/a1/view?v=2&path=New.html",
  ]);

  expect(sides("E. Failed")).toEqual([
    "/api/ext/artifacts/artifacts/a1/view?v=1&path=Gone.html",
    "Not in version 2",
  ]);

  expect(page.querySelector("[role=note]")?.textContent).toBe(
    "app.css changed too, so boards that use it may look different.",
  );

  expect(
    page.querySelector("section[aria-label='A. Cart'] h3")?.textContent,
  ).toBe("A. Cartmay have changed");

  act(() => {
    named(page, "Back to latest")?.click();
  });

  await openCanvas(page);

  act(() => {
    named(page, "Open A. Cart")?.click();
  });

  await drawn(() => page.querySelector("h3")?.textContent === "A. Cart");

  act(() => {
    named(page, "Compare")?.click();
  });

  await drawn(() => page.textContent.includes("Comparing A. Cart"));

  expect(
    [...page.querySelectorAll("section[aria-label]")].map((each) =>
      each.getAttribute("aria-label"),
    ),
  ).toEqual(["A. Cart"]);
});

test("a pointer let go outside the canvas still lets Tab bring a board into view", async () => {
  const asked: Served[] = [];

  const page = renderPart(
    web,
    "overlay",
    {},
    { hash: "#session-1?artifact=a1", fetch: servingCanvas(asked) },
  );

  await openCanvas(page);

  act(() => {
    surfaceOf(page)?.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, pointerId: 1 }),
    );
  });

  act(() => {
    dispatchEvent(new PointerEvent("pointerup", { pointerId: 1 }));
  });

  act(() => {
    named(page, "Open B. Payment, changed in this version")?.focus();
  });

  expect(layer(page)).toBe("translate(-2000px, -450px) scale(1)");
});

function systemSummary(o: Partial<SystemSummary> = {}): SystemSummary {
  return {
    id: "pipoca",
    name: "Pipoca",
    scope: "builtin",
    by: "Pipoca",
    version: 1,
    usedBy: 11,
    thumb: { ground: "rgb(250 247 240)", ink: "rgb(26 23 18)" },
    ...o,
  };
}

const someSystems = [
  systemSummary({
    id: "acme",
    name: "Acme design system",
    scope: "team",
    by: "Team",
    version: 5,
    usedBy: 6,
    thumb: { ground: "rgb(29 36 51)", ink: "rgb(243 197 82)" },
  }),
  systemSummary(),
  systemSummary({
    id: "talk",
    name: "Conference talk",
    scope: "mine",
    by: "Ana",
    version: 2,
    usedBy: 1,
  }),
];

function systemView(o: Partial<SystemView> = {}): SystemView {
  return {
    ...someSystems[0],
    tokens: {
      colors: [
        { name: "ink", value: "rgb(29 36 51)", usage: "Text" },
        { name: "paper", value: "white", usage: "" },
        { name: "accent", value: "rgb(194 65 12)", usage: "One per slide" },
      ],
      type: [
        {
          name: "display",
          family: "Georgia, serif",
          size: "34px",
          lineHeight: "1.15",
          weight: "400",
          letterSpacing: "",
          sample: "Ready to cut over",
          usage: "Title slides",
        },
      ],
      spacing: [{ name: "space-2", value: "8px", usage: "Rows" }],
    },
    problems: [],
    components: [
      { name: "Button", file: "components/Button/preview.html" },
      { name: "KPI", file: "components/KPI/preview.html" },
    ],
    files: 9,
    users: [{ id: "d1", title: "Webhooks v2", type: "slides", version: 5 }],
    server: true,
    mine: false,
    ...o,
  } as SystemView;
}

function systemsServed(
  asked: Served[],
  answers: Readonly<Record<string, unknown>>,
  rest: (url: string, init?: RequestInit) => Promise<Response> = async () =>
    Promise.resolve(Response.json({})),
): (url: string, init?: RequestInit) => Promise<Response> {
  return async (url, init) => {
    await Promise.resolve();

    const path = url.replace("/api/ext/artifacts/", "");
    const answer = answers[path];

    if (answer === undefined && !path.startsWith("systems")) {
      return rest(url, init);
    }

    asked.push({
      url: path,
      method: init?.method ?? "GET",
      ...(typeof init?.body === "string" && {
        body: JSON.parse(init.body) as unknown,
      }),
    });

    if (typeof answer === "object" && answer !== null && "refused" in answer) {
      const { status, error } = answer.refused as {
        status: number;
        error: string;
      };

      return Response.json({ error }, { status });
    }

    return answer === undefined
      ? Response.json({ error: `nothing at ${path}` }, { status: 404 })
      : Response.json(answer);
  };
}

function settingsShown(
  systems: Partial<Systems>,
  asked: Served[] = [],
  admin = false,
  answers: Readonly<Record<string, unknown>> = {},
): HTMLElement {
  return renderPart(
    web,
    "settings.general",
    {},
    {
      admin,
      fetch: systemsServed(asked, {
        systems: {
          systems: someSystems,
          server: "acme",
          mine: null,
          unpicked: "default",
          ...systems,
        },
        ...answers,
      }),
    },
  );
}

function systemRows(page: HTMLElement): (string | null)[] {
  return [...page.querySelectorAll("ul[aria-label='Design systems'] li")].map(
    (each) => each.textContent,
  );
}

const puts = (asked: readonly Served[]): Served[] =>
  asked.filter(({ method }) => method === "PUT");

test("Settings › General lists the design systems with the team's default, makes one the person's own and says what Pi does when nothing is picked", async () => {
  const asked: Served[] = [];
  const before = newSessions.length;
  const page = settingsShown({}, asked);

  expect(page.textContent).toContain("Loading the design systems…");

  await drawn(() => systemRows(page).length > 0);

  expect(page.querySelector("h2")?.textContent).toBe("Design systems");

  expect(systemRows(page)).toEqual([
    "AaAcme design systemTeam · v5 · used by 6Team default",
    "pPipocaBuilt in · v1 · used by 11Make my default",
    "AaConference talkMine · v2 · used by 1Make my default",
  ]);

  expect(page.textContent).not.toContain("Loading");
  expect(page.querySelector("a[href='#settings/artifacts']")).toBeNull();

  act(() => {
    named(page, "Make Conference talk my default")?.click();
  });

  await drawn(() => puts(asked).length === 1);

  expect(puts(asked)).toEqual([
    { url: "systems/settings", method: "PUT", body: { system: "talk" } },
  ]);

  const choices = page.querySelector(
    "[role=group][aria-label='When nothing is picked']",
  );

  expect(
    [...(choices?.querySelectorAll("button") ?? [])].map((each) => [
      each.textContent,
      each.getAttribute("aria-pressed"),
    ]),
  ).toEqual([
    ["Use the default", "true"],
    ["Pi asks which", "false"],
    ["No system", "false"],
  ]);

  expect(page.textContent).toContain(
    "When neither the Session nor your own default picks one.",
  );

  act(() => {
    named(page, "Pi asks which")?.click();
  });

  await drawn(() => puts(asked).length === 2);
  expect(puts(asked).at(-1)?.body).toEqual({ unpicked: "ask" });

  act(() => {
    named(page, "Ask Pi to make one from a repo")?.click();
  });

  expect(newSessions.slice(before)).toMatchObject([
    {
      text: "Make a design system from this repository's styles.",
      attachments: [{ key: "design-system:make", title: "Design system" }],
    },
  ]);

  expect(newSessions.at(-1)?.attachments[0]?.text).toContain(
    "components/<Name>/preview.html",
  );

  act(() => {
    named(page, "From a screenshot or URL")?.click();
  });

  expect(newSessions.at(-1)?.text).toBe(
    "Make a design system from the screenshot or URL I attach: ",
  );
});

test("an admin's design systems link to the server's artifact settings, and making the team's default their own clears theirs", async () => {
  const asked: Served[] = [];

  const page = settingsShown(
    { server: "pipoca", mine: "talk", unpicked: "none" },
    asked,
    true,
  );

  await drawn(() => systemRows(page).length > 0);

  expect(page.querySelector("a[href='#settings/artifacts']")?.textContent).toBe(
    "Server settings for artifacts",
  );

  expect(systemRows(page)).toEqual([
    "AaAcme design systemTeam · v5 · used by 6Make my default",
    "pPipocaBuilt in · v1 · used by 11Team defaultMake my default",
    "AaConference talkMine · v2 · used by 1My default",
  ]);

  act(() => {
    named(page, "Make Pipoca my default")?.click();
  });

  await drawn(() => puts(asked).length === 1);
  expect(puts(asked)[0]?.body).toEqual({ system: null });
});

test("Settings › Artifacts, for admins, picks the team's design system above the server's artifact settings", async () => {
  const asked: Served[] = [];

  const page = renderPart(
    web,
    "settings",
    {},
    {
      admin: true,
      fetch: systemsServed(asked, {
        systems: {
          systems: someSystems,
          server: "acme",
          mine: null,
          unpicked: "default",
        },
        "systems/server": { server: "talk" },
      }),
    },
  );

  const picker = (): HTMLSelectElement | null =>
    page.querySelector<HTMLSelectElement>("select");

  await drawn(() => picker()?.disabled === false);

  expect(page.textContent).toContain("Team design system");
  expect(page.textContent).toContain("Largest artifact");
  expect(picker()?.value).toBe("acme");

  expect(
    [...(picker()?.options ?? [])].map((each) => each.textContent),
  ).toEqual(["Acme design system", "Pipoca", "Conference talk"]);

  act(() => {
    const select = picker();

    if (select !== null) {
      Object.getOwnPropertyDescriptor(
        HTMLSelectElement.prototype,
        "value",
      )?.set?.call(select, "talk");

      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });

  await drawn(() => puts(asked).length === 1);

  expect(puts(asked)).toEqual([
    { url: "systems/server", method: "PUT", body: { system: "talk" } },
  ]);
});

test("Settings › General says the team's default once when it's the person's own too", async () => {
  const page = settingsShown({ server: "acme", mine: "acme" });

  await drawn(() => systemRows(page).length > 0);

  expect(systemRows(page)[0]).toBe(
    "AaAcme design systemTeam · v5 · used by 6Team default",
  );
});

test("Settings opens Pipoca's own system in place, whose team default switch says why it can't be turned off", async () => {
  const page = settingsShown({ server: "pipoca" }, [], true, {
    "systems/pipoca": systemView({
      ...systemSummary(),
      server: true,
      users: [],
    }),
  });

  await drawn(() => systemRows(page).length > 0);

  act(() => {
    named(page, "Pipoca")?.click();
  });

  const preview = (): HTMLDialogElement | undefined =>
    [...document.querySelectorAll("dialog")].find(
      (each) => each.querySelector("h2")?.textContent === "Pipoca",
    );

  await drawn(
    () => preview()?.querySelector("section[aria-label=Default]") !== null,
  );

  const team = preview()?.querySelector<HTMLButtonElement>(
    "section[aria-label=Default] [role=switch]",
  );

  expect(team?.disabled).toBe(true);

  expect(preview()?.textContent).toContain(
    "Pipoca's own is the team's default until you turn another system's on.",
  );
});

function systemShown(
  view: Partial<SystemView>,
  asked: Served[],
  admin: boolean,
  extra: Readonly<Record<string, unknown>> = {},
): HTMLElement {
  return renderPart(
    web,
    "overlay",
    {},
    {
      admin,
      hash: "#session-1?artifact=acme",
      fetch: systemsServed(
        asked,
        { "systems/acme?v=5": systemView(view), ...extra },
        lively(
          serving(
            {
              ...artifact({
                id: "acme",
                title: "Acme design system",
                type: "system",
                versions: 5,
              }),
              ...viewed(5),
            },
            [],
          ),
        ),
      ),
    },
  );
}

const switches = (page: HTMLElement): HTMLButtonElement[] => [
  ...page.querySelectorAll<HTMLButtonElement>(
    "section[aria-label=Default] [role=switch]",
  ),
];

const openTab = (page: HTMLElement, label: string): void => {
  act(() => {
    [...page.querySelectorAll<HTMLButtonElement>("[role=tab]")]
      .find((each) => each.textContent === label)
      ?.click();
  });
};

test("a design system opens on its colors, type and components, each component in its own sandboxed frame, and says who uses it", async () => {
  const asked: Served[] = [];

  const page = systemShown(
    {
      users: [
        { id: "d1", title: "Webhooks v2", type: "slides", version: 5 },
        { id: "d2", title: "Kickoff", type: "slides", version: 4 },
      ],
    },
    asked,
    true,
  );

  await drawn(
    () => page.querySelector("[role=tablist][aria-label=Sections]") !== null,
  );

  expect(page.textContent).toContain(
    "Design system · Team default · used by 2 artifacts",
  );

  expect(tabTexts(page)).toEqual([
    "Overview",
    "Colors 3",
    "Type 1",
    "Spacing 1",
    "Components 2",
    "Used by 2",
  ]);

  const panel = page.querySelector("[role=tabpanel]");

  expect(
    document.getElementById(panel?.getAttribute("aria-labelledby") ?? "")
      ?.textContent,
  ).toBe("Overview");

  expect(page.querySelector("section[aria-label=Colors]")?.textContent).toBe(
    "Colorsinkrgb(29 36 51)paperwhiteaccentrgb(194 65 12)",
  );

  const tiles = [
    ...page.querySelectorAll<HTMLButtonElement>(
      "section[aria-label=Components] button",
    ),
  ];

  expect(
    tiles.map((each) => [
      each.getAttribute("aria-label"),
      each.querySelector("iframe")?.getAttribute("src"),
      each.querySelector("iframe")?.getAttribute("sandbox"),
    ]),
  ).toEqual([
    [
      "Open Button",
      "/api/ext/artifacts/artifacts/acme/view?v=5&path=components%2FButton%2Fpreview.html",
      frameSandbox,
    ],
    [
      "Open KPI",
      "/api/ext/artifacts/artifacts/acme/view?v=5&path=components%2FKPI%2Fpreview.html",
      frameSandbox,
    ],
  ]);

  act(() => {
    tiles[1]?.click();
  });

  expect(
    [...document.querySelectorAll("dialog")]
      .find((each) => each.querySelector("h2")?.textContent === "KPI")
      ?.querySelector("iframe")
      ?.getAttribute("title"),
  ).toBe("KPI");

  const [team, mine] = switches(page);

  expect(team?.getAttribute("aria-checked")).toBe("true");
  expect(mine?.getAttribute("aria-checked")).toBe("false");

  act(() => {
    mine?.click();
  });

  await drawn(() => puts(asked).length === 1);

  act(() => {
    team?.click();
  });

  await drawn(() => puts(asked).length === 2);

  expect(puts(asked)).toEqual([
    { url: "systems/settings", method: "PUT", body: { system: "acme" } },
    { url: "systems/server", method: "PUT", body: { system: null } },
  ]);

  openTab(page, "Type 1");

  expect(page.querySelector("[role=tabpanel]")?.textContent).toContain(
    "Ready to cut overdisplay · 34px · line 1.15 · Title slides",
  );

  openTab(page, "Used by 2");

  expect(
    [
      ...(page.querySelector("[role=tabpanel]")?.querySelectorAll("li") ?? []),
    ].map((each) => each.textContent),
  ).toEqual([
    "Webhooks v2Slides · copy of v5",
    "KickoffSlides · copy of v4 · v5 is newer",
  ]);
});

test("someone who isn't an admin turns their own default off, with no team default switch", async () => {
  const asked: Served[] = [];
  const page = systemShown({ mine: true, server: false }, asked, false);

  await drawn(() => switches(page).length > 0);

  expect(page.textContent).not.toContain("Team default");
  expect(switches(page)).toHaveLength(1);

  act(() => {
    switches(page)[0]?.click();
  });

  await drawn(() => puts(asked).length === 1);

  expect(puts(asked)).toEqual([
    { url: "systems/settings", method: "PUT", body: { system: null } },
  ]);
});

test("Compare on a design system's own versions shows their tokens side by side and what changed", async () => {
  const page = systemShown({}, [], false, {
    "systems/acme?v=4": systemView({
      version: 4,
      tokens: {
        ...systemView().tokens,
        colors: [{ name: "ink", value: "black", usage: "" }],
      },
    }),
  });

  await drawn(() => versionMenu(page) !== undefined);

  act(() => {
    versionMenu(page)?.click();
  });

  act(() => {
    item(page, "Compare versions…")?.click();
  });

  await drawn(
    () => page.querySelector("section[aria-label='Version 4']") !== null,
  );

  expect(page.textContent).toContain("v5 changed ink, paper and accent.");
  expect(page.querySelector("section[aria-label='Version 5']")).not.toBeNull();
});

function usedShown(
  o: {
    readonly type?: ArtifactView["type"];
    readonly askable?: boolean;
    readonly designSystem?: ArtifactView["designSystem"];
  },
  asked: Served[] = [],
  answers: Readonly<Record<string, unknown>> = {},
): HTMLElement {
  return renderPart(
    web,
    "overlay",
    {},
    {
      hash: "#session-1?artifact=a1",
      fetch: systemsServed(
        asked,
        {
          "systems/acme?v=5": systemView(),
          "systems/acme?v=6": systemView({ version: 6 }),
          "systems?session=session-1": {
            systems: someSystems,
            server: "acme",
            mine: null,
            unpicked: "default",
            session: null,
          },
          ...answers,
        },
        lively(async (url, init) =>
          url.includes("/canvas?")
            ? Response.json({ error: "no canvas here" }, { status: 404 })
            : serving(
                {
                  ...artifact({ title: "Webhooks v2", type: o.type ?? "html" }),
                  ...viewed(1),
                  askable: o.askable ?? true,
                  designSystem: o.designSystem ?? {
                    id: "acme",
                    name: "Acme design system",
                    version: 5,
                    latest: 6,
                    changed: ["accent", "KPI"],
                  },
                },
                [],
              )(url, init),
        ),
      ),
    },
  );
}

function systemMenu(page: HTMLElement): HTMLButtonElement | undefined {
  return buttons(page).find(
    (each) =>
      each.getAttribute("aria-label")?.endsWith(". Design system") === true,
  );
}

async function systemItems(
  page: HTMLElement,
): Promise<(readonly [string, string | null])[]> {
  await drawn(() => systemMenu(page) !== undefined);

  act(() => {
    systemMenu(page)?.click();
  });

  return menuItems(page).map(
    (each) => [each.textContent, each.getAttribute("aria-disabled")] as const,
  );
}

test("an artifact made with a design system says which copy it keeps, and its menu asks Pi to update or switch and compares the versions", async () => {
  const asked: Served[] = [];

  const page = usedShown({}, asked, {
    "artifacts/a1/system": { asked: true },
  });

  expect(await systemItems(page)).toEqual([
    [
      "Open Acme design systemThis page has a copy of v5. v6 changed accent and KPI.",
      "false",
    ],
    ["Update to v6 (Pi redraws the page)", null],
    ["Compare v5 and v6", null],
    ["Switch to another system…", null],
  ]);

  expect(systemMenu(page)?.getAttribute("aria-label")).toBe(
    "Acme v5, v6 is newer. Design system",
  );

  act(() => {
    item(page, "Update to v6")?.click();
  });

  await drawn(() => page.textContent.includes("Pi is redrawing it with v6"));

  expect(asked.find(({ method }) => method === "POST")).toEqual({
    url: "artifacts/a1/system",
    method: "POST",
    body: { system: "acme" },
  });

  const switching = (): HTMLDialogElement | undefined =>
    [...document.querySelectorAll("dialog")].find((each) =>
      each.textContent.includes("Switch to another system"),
    );

  const radio = (value: string): HTMLInputElement | null | undefined =>
    switching()?.querySelector<HTMLInputElement>(`input[value=${value}]`);

  act(() => {
    systemMenu(page)?.click();
  });

  act(() => {
    item(page, "Switch to another system")?.click();
  });

  await drawn(() => radio("talk") !== null);

  // What it may switch to is what its Session's Pi may use.
  expect(asked.some(({ url }) => url === "systems?session=session-1")).toBe(
    true,
  );

  act(() => {
    radio("talk")?.click();
  });

  act(() => {
    named(switching() as HTMLElement, "Cancel")?.click();
  });

  // Opening it again starts from the system it has.
  act(() => {
    systemMenu(page)?.click();
  });

  act(() => {
    item(page, "Switch to another system")?.click();
  });

  await drawn(() => radio("acme")?.checked === true);

  act(() => {
    radio("talk")?.click();
  });

  act(() => {
    named(switching() as HTMLElement, "Ask Pi to switch")?.click();
  });

  await drawn(
    () => asked.filter(({ method }) => method === "POST").length === 2,
  );

  expect(asked.filter(({ method }) => method === "POST").at(-1)?.body).toEqual({
    system: "talk",
  });

  act(() => {
    systemMenu(page)?.click();
  });

  act(() => {
    item(page, "Compare v5 and v6")?.click();
  });

  await drawn(
    () => page.querySelector("section[aria-label='Version 6']") !== null,
  );

  expect(page.textContent).toContain("Comparing Acme design system v5 and v6");
  expect(page.textContent).toContain("v6 changed accent and KPI.");
  expect(page.querySelector("section[aria-label='Version 5']")).not.toBeNull();
});

test("asking Pi to redraw says when it fails as an error", async () => {
  const page = usedShown({}, [], {
    "artifacts/a1/system": {
      refused: { status: 409, error: "The Session is gone." },
    },
  });

  await systemItems(page);

  act(() => {
    item(page, "Update to v6")?.click();
  });

  await drawn(() => page.querySelector("[role=alert]") !== null);

  expect(page.querySelector("[role=alert]")?.textContent).toContain(
    "The Session is gone.",
  );

  expect(page.querySelector("[role=status]")?.textContent).toBe("");
});

test("a deck's or canvas's system menu says Pi redraws its slides or boards, and only people in its Session ask", async () => {
  expect((await systemItems(usedShown({ type: "slides" })))[1]?.[0]).toBe(
    "Update to v6 (Pi redraws the slides)",
  );

  expect(
    await systemItems(usedShown({ type: "canvas", askable: false })),
  ).toEqual([
    [
      "Open Acme design systemThis canvas has a copy of v5. v6 changed accent and KPI.",
      "false",
    ],
    [
      "Update to v6 (Pi redraws the boards)Only people in its Session can ask Pi.",
      "true",
    ],
    ["Compare v5 and v6", null],
    ["Switch to another system…Only people in its Session can ask Pi.", "true"],
  ]);
});

test("the system menu opens Pipoca's own in place, and can't open a system its viewer doesn't see", async () => {
  const pipoca = usedShown(
    {
      designSystem: {
        id: "pipoca",
        name: "Pipoca",
        version: 1,
        latest: 1,
        changed: [],
      },
    },
    [],
    { "systems/pipoca": systemView({ ...systemSummary(), users: [] }) },
  );

  expect((await systemItems(pipoca))[0]).toEqual([
    "Open PipocaThis page has a copy of v1. It's the latest.",
    "false",
  ]);

  act(() => {
    item(pipoca, "Open Pipoca")?.click();
  });

  await drawn(() =>
    [...document.querySelectorAll("dialog")].some(
      (each) =>
        each.querySelector("h2")?.textContent === "Pipoca" &&
        each.querySelector("[role=tablist]") !== null,
    ),
  );

  const unseen = usedShown({
    designSystem: {
      id: "acme",
      name: "Acme",
      version: 5,
      latest: null,
      changed: [],
    },
  });

  expect((await systemItems(unseen))[0]).toEqual([
    "Open AcmeThis page has a copy of v5. You don't see the system, so newer versions aren't shown.",
    "true",
  ]);
});

function attachShown(
  systems: Partial<Systems>,
  asked: Served[],
): SessionPartProps["session"] {
  const Fill = web.slots?.["session.attach"];
  const mounted = sessionWith({});

  const attachSlots = {
    attach: () =>
      Fill === undefined ? null : (
        <AttachMenu label="Attach files" onFiles={() => undefined}>
          <Fill session={mounted} add={() => undefined} />
        </AttachMenu>
      ),
  };

  renderPart(
    { ...web, slots: attachSlots },
    "attach",
    {},
    {
      fetch: systemsServed(asked, {
        [`systems?session=${mounted.id}`]: {
          systems: someSystems,
          server: "acme",
          mine: null,
          unpicked: "default",
          session: null,
          ...systems,
        },
        "systems/session": { session: null },
        templates: { templates: [], own: true },
      }),
    },
  );

  act(() => {
    document
      .querySelector<HTMLButtonElement>("button[aria-label='Attach files']")
      ?.click();
  });

  return mounted;
}

const attachRow = (): HTMLButtonElement | undefined =>
  [...document.querySelectorAll<HTMLButtonElement>("[role=group] button")].find(
    (each) => each.textContent.startsWith("Design system"),
  );

const pickDialog = (): HTMLDialogElement | undefined =>
  [...document.querySelectorAll("dialog")].find((each) =>
    each.textContent.includes("Design system for this Session"),
  );

const pickRadio = (value: string): HTMLInputElement | null | undefined =>
  pickDialog()?.querySelector<HTMLInputElement>(`input[value=${value}]`);

test("the + menu's Design system picks the one Pi makes this Session's decks, canvases and pages with", async () => {
  const asked: Served[] = [];
  const mounted = attachShown({}, asked);

  act(() => {
    attachRow()?.click();
  });

  await drawn(() => pickRadio("talk") !== null);

  expect(pickRadio("default")?.checked).toBe(true);

  expect(pickDialog()?.textContent).toContain(
    "Use the defaultThe team's: Acme design system",
  );

  expect(pickDialog()?.textContent).toContain(
    "None herePi writes its own styles in this Session.",
  );

  act(() => {
    pickRadio("none")?.click();
  });

  act(() => {
    named(pickDialog() as HTMLElement, "Use it here")?.click();
  });

  await drawn(() => puts(asked).length === 1);

  act(() => {
    document
      .querySelector<HTMLButtonElement>("button[aria-label='Attach files']")
      ?.click();
  });

  act(() => {
    attachRow()?.click();
  });

  await drawn(() => pickRadio("default") !== null);

  act(() => {
    pickRadio("default")?.click();
  });

  act(() => {
    named(pickDialog() as HTMLElement, "Use it here")?.click();
  });

  await drawn(() => puts(asked).length === 2);

  expect(puts(asked)).toEqual([
    {
      url: "systems/session",
      method: "PUT",
      body: { session: mounted.id, system: "none" },
    },
    {
      url: "systems/session",
      method: "PUT",
      body: { session: mounted.id, system: null },
    },
  ]);
});

test("the + menu's Design system row names what the Session picked, and nothing picked falls back to the person's own default", async () => {
  attachShown({ session: "acme", mine: "talk" }, []);

  await drawn(() => attachRow()?.textContent === "Design system: Acme…");

  act(() => {
    attachRow()?.click();
  });

  await drawn(() => pickRadio("acme")?.checked === true);

  expect(pickDialog()?.textContent).toContain(
    "Use the defaultYours: Conference talk",
  );
});

test("the + menu's Design system row says when the Session picked none, and nothing picked follows the person's choice", async () => {
  attachShown({ session: "none", unpicked: "ask" }, []);

  await drawn(() => attachRow()?.textContent === "Design system: none…");

  act(() => {
    attachRow()?.click();
  });

  await drawn(() => pickRadio("none")?.checked === true);

  expect(pickDialog()?.textContent).toContain(
    "Use the defaultPi asks which, as your settings say",
  );
});
