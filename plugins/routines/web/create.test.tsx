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
    title: "A pull request changed",
    fields: {
      type: "object",
      properties: {
        repository: { type: "string" },
        merged: { type: "boolean" },
      },
    },
  },
];

const drafted = {
  title: "Docs from merges",
  when: [
    {
      kind: "event",
      event: "git-hosts.pull_request",
      where: [{ field: "repository", oneOf: ["acme/shop", "acme/api"] }],
    },
  ],
  do: {
    kind: "session",
    agent: "writer",
    prompt: "Update the docs.",
    workspace: { kind: "clone", repository: "https://github.com/acme/docs" },
  },
};

interface Asked {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
}

function page(answers: (asked: Asked) => unknown) {
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

        const answer = answers(each);

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
  done: () => boolean,
): Promise<void> => {
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

test("one sentence is drafted and shown back as a sentence with chips, which change it before it is saved", async () => {
  let draft: object = {
    id: "d1",
    sentence: "",
    state: "drafting",
    sessionId: "s1",
  };

  const { shown, asked } = page(({ method, url }) => {
    if (url.endsWith("/events")) {
      return events;
    }

    if (method === "POST") {
      return draft;
    }

    return url.includes("/drafts/") ? draft : {};
  });

  await typeInto(
    shown.querySelector("textarea[aria-label='Describe the routine']"),
    "When a pull request merges in shop or api, update the docs in docs-site",
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

  // Asked again until it is drafted.
  await settled(() => shown.querySelector("[aria-label='Draft']") !== null);

  await checkDraft(shown);
});

async function checkDraft(shown: HTMLElement): Promise<void> {
  const card = shown.querySelector<HTMLElement>("[aria-label='Draft']");

  if (card === null) {
    throw new Error("no draft");
  }

  await settled(() => card.textContent.includes("pull request"));

  expect(card.querySelector("p")?.textContent).toBe(
    "When A pull request changed if repository is one of acme/shop or acme/api, the writer agent works in acme/docs, proposes nothing and runs without limits.",
  );

  expect(card.textContent).toContain(
    "do.workspace.repository must be a repository URL. Change it with the chips or in the JSON.",
  );

  expect(
    [...card.querySelectorAll("ul[aria-label='Defaults'] > li")].map(
      (each) => each.textContent,
    ),
  ).toEqual([
    "One run at a time: a firing while one is going is skipped.",
    "Runs that events or webhooks start can't push or post; they propose what to write.",
    "A run may take up to 2h.",
    "Uses the agent's model, or else the Profile's default.",
  ]);

  await click(
    card,
    "Change limits: without limits",
    () => card.querySelector("input[aria-label='Runs at once']") !== null,
  );

  await typeInto(card.querySelector("input[aria-label='Runs at once']"), "2");

  expect(card.querySelector("p")?.textContent).toContain(
    "runs at most 2 at once.",
  );

  expect(card.textContent).not.toContain("Change it with the chips");
}

test("saving a draft goes through the normal save, which says what doesn't fit", async () => {
  const { shown, asked } = page(({ method, url }) => {
    if (url.endsWith("/events") || url.endsWith("/actions")) {
      return [];
    }

    if (method === "PUT") {
      return new Response(
        JSON.stringify({ error: "bad_request", message: "when.0: no event" }),
        { status: 400 },
      );
    }

    return {
      id: "d1",
      sentence: "x",
      state: "ready",
      sessionId: "s1",
      name: "docs",
      routine: drafted,
    };
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

  await click(shown, "Save and test", () =>
    asked.some(({ method }) => method === "PUT"),
  );

  expect(asked.find(({ method }) => method === "PUT")).toMatchObject({
    url: "/api/ext/routines/routines/docs",
    body: drafted,
  });

  await settled(() => shown.textContent.includes("when.0: no event"));
});

test("the step picker goes when, what and check to the same draft", async () => {
  const { shown } = page(({ url }) => (url.endsWith("/events") ? events : []));

  await click(
    shown,
    "Pick step by step",
    () => shown.querySelector("[role='radiogroup']") !== null,
  );

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

  expect(shown.querySelector("[aria-label='Draft'] p")?.textContent).toBe(
    "When its webhook is called, the worker agent works in the event's repository, proposes nothing and runs without limits.",
  );
});
