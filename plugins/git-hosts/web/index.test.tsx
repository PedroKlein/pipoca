import { expect, test } from "bun:test";
import { renderPart, sessionWith } from "@pipoca/plugins/web/testing";
import { until } from "@pipoca/testing/until";
import { act } from "react";
import type { PullWatch, WatchedPull } from "../src/model";
import { web } from "./index";

const url = "https://git.example.com/acme/dotfiles/pull/7";

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

const watch: PullWatch = {
  id: "w1",
  url,
  title: "Tidy the dotfiles",
  state: "open",
  checks: { passed: 2, failed: 1, pending: 0 },
  conflicts: true,
  changesRequested: false,
  autoFix: true,
  error: null,
};

test("fills a pull request's status with its checks and conflicts on the host", async () => {
  const asked: string[] = [];

  const page = renderPart(
    web,
    "pullRequest.status",
    { session: sessionWith({}), url },
    {
      fetch: async (asking) => {
        asked.push(asking);

        return Promise.resolve(Response.json([watch]));
      },
    },
  );

  // Inside act, so React draws the answer even where an earlier test file
  // took its page down.
  await act(async () => until(() => asked.length > 0));

  expect(page.textContent).toContain("1 failed");

  expect(asked).toEqual(["/api/ext/git-hosts/pull-requests?session=session-1"]);

  expect(
    [...page.querySelectorAll("[data-state], span")].map(
      (each) => each.textContent,
    ),
  ).toContain("Conflicts");
});

test("draws the news Pipoca sent about a pull request", () => {
  const page = renderPart(web, "notice:pull_request", {
    text: "",
    data: { url, news: ["Checks failed on abc1234: test"] },
  });

  expect(page.querySelector("a")?.getAttribute("href")).toBe(url);

  expect(page.querySelector("li")?.textContent).toBe(
    "Checks failed on abc1234: test",
  );
});

test("lists the team's watched pull requests on the hub, each with its repository and a link", async () => {
  const asked: string[] = [];
  const pull: WatchedPull = { ...watch, repository: "acme/dotfiles" };
  const Panel = web.panels?.["pulls"]?.Panel;

  const page = renderPart(
    { ...web, slots: { ...(Panel && { panel: Panel }) } },
    "panel",
    {},
    {
      fetch: async (asking) => {
        asked.push(asking);

        return Promise.resolve(Response.json([pull]));
      },
    },
  );

  await act(async () => until(() => asked.length > 0));

  expect(asked).toEqual(["/api/ext/git-hosts/team/watched"]);

  const item = page.querySelector("ul[aria-label='Pull requests'] li");

  expect(item?.querySelector("a")?.getAttribute("href")).toBe(url);
  expect(item?.textContent).toContain("Tidy the dotfiles");
  expect(item?.textContent).toContain("acme/dotfiles");
  expect(item?.textContent).toContain("1 failed");
});
