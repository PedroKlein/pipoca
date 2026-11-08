import { expect, test } from "bun:test";
import { renderPart, sessionWith } from "@pipoca/plugins/web/testing";
import { until } from "@pipoca/testing/until";
import { act } from "react";
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
  const summary = {
    id: "a1",
    title: "Checkout latency",
    kind: "html",
    sessionId: "session-1",
    versions: 3,
    updatedAt: 0,
  };

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
            : {
                ...summary,
                history: [],
                access: "steer",
                shares: [],
                pinned: false,
              },
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

  expect(page.querySelector("[role=dialog] a")?.getAttribute("href")).toBe(
    "#plugin/artifacts/a1",
  );
});
