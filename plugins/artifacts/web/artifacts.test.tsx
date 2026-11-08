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

test("a published artifact shows in the chat as a card that opens it", () => {
  const page = renderPart(web, "session.toolCall:publish_artifact", {
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
  });

  const card = page.querySelector("[aria-label='Artifact Sales report']");

  expect(card?.textContent).toContain("Version 2");

  expect(card?.querySelector("a")?.getAttribute("href")).toBe(
    "#plugin/artifacts/a1",
  );
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

test("the Session panel's Artifacts tab shows the newest artifact the Session published", async () => {
  const summary = artifact({ title: "Checkout latency", versions: 3 });

  const asked: string[] = [];

  const page = renderPart(
    web,
    "session.header",
    { session: sessionWith({}) },
    {
      fetch: async (url) => {
        await Promise.resolve();

        asked.push(url);

        return Response.json(
          url.endsWith("/sessions/session-1/artifacts")
            ? { artifacts: [summary] }
            : { ...summary, ...viewed(3) },
        );
      },
    },
  );

  // React draws what loaded once each act ends: the list, then the newest.
  await act(async () => until(() => asked.length === 1));
  await act(async () => until(() => asked.length === 2));

  act(() => {
    page
      .querySelector<HTMLButtonElement>("button[aria-label^=Artifacts]")
      ?.click();
  });

  expect(page.querySelector("iframe")?.getAttribute("title")).toBe(
    "Checkout latency, version 3",
  );

  expect(
    page
      .querySelector("[role=dialog] a[aria-label='Open on its own page']")
      ?.getAttribute("href"),
  ).toBe("#plugin/artifacts/a1");
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
      createdAt: 0,
    })),
    access: "steer",
    shares: [],
    pinned: false,
  };
}

const slots = { page: web.pages?.[0]?.Page };

test("the Artifacts page shows yours, the ones shared with you and the team's, and finds them by title or Session", async () => {
  const asked: string[] = [];

  const page = renderPart(
    { ...web, slots },
    "page",
    { path: "" },
    {
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
});

test("an earlier version says the link shows the latest, lists every version and restores", async () => {
  const asked: { url: string; method: string }[] = [];

  const page = renderPart(
    { ...web, slots },
    "page",
    { path: "a1/v/2" },
    {
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

  await act(async () => until(() => asked.length === 2));

  expect(page.textContent).toContain(
    "You're looking at version 2. People with the link see version 3 unless the link names a version.",
  );

  expect(page.textContent).toContain(
    "Ana · from Why did checkout slow down? · Only you",
  );

  expect(
    [...page.querySelectorAll("ol[aria-label=Versions] a")].map((each) => [
      each.getAttribute("href"),
      each.getAttribute("aria-current"),
    ]),
  ).toEqual([
    ["#plugin/artifacts/a1", null],
    ["#plugin/artifacts/a1/v/2", "page"],
    ["#plugin/artifacts/a1/v/1", null],
  ]);

  expect(page.textContent).toContain("Pi · ");
  expect(page.textContent).toContain("first draft");

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

  expect(page.textContent).toContain("people who comment steer the Session");

  await act(async () => {
    button("Save")?.click();
    await until(() => asked.some(({ url }) => url.endsWith("/shares")));
  });

  expect(asked.at(-1)).toEqual({
    url: "/api/ext/artifacts/artifacts/a1/shares",
    body: { shares: [{ name: "Bo", role: "comment" }] },
  });
});
