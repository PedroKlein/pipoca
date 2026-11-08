import { expect, test } from "bun:test";
import { renderPart, sessionWith } from "@pipoca/plugins/web/testing";
import { until } from "@pipoca/testing/until";
import { act } from "react";
import { web } from "./index";

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

const routine = {
  title: "Docs from merges",
  when: [
    {
      kind: "event",
      event: "git-hosts.pull_request",
      where: [
        { field: "merged", is: true },
        { field: "repository", inGroup: true },
      ],
    },
  ],
  do: {
    kind: "session",
    prompt: "Update the docs.",
    workspace: {
      kind: "clone",
      repository: "https://github.com/acme/docs-site",
    },
    profile: "p1",
    environment: "pods",
    as: "pipoca-docs",
  },
  limits: { dailySpend: 10 },
};

const routes: readonly (readonly [string, unknown])[] = [
  [
    "/events",
    [
      {
        type: "git-hosts.pull_request",
        title: "Pull request",
        fields: {
          type: "object",
          properties: {
            repository: { type: "string" },
            merged: { type: "boolean" },
          },
        },
      },
    ],
  ],
  [
    "/heard",
    {
      count: 1,
      others: 0,
      events: [
        {
          id: "h1",
          at: "2026-11-05T14:02:00.000Z",
          type: "git-hosts.pull_request",
          fields: { repository: "acme/api", number: 2214 },
        },
      ],
    },
  ],
  ["/groups", [{ name: "shop", title: "Shop platform" }]],
];

function shown(input: object, given: string[]): HTMLElement {
  return renderPart(
    web,
    "session.permission:routines",
    {
      session: sessionWith({}),
      title: "Create the team routine “docs-from-merges”? Updates docs-site.",
      input,
      onAnswer: (answer: string) => {
        given.push(answer);
      },
    },
    {
      fetch: async (url) => {
        const answer = routes.find(([end]) => url.endsWith(end))?.[1] ?? [
          { id: "p1", name: "Docs" },
        ];

        return Promise.resolve(Response.json(answer));
      },
    },
  );
}

async function settled(done: () => boolean): Promise<void> {
  await until(async () => {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));

    return done();
  });
}

const press = async (root: HTMLElement, name: string): Promise<void> => {
  await act(async () => {
    [...root.querySelectorAll("button")]
      .find((each) => each.textContent === name)
      ?.click();

    await Promise.resolve();
  });
};

test("asking to create a team routine shows it as a card, and Create or Not now answers", async () => {
  const answers: string[] = [];

  const page = shown(
    { action: "create", name: "docs-from-merges", routine, group: "shop" },
    answers,
  );

  const card = page.querySelector<HTMLElement>("[aria-label='Routine']");

  await settled(() => card?.textContent.includes("Profile Docs") === true);

  expect(card?.textContent).toBe(
    "Team routineDocs from mergesOpen in formWhen a pull request is merged in any repo of Shop platform, follow the instructions in acme/docs-site.Acts as pipoca-docs · team Profile Docs · pods · $10 a day",
  );

  await settled(() => page.textContent.includes("acme/api#2214"));

  expect(page.querySelector("h2")?.textContent).toBe(
    "Create the team routine “docs-from-merges”? Updates docs-site. It tests once now on acme/api#2214.",
  );

  await press(page, "Not now");
  await press(page, "Create");

  expect(answers).toEqual(["deny", "once"]);
});

test("asking to delete a routine shows only the question", async () => {
  const answers: string[] = [];
  const page = shown({ action: "remove", name: "docs-from-merges" }, answers);

  expect(page.querySelector("[aria-label='Routine']")).toBeNull();

  await press(page, "Delete");

  expect(answers).toEqual(["once"]);
});
