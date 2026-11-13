import { expect, test } from "bun:test";
import { renderPart } from "@pipoca/plugins/web/testing";
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

const slots = { page: web.pages?.[0]?.Page };

const events = [
  {
    type: "git-hosts.pull_request",
    title: "Pull request",
    fields: {
      type: "object",
      properties: {
        repository: { type: "string" },
        action: {
          type: "string",
          description: "What happened, such as opened, labeled or closed.",
        },
        merged: { type: "boolean" },
        member: { type: "boolean" },
        labels: { type: "array", items: { type: "string" } },
      },
    },
  },
  {
    type: "git-hosts.issue",
    title: "Issue",
    fields: {
      type: "object",
      properties: { repository: { type: "string" } },
    },
  },
];

const drafted = {
  title: "Docs from merges",
  when: [
    {
      kind: "event",
      event: "git-hosts.pull_request",
      where: [
        { field: "merged", is: true },
        { field: "repository", oneOf: ["acme/shop", "acme/api"] },
      ],
    },
  ],
  do: {
    kind: "session",
    agent: "writer",
    prompt: "Update the docs.",
    workspace: { kind: "clone", repository: "https://github.com/acme/docs" },
  },
};

const merge = {
  id: "h1",
  at: "2026-11-05T14:02:00.000Z",
  type: "git-hosts.pull_request",
  fields: {
    repository: "acme/api",
    number: 2214,
    title: "Fix totals",
    action: "closed",
    merged: true,
    member: true,
  },
};

interface Asked {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
}

// The routes the form reads, with what each answers here.
function known({ url }: Asked): unknown {
  if (url.endsWith("/events")) {
    return events;
  }

  if (url.endsWith("/heard")) {
    return { count: 1, others: 3, events: [merge] };
  }

  if (url.endsWith("/groups")) {
    return [{ name: "shop", title: "Shop platform" }];
  }

  if (url.includes("/api/profiles")) {
    return [{ id: "p1", name: "Docs" }];
  }

  if (url.endsWith("/api/plugins")) {
    return [{ id: "git-hosts", title: "Git hosts" }];
  }

  if (url.endsWith("/api/me/model-choices")) {
    return { favorites: [], recent: [], hidden: [] };
  }

  if (url.endsWith("/api/environments")) {
    return [
      {
        id: "env-faraday",
        name: "faraday",
        reaches: [],
        models: [{ provider: "faux", id: "faux-deep", name: "Faux deep" }],
        hiddenModels: [],
        unavailableModels: [],
      },
    ];
  }

  return undefined;
}

function page(answers: (asked: Asked) => unknown = () => undefined) {
  const asked: Asked[] = [];

  const shown = renderPart(
    { ...web, slots },
    "page",
    { path: "new" },
    {
      fetch: async (url, init) => {
        const each = {
          method: init?.method ?? "GET",
          url,
          body:
            typeof init?.body === "string"
              ? (JSON.parse(init.body) as unknown)
              : undefined,
        };

        asked.push(each);

        const answer = answers(each) ?? known(each) ?? [];

        return Promise.resolve(
          answer instanceof Response ? answer : Response.json(answer),
        );
      },
    },
  );

  return { shown, asked };
}

const typeInto = async (
  element: HTMLInputElement | HTMLTextAreaElement | null,
  value: string,
): Promise<void> => {
  await act(async () => {
    if (element === null) {
      throw new Error("no such field");
    }

    Reflect.set(
      Object.getPrototypeOf(element) as object,
      "value",
      value,
      element,
    );

    element.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
};

const click = async (
  root: HTMLElement,
  name: string,
  done: () => boolean = () => true,
): Promise<void> => {
  await settled(() =>
    [...root.querySelectorAll("button")].some(
      (each) =>
        each.textContent === name || each.getAttribute("aria-label") === name,
    ),
  );

  await act(async () => {
    const button = [...root.querySelectorAll("button")].find(
      (each) =>
        each.textContent === name || each.getAttribute("aria-label") === name,
    );

    if (button === undefined) {
      throw new Error(`no button ${name}`);
    }

    button.click();
    await Promise.resolve();
  });

  await settled(done);
};

// Lets requests answer and React draw, a short act at a time, until done.
async function settled(done: () => boolean): Promise<void> {
  await until(async () => {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));

    return done();
  });
}

function draftOf(shown: HTMLElement): HTMLElement {
  const card = shown.querySelector<HTMLElement>("[aria-label='Draft']");

  if (card === null) {
    throw new Error("no draft");
  }

  return card;
}

test("one sentence is drafted into a sentence with chips, in the group and Profile picked, and saving tests it on the newest match", async () => {
  let draft: object = {
    id: "d1",
    sentence: "",
    state: "drafting",
    sessionId: "s1",
  };

  const { shown, asked } = page(({ method, url }) => {
    if (method === "POST" && url.endsWith("/drafts")) {
      return draft;
    }

    if (method === "PUT") {
      return {};
    }

    return url.includes("/drafts/") ? draft : undefined;
  });

  await typeInto(
    shown.querySelector("textarea[aria-label='Describe the routine']"),
    "When a pull request merges in shop or api, update the docs in docs-site",
  );

  await click(shown, "Group: No group");
  await click(shown, "Shop platform");
  await click(shown, "Profile: Default Profile");
  await click(shown, "Docs");

  expect(shown.querySelector("[aria-label='Profile: Docs']")?.textContent).toBe(
    "Docs",
  );

  await click(shown, "Draft it", () =>
    asked.some(({ url }) => url.endsWith("/drafts/d1")),
  );

  expect(asked.find(({ method }) => method === "POST")).toMatchObject({
    url: "/api/ext/routines/drafts",
    body: {
      sentence:
        "When a pull request merges in shop or api, update the docs in docs-site",
    },
  });

  expect(shown.textContent).toContain("Drafting…");

  draft = {
    ...draft,
    state: "ready",
    name: "docs-from-merges",
    routine: drafted,
    error: "do.workspace.repository must be a repository URL",
  };

  await settled(() => shown.querySelector("[aria-label='Draft']") !== null);

  const card = draftOf(shown);

  await settled(() => card.textContent.includes("pull request"));

  expect(card.querySelector("p")?.textContent).toBe(
    "When a pull request is merged in acme/shop or acme/api, run the writer agent in acme/docs.",
  );

  expect(
    card.querySelector<HTMLInputElement>("input[aria-label='Title']")?.value,
  ).toBe("Docs from merges");

  expect(
    card.querySelector("[aria-label='Change the name: docs-from-merges']"),
  ).not.toBeNull();

  expect(card.textContent).toContain(
    "do.workspace.repository must be a repository URL. Change it with the chips or in the JSON.",
  );

  expect(
    [
      ...card.querySelectorAll(
        "ul[aria-label='Defaults'] > li > span:last-child",
      ),
    ].map((each) => each.textContent),
  ).toEqual([
    "One run at a time: what fires while one is going is skipped.",
    "Runs in the group Shop platform, so they read its memory and count toward its budget.",
    "Runs on the Profile Docs and acts on git as you; runs that events start propose what they write.",
    "No daily spend cap. Set one under More.",
  ]);

  expect(card.querySelector("summary")?.textContent).toBe(
    "More: same work, limits, model, workflow",
  );

  await typeInto(card.querySelector("input[aria-label='Daily spend']"), "10");

  // The Environment is picked by name from the person's own, not typed.
  await settled(
    () =>
      card.querySelector(
        "select[aria-label='Environment'] option[value='env-faraday']",
      )?.textContent === "faraday",
  );

  await act(async () => {
    const environment = card.querySelector<HTMLSelectElement>(
      "select[aria-label='Environment']",
    );

    if (environment === null) {
      throw new Error("no Environment field");
    }

    environment.value = "env-faraday";
    environment.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();
  });

  expect(card.textContent).toContain(
    "At most $10 a day, then it pauses until tomorrow.",
  );

  await click(
    card,
    "Change workspace: acme/docs",
    () => card.querySelector("input[aria-label='Repository']") !== null,
  );

  await typeInto(
    card.querySelector("input[aria-label='Repository']"),
    "https://github.com/acme/docs-site",
  );

  expect(card.querySelector("p")?.textContent).toContain("in acme/docs-site.");
  expect(card.textContent).not.toContain("Change it with the chips");

  await settled(() => card.textContent.includes("acme/api#2214"));

  expect(card.textContent).toContain(
    "Saving tests it once on acme/api#2214 Fix totals",
  );

  await click(card, "Save and test", () =>
    asked.some(({ method }) => method === "PUT"),
  );

  expect(asked.find(({ method }) => method === "PUT")).toMatchObject({
    url: "/api/ext/routines/routines/docs-from-merges?group=shop",
    body: {
      ...drafted,
      do: {
        ...drafted.do,
        profile: "p1",
        environment: "env-faraday",
        workspace: {
          kind: "clone",
          repository: "https://github.com/acme/docs-site",
        },
      },
      limits: { dailySpend: 10 },
    },
  });
});

test("saving a draft goes through the normal save, which says what doesn't fit", async () => {
  const { shown, asked } = page(({ method, url }) => {
    if (url.endsWith("/heard")) {
      return { count: 0, others: 0, events: [] };
    }

    if (method === "PUT") {
      return new Response(
        JSON.stringify({ error: "bad_request", message: "when.0: no event" }),
        { status: 400 },
      );
    }

    if (url.includes("/drafts")) {
      return {
        id: "d1",
        sentence: "x",
        state: "ready",
        sessionId: "s1",
        name: "docs",
        routine: drafted,
      };
    }

    return undefined;
  });

  await typeInto(
    shown.querySelector("textarea[aria-label='Describe the routine']"),
    "Docs",
  );

  await click(
    shown,
    "Draft it",
    () => shown.querySelector("[aria-label='Draft']") !== null,
  );

  await settled(() =>
    draftOf(shown).textContent.includes("No event of the last 7 days matches"),
  );

  await click(shown, "Save", () =>
    asked.some(({ method }) => method === "PUT"),
  );

  expect(asked.find(({ method }) => method === "PUT")).toMatchObject({
    url: "/api/ext/routines/routines/docs",
    body: drafted,
  });

  await settled(() => shown.textContent.includes("when.0: no event"));
});

test("the step picker goes when and what to the same draft", async () => {
  const { shown } = page();

  await click(
    shown,
    "Pick step by step",
    () => shown.querySelector("[role='radiogroup']") !== null,
  );

  expect(
    [
      ...shown.querySelectorAll(
        "[role='radiogroup'] label > span:first-of-type",
      ),
    ].map((each) => each.textContent),
  ).toEqual([
    "On a schedule",
    "When something happens",
    "After another routine",
    "When called",
  ]);

  await act(async () => {
    shown
      .querySelector<HTMLInputElement>("input[type='radio'][value='webhook']")
      ?.click();

    await Promise.resolve();
  });

  await click(
    shown,
    "Next: what it does",
    () =>
      shown.querySelector(
        "textarea[aria-label='Instructions for each run']",
      ) !== null,
  );

  await typeInto(
    shown.querySelector("textarea[aria-label='Instructions for each run']"),
    "Deploy the docs.",
  );

  await typeInto(shown.querySelector("input[aria-label='Agent']"), "worker");

  await click(
    shown,
    "Next: check it",
    () => shown.querySelector("[aria-label='Draft']") !== null,
  );

  expect(draftOf(shown).querySelector("p")?.textContent).toBe(
    "When its webhook is called, run the worker agent in its repository.",
  );

  expect(draftOf(shown).textContent).toContain(
    "Saving checks it. Run it from its page to try it.",
  );
});

test("an event is picked as chips whose menus hold what it has, and Only if opens the whole trigger with its recent events", async () => {
  const { shown, asked } = page(({ method }) =>
    method === "PUT" ? {} : undefined,
  );

  await click(
    shown,
    "Pick step by step",
    () => shown.querySelector("[role='radiogroup']") !== null,
  );

  await act(async () => {
    shown
      .querySelector<HTMLInputElement>("input[type='radio'][value='event']")
      ?.click();

    await Promise.resolve();
  });

  await click(shown, "Event: event");
  await click(shown, "pull request");
  await click(shown, "What happens: happens");

  expect(
    [
      ...shown.querySelectorAll(
        "[role='menu'][aria-label='What happens'] button",
      ),
    ].map((each) => each.textContent),
  ).toEqual(["happens", "is opened", "is labeled", "is closed", "is merged"]);

  await click(shown, "is merged");

  await settled(() =>
    shown.textContent.includes(
      "1 pull request event of the last 7 days would have fired this. Only repository members' work counts, so outside pull requests never start a run.",
    ),
  );

  expect([...shown.querySelectorAll("[role='menu']")].length).toBe(0);

  await click(shown, "Where: any repository");
  await click(shown, "acme/api");

  await click(shown, "Only if…", () =>
    shown.textContent.includes("Would have fired, last 7 days"),
  );

  const dialog = [...shown.querySelectorAll("dialog")].find((each) =>
    each.textContent.includes("When an event happens"),
  );

  if (dialog === undefined) {
    throw new Error("no event dialog");
  }

  expect(dialog.textContent).toContain("Git hosts");
  expect(dialog.textContent).toContain("Pull request, Issue");

  expect(
    [
      ...dialog.querySelectorAll("[role='group'][aria-label='Event'] button"),
    ].map((each) => each.textContent),
  ).toEqual(["Pull request", "Issue"]);

  expect(
    [...dialog.querySelectorAll("select[aria-label='Field']")].map(
      (each) => (each as HTMLSelectElement).value,
    ),
  ).toEqual(["merged", "repository"]);

  await act(async () => {
    dialog.querySelector<HTMLButtonElement>("[role='switch']")?.click();
    await Promise.resolve();
  });

  await click(dialog, "Test with this");

  expect(dialog.textContent).toContain(
    "A pull request in acme/api is merged, by anyone.",
  );

  expect(dialog.textContent).toContain(
    "3 other pull request events didn't match.",
  );

  await click(dialog, "Add trigger");

  await click(
    shown,
    "Next: what it does",
    () =>
      shown.querySelector(
        "textarea[aria-label='Instructions for each run']",
      ) !== null,
  );

  await typeInto(
    shown.querySelector("textarea[aria-label='Instructions for each run']"),
    "Update the docs.",
  );

  await click(
    shown,
    "Next: check it",
    () => shown.querySelector("[aria-label='Draft']") !== null,
  );

  const card = draftOf(shown);

  expect(card.querySelector("p")?.textContent).toBe(
    "When a pull request is merged in acme/api, follow the instructions in its repository.",
  );

  await typeInto(card.querySelector("input[aria-label='Title']"), "Docs");

  await click(card, "Save and test", () =>
    asked.some(({ method }) => method === "PUT"),
  );

  expect(asked.find(({ method }) => method === "PUT")).toMatchObject({
    url: "/api/ext/routines/routines/docs?test=h1",
    body: {
      title: "Docs",
      when: [
        {
          kind: "event",
          event: "git-hosts.pull_request",
          where: [
            { field: "merged", is: true },
            { field: "repository", is: "acme/api" },
            { field: "member", oneOf: [true, false] },
          ],
        },
      ],
    },
  });
});
