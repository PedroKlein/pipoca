import { expect, test } from "bun:test";
import { renderPart, sessionWith } from "@pipoca/plugins/web/testing";
import { until } from "@pipoca/testing/until";
import { act } from "react";
import type { ArtifactSummary } from "../src/artifacts";
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

  const card = page.querySelector<HTMLAnchorElement>(
    "a[aria-label='Artifact Sales report']",
  );

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

  const card = page.querySelector("[aria-label='Artifact Notes']");

  expect(card?.textContent).toContain("notes.docx can't be an artifact");
  expect(card?.querySelector("a")).toBeNull();
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
    "#plugin/artifacts/a1",
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

test("an artifact opens over the page with what can be done with it, and closes back to the page", async () => {
  const summary = artifact({ title: "Checkout latency", versions: 3 });
  const asked: string[] = [];

  const page = renderPart(
    web,
    "overlay",
    {},
    {
      hash: "#session-1?artifact=a1",
      fetch: async (url) => {
        await Promise.resolve();

        asked.push(url);

        return Response.json(
          url.endsWith("/comments")
            ? { comments: [] }
            : { ...summary, ...viewed(3), openComments: 2 },
        );
      },
    },
  );

  // The artifact loads, and then what its comments quote.
  await act(async () => until(() => asked.length === 1));
  await act(async () => until(() => asked.length === 2));

  const dialog = page.querySelector("dialog");

  expect(dialog?.querySelector("h2")?.textContent).toBe("Checkout latency");

  expect(dialog?.textContent).toContain(
    "From “Why did checkout slow down?” · Only you",
  );

  expect(page.querySelector("iframe")?.getAttribute("title")).toBe(
    "Checkout latency, version 3",
  );

  const button = (label: string): HTMLButtonElement | undefined =>
    [...page.querySelectorAll<HTMLButtonElement>("button")].find(
      (each) =>
        each.getAttribute("aria-label") === label || each.textContent === label,
    );

  expect(button("Versions")?.textContent).toBe("Version 3 · latest");
  expect(button("Comment2")).toBeDefined();
  expect(button("Share")).toBeDefined();

  expect(
    page
      .querySelector("a[aria-label='Open in a new tab']")
      ?.getAttribute("href"),
  ).toBe("#plugin/artifacts/a1");

  act(() => {
    button("More")?.click();
  });

  expect(
    [...page.querySelectorAll("[role=menu] button")].map(
      (each) => each.textContent,
    ),
  ).toEqual([
    "Download",
    "Copy link",
    "Copy link to version 3",
    "Pin to sidebar",
    "Go to the Session",
    "Delete artifact…",
  ]);

  act(() => {
    button("More")?.click();
    button("Versions")?.click();
  });

  expect(
    [...page.querySelectorAll("[role=menu] button")].map(
      (each) => each.textContent,
    ),
  ).toEqual([
    "Version 3latest · Pi · just now",
    "Version 2Pi · just now",
    "Version 1Pi · just now · first draft",
    "Compare versions…",
  ]);

  await act(async () => {
    button("Version 1Pi · just now · first draft")?.click();
    await until(() => location.hash.includes("v=1"));
  });

  expect(location.hash).toBe("#session-1?artifact=a1&v=1");

  expect(dialog?.textContent).toContain(
    "You're viewing version 1. The latest is version 3.",
  );

  await act(async () => {
    button("Close")?.click();
    await until(() => !location.hash.includes("?"));
  });

  expect(location.hash).toBe("#session-1");
  expect(page.querySelector("dialog")).toBeNull();
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

  expect(web.pages?.[0]?.bare?.("a1/v/2")).toBe(true);
  expect(web.pages?.[0]?.bare?.("")).toBe(false);

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

  await until(() => location.hash === "#plugin/artifacts/a1");
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
    button("Comment")?.click();
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
