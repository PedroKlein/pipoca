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

test("lets the person pick the email to commit as on each host they connected, beside the default", async () => {
  const sent: unknown[] = [];
  const asked: string[] = [];

  const answers: Readonly<Record<string, unknown>> = {
    "/api/ext/git-hosts/account": {
      admin: false,
      hosts: [
        {
          host: "github.com",
          label: "GitHub",
          oauth: true,
          reach: { private: false, through: [] },
        },
        {
          host: "git.example.com",
          label: "Forge",
          oauth: false,
          reach: { private: false, through: [] },
        },
      ],
      connections: [{ host: "github.com", login: "pedro-gh", connectedAt: "" }],
    },
    "/api/ext/git-hosts/commit-as": {
      default: { name: "Pedro", email: "pedro@example.com" },
      hosts: [],
    },
    "/api/ext/git-hosts/emails/github.com": {
      name: "Pedro Klein",
      emails: ["pedro@example.com", "pedro@work.example"],
    },
  };

  const page = renderPart(
    web,
    "settings.accounts",
    {},
    {
      fetch: async (asking, init) => {
        asked.push(asking);

        if (init?.method === "POST" && typeof init.body === "string") {
          sent.push(JSON.parse(init.body));
        }

        return Promise.resolve(Response.json(answers[asking] ?? null));
      },
    },
  );

  const form = (label: string) =>
    page.querySelector<HTMLFormElement>(
      `form[aria-label='Commit as on ${label}']`,
    );

  // The account, then who the person commits as, then GitHub's emails, each
  // drawn once its act ends.
  for (const count of [1, 2, 3]) {
    await act(async () => until(() => asked.length >= count));
  }

  const github = form("GitHub");

  expect(
    [...(github?.querySelectorAll("option") ?? [])].map(({ value }) => value),
  ).toEqual(["", "pedro@example.com", "pedro@work.example"]);

  expect(github?.querySelector<HTMLInputElement>("[name=name]")?.value).toBe(
    "Pedro Klein",
  );

  expect(form("Forge")).toBeNull();

  expect(
    form("Default")?.querySelector<HTMLInputElement>("[name=email]")?.value,
  ).toBe("pedro@example.com");

  const select = github?.querySelector("select");

  if (select) {
    select.value = "pedro@work.example";
  }

  await act(async () => {
    github?.requestSubmit();
    await until(() => sent.length > 0);
  });

  expect(sent).toEqual([
    { host: "github.com", name: "Pedro Klein", email: "pedro@work.example" },
  ]);
});
