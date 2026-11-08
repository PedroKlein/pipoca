import { expect, test } from "bun:test";
import { renderPart } from "@pipoca/plugins/web/testing";
import { until } from "@pipoca/testing/until";
import { act } from "react";
import type { RoutineDetail } from "../src/model";
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

test("a routine's page says what its watch, collecting trigger, check and results do, and where a run's result went", async () => {
  const asked: string[] = [];
  const slots = { page: web.pages?.[0]?.Page };
  const checkedAt = "2026-11-08T10:00:00.000Z";

  const detail: RoutineDetail = {
    name: "digest",
    title: "Digest",
    paused: null,
    pausedUntil: null,
    nextAt: null,
    lastRun: null,
    file: "{}",
    fedBy: [],
    feeds: [],
    routine: {
      title: "Digest",
      when: [
        {
          kind: "watch",
          url: "https://example.com/status",
          every: "15m",
          path: "state",
        },
        {
          kind: "event",
          event: "git-hosts.issue",
          collect: { cron: "0 17 * * 5" },
          check: { use: "git-hosts.failedTwice" },
        },
      ],
      do: {
        kind: "session",
        prompt: "Sum it up.",
        workspace: { kind: "folder", path: "/srv" },
      },
      results: [{ to: "slack.channel", with: { channel: "C1" } }],
    },
    runs: [
      {
        id: "r1",
        firedAt: checkedAt,
        cause: "event",
        sessionId: "s1",
        outcome: "ok",
        reason: "Summed up 3 issues.",
        endedAt: checkedAt,
        results: [
          {
            destination: "slack.channel",
            state: "sent",
            text: "Posted to C1",
          },
          {
            destination: "email.mail",
            state: "failed",
            text: "no mailbox",
          },
        ],
      },
    ],
    spentToday: 0,
    createdBy: null,
    changedBy: null,
    history: [],
    checks: [{ trigger: 1, at: checkedAt, passed: false }],
    watches: [{ trigger: 0, at: checkedAt, error: "it answered 500" }],
  };

  const page = renderPart(
    { ...web, slots },
    "page",
    { path: "digest" },
    {
      fetch: async (url) => {
        asked.push(url);

        return Promise.resolve(Response.json(detail));
      },
    },
  );

  await act(async () => until(() => asked.length > 0));

  const at = new Date(checkedAt).toLocaleString();

  expect(page.textContent).toContain(
    `Watches https://example.com/status at state every 15m. Fetched ${at}: it answered 500.`,
  );

  expect(page.textContent).toContain(
    "Gathers git-hosts.issue and runs once on 0 17 * * 5 with what it gathered.",
  );

  expect(page.textContent).toContain(
    `Checks first with git-hosts.failedTwice. Last said no ${at}.`,
  );

  expect(page.textContent).toContain(
    "Results go to slack.channel when a run ends.",
  );

  expect(page.querySelector("ul[aria-label='Results']")?.textContent).toBe(
    "Sentslack.channelPosted to C1Not sentemail.mailno mailbox",
  );
});
