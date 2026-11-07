import { expect, test } from "bun:test";
import type { TypedClient } from "@pipoca/plugins";
import type { SetupStep } from "@pipoca/plugins/web";
import { renderPart } from "@pipoca/plugins/web/testing";
import { until } from "@pipoca/testing/until";
import { act } from "react";
import type { Account, Connectable } from "../src/model";
import { web } from "./index";

// Lets React draw each answer before looking again.
async function settled(check: () => boolean): Promise<void> {
  await until(async () => {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));

    return check();
  });
}

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

const providers: readonly Connectable[] = [
  {
    id: "faux",
    name: "Faux",
    methods: [
      { type: "oauth", label: "Faux plan" },
      { type: "api_key", label: "API key" },
    ],
  },
  ...Array.from({ length: 7 }, (_, index) => ({
    id: `pi-${String(index + 1)}`,
    name: `Pi Provider ${String(index + 1)}`,
    methods: [{ type: "api_key" as const, label: "API key" }],
  })),
  {
    id: "oauth-only",
    name: "OAuth Only",
    methods: [{ type: "oauth", label: "Plan" }],
  },
  {
    id: "packaged",
    name: "packaged",
    methods: [{ type: "api_key", label: "Paste a key" }],
    paste: true,
  },
];

const login = (
  provider: string,
  layer: Account["logins"][number]["layer"],
  type: "api_key" | "oauth" = "api_key",
): Account["logins"][number] => ({ provider, type, layer, updatedAt: "" });

interface Sent {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
}

// A setup step drawn as the wizard draws it, against a server that answers
// with these logins and records what it was sent.
async function drawn(
  step: SetupStep,
  o: { readonly logins?: Account["logins"]; readonly solo?: boolean } = {},
): Promise<{ readonly page: HTMLElement; readonly sent: Sent[] }> {
  const sent: Sent[] = [];

  const account: Account = {
    admin: true,
    logins: o.logins ?? [],
    mcp: [],
    servers: [],
  };

  const answers: Readonly<Record<string, unknown>> = {
    "/api/ext/logins/account": account,
    "/api/ext/logins/providers": providers,
    "/api/ext/logins/keys": (o.logins ?? [])
      .filter(({ layer }) => layer === "base")
      .map(({ provider }) => ({ provider, proxied: provider !== "packaged" })),
    "/api/me/profile-defaults": { packages: ["npm:pi-subagents"] },
  };

  const slots = { panel: step.Step };

  const page = renderPart(
    { ...web, slots },
    "panel",
    { solo: o.solo ?? false },
    {
      fetch: async (url, init) => {
        const method = init?.method ?? "GET";

        if (method !== "GET") {
          sent.push({
            method,
            url,
            body: JSON.parse(
              typeof init?.body === "string" ? init.body : "null",
            ) as unknown,
          });
        }

        return Promise.resolve(
          Response.json(method === "GET" ? answers[url] : account),
        );
      },
    },
  );

  await settled(() => page.querySelector("ul") !== null);

  return { page, sent };
}

const stepFor = (audience: "server" | "person"): SetupStep => {
  const found = web.setup?.find((each) => each.audience === audience);

  if (found === undefined) {
    throw new Error(`no ${audience} step`);
  }

  return found;
};

const button = (page: HTMLElement, name: string): HTMLButtonElement => {
  const found = [...page.querySelectorAll("button")].find(
    (each) =>
      each.getAttribute("aria-label") === name ||
      each.textContent.trim() === name,
  );

  if (found === undefined) {
    throw new Error(`no button ${name}`);
  }

  return found;
};

const click = async (element: HTMLElement): Promise<void> => {
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
};

const typeInto = async (
  element: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): Promise<void> => {
  await act(async () => {
    // Past React's own value property, so it sees the change.
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

const rowsOf = (page: HTMLElement, label: string): readonly string[] =>
  [...page.querySelectorAll(`ul[aria-label="${label}"] > li`)].map((each) =>
    each.textContent.trim(),
  );

test("the server's step comes after the server default Profile, and none is an answer", async () => {
  const step = stepFor("server");

  expect(step.audience === "server" && step.after).toBe("default-profile");
  expect(await step.done({} as TypedClient)).toBe(true);

  const { page } = await drawn(step);

  expect(rowsOf(page, "Shared model keys")[0]).toContain("No shared key yet");
  expect(page.textContent).toContain("server default Profile");
});

test("an admin picks any provider with an API key to share, from Pi and from packages", async () => {
  const { page, sent } = await drawn(stepFor("server"), {
    logins: [login("pi-1", "base"), login("faux", "defaults", "oauth")],
  });

  expect(rowsOf(page, "Shared model keys")).toHaveLength(1);
  expect(rowsOf(page, "Shared model keys")[0]).toContain("Pi Provider 1");

  await click(button(page, "Add a shared key"));

  const options = [...page.querySelectorAll('[role="option"]')].map((each) =>
    each.textContent.trim(),
  );

  // Every provider that takes a key but the one already shared, and none
  // that only signs in with an account.
  expect(options).toHaveLength(8);
  expect(options.some((each) => each.startsWith("Pi Provider 1"))).toBe(false);
  expect(options.some((each) => each.startsWith("OAuth Only"))).toBe(false);

  expect(options.find((each) => each.startsWith("packaged"))).toContain(
    "Added by a package",
  );

  const option = (name: string): HTMLElement => {
    const found = [
      ...page.querySelectorAll<HTMLElement>('[role="option"]'),
    ].find((each) => each.textContent.trim().startsWith(name));

    if (found === undefined) {
      throw new Error(`no option ${name}`);
    }

    return found;
  };

  await click(option("Faux"));

  expect(sent).toEqual([
    {
      method: "POST",
      url: "/api/ext/logins/connect",
      body: { provider: "faux", type: "api_key", layer: "base" },
    },
  ]);

  await click(button(page, "Add a shared key"));
  await click(option("packaged"));

  const form = page.querySelector<HTMLFormElement>(
    'form[aria-label="Key for packaged"]',
  );

  const key = form?.querySelector("textarea");

  if (form === null || key === null || key === undefined) {
    throw new Error("no key form");
  }

  await typeInto(key, "sk-packaged");

  await act(async () => {
    form.requestSubmit();
    await Promise.resolve();
  });

  await settled(() => sent.length === 2);

  expect(sent[1]).toEqual({
    method: "POST",
    url: "/api/ext/logins/save",
    body: {
      provider: "packaged",
      credential: { type: "api_key", key: "sk-packaged" },
      layer: "base",
    },
  });
});

test("an admin removes a shared key, and one a package adds says it goes to team runners", async () => {
  const { page, sent } = await drawn(stepFor("server"), {
    logins: [login("pi-2", "base"), login("packaged", "base")],
  });

  const rows = rowsOf(page, "Shared model keys");

  expect(rows[0]).not.toContain("team runners");
  expect(rows[1]).toContain("Added by a package");
  expect(rows[1]).toContain("team runners");

  await click(button(page, "Remove the Pi Provider 2 key"));

  expect(sent).toEqual([
    {
      method: "DELETE",
      url: "/api/ext/logins/credentials/pi-2?layer=base",
      body: null,
    },
  ]);
});

test("a person sees the shared providers as ready, and can still sign in to any provider", async () => {
  const { page, sent } = await drawn(stepFor("person"), {
    logins: [login("pi-3", "base"), login("oauth-only", "defaults", "oauth")],
  });

  expect(rowsOf(page, "Shared by the server")).toEqual([
    expect.stringContaining("Pi Provider 3"),
  ]);

  expect(rowsOf(page, "Shared by the server")[0]).toContain("Ready");

  const rows = rowsOf(page, "Model providers");

  // Their own first, then a package's, then Pi's that sign in with an
  // account, and the rest folded away.
  expect(rows[0]).toContain("OAuth Only");
  expect(rows[0]).toContain("Signed in");
  expect(rows[1]).toContain("packaged");
  expect(rows[2]).toContain("Faux");
  expect(rows[3]).toContain("Pi Provider 1");
  expect(rows.at(-1)).toContain("5 more providers");

  await click(button(page, "Show all"));
  expect(rowsOf(page, "Model providers")).toHaveLength(providers.length);

  await click(button(page, "Sign in to Faux"));
  await click(button(page, "Add a key for Pi Provider 3"));

  expect(sent.map(({ body }) => body)).toEqual([
    { provider: "faux", type: "oauth", layer: "defaults" },
    { provider: "pi-3", type: "api_key", layer: "defaults" },
  ]);
});

test("a person finds a provider by name, and adds a package for one Pi doesn't know to their default Profile", async () => {
  const { page, sent } = await drawn(stepFor("person"));

  const search = page.querySelector<HTMLInputElement>(
    'input[aria-label="Search providers"]',
  );

  if (search === null) {
    throw new Error("no search");
  }

  await typeInto(search, "provider 7");

  expect(rowsOf(page, "Model providers")).toEqual([
    expect.stringContaining("Pi Provider 7"),
  ]);

  await typeInto(search, "nothing like it");
  expect(rowsOf(page, "Model providers")[0]).toContain("No provider matches");

  await click(button(page, "Add package"));

  const form = page.querySelector<HTMLFormElement>(
    `form[aria-label="Add a provider's package"]`,
  );

  const source = form?.querySelector("input");

  if (form === null || source === null || source === undefined) {
    throw new Error("no package form");
  }

  await typeInto(source, "npm:pi-provider-acme");

  await act(async () => {
    form.requestSubmit();
    await Promise.resolve();
  });

  await settled(() => sent.length === 1);

  expect(sent).toEqual([
    {
      method: "PUT",
      url: "/api/me/profile-defaults",
      body: { packages: ["npm:pi-subagents", "npm:pi-provider-acme"] },
    },
  ]);

  await settled(() => page.textContent.includes("Added npm:pi-provider-acme"));
});

test("on a server just for its person, their keys are the shared ones too", async () => {
  const { page, sent } = await drawn(stepFor("person"), {
    solo: true,
    logins: [login("pi-4", "base")],
  });

  expect(page.querySelector('ul[aria-label="Shared by the server"]')).toBe(
    null,
  );

  expect(rowsOf(page, "Model providers")[0]).toContain("Pi Provider 4");
  expect(rowsOf(page, "Model providers")[0]).toContain("Key saved");

  await click(button(page, "Sign in to Faux"));
  await click(button(page, "Add a key for Pi Provider 1"));

  expect(sent.map(({ body }) => body)).toEqual([
    { provider: "faux", type: "oauth", layer: "defaults" },
    { provider: "pi-1", type: "api_key", layer: "base" },
  ]);
});

test("a person's step is done with a shared key, a login of their own or a runner's model", async () => {
  const step = stepFor("person");

  const api = (
    logins: Account["logins"],
    models: readonly unknown[] = [],
  ): TypedClient =>
    ({
      get: async (path: string) =>
        Promise.resolve(
          path === "account"
            ? { admin: false, logins, mcp: [], servers: [] }
            : [{ models }],
        ),
    }) as unknown as TypedClient;

  expect(await step.done(api([]))).toBe(false);
  expect(await step.done(api([login("pi-1", "profile:work")]))).toBe(false);
  expect(await step.done(api([login("pi-1", "base")]))).toBe(true);
  expect(await step.done(api([login("faux", "defaults", "oauth")]))).toBe(true);

  expect(await step.done(api([], [{ provider: "faux", id: "faux-1" }]))).toBe(
    true,
  );
});
