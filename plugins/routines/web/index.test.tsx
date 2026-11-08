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

test("a routine's page says why it paused itself, when it resumes and what it spent today", async () => {
  const asked: string[] = [];
  // The routines page, as the slot the test renders.
  const slots = { page: web.pages?.[0]?.Page };

  const detail = {
    name: "fix",
    title: "Fix issues",
    paused:
      "Paused until tomorrow: it spent 20.00 today, and its daily cap is 20.",
    pausedUntil: "2026-11-09T00:00:00.000Z",
    nextAt: null,
    lastRun: null,
    file: "{}",
    routine: {
      title: "Fix issues",
      when: [{ kind: "webhook" }],
      do: { kind: "message", prompt: "Fix it.", session: "s1" },
      limits: { dailySpend: 20 },
    },
    runs: [],
    spentToday: 20,
    createdBy: null,
    changedBy: null,
    history: [],
  };

  const page = renderPart(
    { ...web, slots },
    "page",
    { path: "fix" },
    {
      fetch: async (url) => {
        asked.push(url);

        return Promise.resolve(Response.json(detail));
      },
    },
  );

  await act(async () => until(() => asked.length > 0));

  expect(page.textContent).toContain(
    `Paused until tomorrow: it spent 20.00 today, and its daily cap is 20. Resumes ${new Date(detail.pausedUntil).toLocaleString()}.`,
  );

  expect(page.textContent).toContain(
    "Spent today: 20.00 of its daily cap of 20",
  );
});

test("a run's row shows what it proposed and where each stands, and a waiting one is approved there", async () => {
  const asked: string[] = [];
  const slots = { page: web.pages?.[0]?.Page };

  const proposal = {
    action: "git-hosts.comment",
    title: "Comment",
    url: null,
    proposedAt: "2026-11-08T10:00:00.000Z",
  };

  const detail = {
    name: "triage",
    title: "Triage",
    paused: null,
    pausedUntil: null,
    nextAt: null,
    lastRun: null,
    file: "{}",
    routine: {
      title: "Triage",
      when: [{ kind: "webhook" }],
      do: { kind: "message", prompt: "Triage.", session: "s1" },
      proposes: "never",
    },
    runs: [
      {
        id: "r1",
        firedAt: "2026-11-08T10:00:00.000Z",
        cause: "event",
        sessionId: "s2",
        outcome: "ok",
        reason: null,
        endedAt: null,
        proposes: true,
        dryRun: true,
        proposals: [
          {
            ...proposal,
            id: "p1",
            input: { number: 3, body: "Looks like a duplicate of #2." },
            state: "waiting",
            result: null,
          },
          {
            ...proposal,
            id: "p2",
            input: { number: 3, body: "Spam" },
            state: "refused",
            result: "the routine allows comment at most 1 time a run",
          },
        ],
      },
    ],
    spentToday: 0,
    createdBy: null,
    changedBy: null,
    history: [],
  };

  const page = renderPart(
    { ...web, slots },
    "page",
    { path: "triage" },
    {
      fetch: async (url, init) => {
        asked.push(`${init?.method ?? "GET"} ${url}`);

        return Promise.resolve(Response.json(detail));
      },
    },
  );

  await act(async () => until(() => asked.length > 0));

  const proposals = page.querySelector("ul[aria-label='Proposals']");

  expect(proposals?.textContent).toContain("Waiting for approval");
  expect(proposals?.textContent).toContain("Looks like a duplicate of #2.");

  expect(proposals?.textContent).toContain(
    "RefusedCommentthe routine allows comment at most 1 time a run",
  );

  expect(page.textContent).toContain("Dry run");

  expect(page.textContent).toContain(
    "Its runs write directly, so text strangers write",
  );

  await act(async () => {
    [...page.querySelectorAll("button")]
      .find((button) => button.textContent === "Approve")
      ?.click();

    await until(() => asked.length > 1);
  });

  expect(asked[1]).toBe(
    "POST /api/ext/routines/routines/triage/proposals/p1/approve",
  );
});

test("a waiting run shows its question and who it is for, and the page who made and changed the routine", async () => {
  const asked: string[] = [];
  const slots = { page: web.pages?.[0]?.Page };

  const detail = {
    name: "triage",
    title: "Triage",
    paused: null,
    pausedUntil: null,
    nextAt: null,
    lastRun: null,
    file: "{}",
    runs: [
      {
        id: "r1",
        firedAt: "2026-11-08T10:00:00.000Z",
        cause: "event",
        sessionId: "s2",
        outcome: "waiting",
        reason: null,
        endedAt: null,
        questions: [
          {
            id: "q1",
            prompts: ["Which label fits?"],
            closesAt: "2026-11-09T10:00:00.000Z",
          },
        ],
        askedFor: ["Bo"],
      },
    ],
    spentToday: 0,
    createdBy: "Ana",
    changedBy: "Bo",
    history: [
      { by: "Bo", change: "changed", at: "2026-11-08T09:00:00.000Z" },
      { by: "Ana", change: "created", at: "2026-11-07T09:00:00.000Z" },
    ],
  };

  const page = renderPart(
    { ...web, slots },
    "page",
    { path: "triage" },
    {
      fetch: async (url) => {
        asked.push(url);

        return Promise.resolve(Response.json(detail));
      },
    },
  );

  await act(async () => until(() => asked.length > 0));

  expect(page.textContent).toContain("Waiting for a person");

  expect(
    page.querySelector("ul[aria-label='Questions']")?.textContent,
  ).toContain(
    `Which label fits?For Bo. Waits until ${new Date("2026-11-09T10:00:00.000Z").toLocaleString()}.`,
  );

  expect(page.textContent).toContain("Made by Ana. Changed last by Bo.");
  expect(page.textContent).toContain("Made by Ana");
});
