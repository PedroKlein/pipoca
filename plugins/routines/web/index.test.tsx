import { expect, test } from "bun:test";
import { renderPart, sessionWith } from "@pipoca/plugins/web/testing";
import { until } from "@pipoca/testing/until";
import { act } from "react";
import type { WakeUp } from "../src/model";
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

const wakeUp: WakeUp = {
  id: "w1",
  sessionId: "session-1",
  dueAt: "2026-11-05T12:00:00.000Z",
  reason: "Check CI on #552",
  message: "See whether CI passed.",
};

test("lists the Session's pending wake-ups above the composer and cancels one", async () => {
  const asked: string[] = [];
  let pending = [wakeUp];

  const page = renderPart(
    web,
    "session.composer",
    { session: sessionWith({}) },
    {
      fetch: async (url, init) => {
        asked.push(`${init?.method ?? "GET"} ${url}`);

        if (init?.method === "DELETE") {
          pending = [];

          return Promise.resolve(Response.json({ ok: true }));
        }

        return Promise.resolve(Response.json(pending));
      },
    },
  );

  // Inside act, so React draws the answer once the request is in.
  await act(async () => until(() => asked.length > 0));

  expect(page.querySelector("ul")?.getAttribute("aria-label")).toBe("Wake-ups");

  expect(page.textContent).toContain("Check CI on #552");

  await act(async () => {
    page
      .querySelector<HTMLButtonElement>(
        "button[aria-label='Cancel wake-up: Check CI on #552']",
      )
      ?.click();

    await until(() => asked.length > 1);
  });

  await act(async () => until(() => asked.length > 2));

  expect(page.querySelector("li")).toBeNull();

  expect(asked).toEqual([
    "GET /api/ext/routines/wakeups?session=session-1",
    "DELETE /api/ext/routines/wakeups/w1",
    "GET /api/ext/routines/wakeups?session=session-1",
  ]);
});

test("draws a wake-up's notice, not as text the person typed", () => {
  const page = renderPart(web, "notice:wakeup", {
    text: "Wake-up you scheduled: Check CI",
    data: { reason: "Check CI" },
  });

  expect(page.textContent).toBe("Woke up: Check CI");
});

test("draws a routine's message to a Session with the routine's title", () => {
  const page = renderPart(web, "notice:routine", {
    text: "Summarise the new issues.",
    data: { title: "Daily issues" },
  });

  expect(page.textContent).toBe(
    "Routine: Daily issuesSummarise the new issues.",
  );
});
