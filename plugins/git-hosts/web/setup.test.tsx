import { expect, test } from "bun:test";
import { renderPart } from "@pipoca/plugins/web/testing";
import { until } from "@pipoca/testing/until";
import { act } from "react";
import type { SetupState } from "../src/model";
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

const base = "/api/ext/git-hosts/";

const state: SetupState = {
  lockedIn: null,
  noHosts: false,
  withoutHosts: false,
  server: false,
  person: false,
};

const enterprise = {
  host: "git.corp.example",
  label: "Corp Git",
  clientId: "Iv1.abc",
  hasClientSecret: true,
  connected: 3,
  reach: { private: false, through: [] },
};

// Draws a setup step with the routes' answers, and keeps what it sends.
function step(
  audience: "server" | "person",
  answers: Readonly<Record<string, unknown>>,
  solo = false,
) {
  const sent: { method: string; path: string; body: unknown }[] = [];
  const asked: string[] = [];
  const found = web.setup?.find((each) => each.audience === audience);

  if (found === undefined) {
    throw new Error(`no ${audience} step`);
  }

  // The step, drawn as a slot, as the wizard draws it.
  const slots = { step: found.Step };

  const page = renderPart(
    { ...web, slots },
    "step",
    { solo },
    {
      fetch: async (url, init) => {
        const path = url.replace(base, "");
        asked.push(path);

        if (init?.method !== undefined && init.method !== "GET") {
          sent.push({
            method: init.method,
            path,
            body: typeof init.body === "string" ? JSON.parse(init.body) : null,
          });
        }

        return Promise.resolve(Response.json(answers[path] ?? null));
      },
    },
  );

  return { page, sent, asked };
}

// React draws what loaded once each act ends, so each look is one.
const shows = async (page: HTMLElement, text: string): Promise<void> => {
  await until(async () => {
    await act(async () => until(async () => Promise.resolve(true)));

    return page.textContent.includes(text);
  });
};

test("server setup shows each host with how people sign in and the App for team work", async () => {
  const { page } = step("server", {
    hosts: [
      enterprise,
      {
        host: "github.com",
        label: "GitHub",
        clientId: "",
        hasClientSecret: false,
        connected: 0,
        reach: { private: false, through: [] },
      },
    ],
    setup: { ...state, server: true },
    "technical-users": [
      {
        name: "pipoca-corp",
        host: enterprise.host,
        kind: "app",
        login: "pipoca-corp[bot]",
        team: true,
        installUrl: null,
        installedOn: ["acme", "infra"],
        error: null,
      },
    ],
  });

  await shows(page, "Corp Git");

  const card = (label: string) =>
    page.querySelector(`ul[aria-label='${label}']`)?.textContent ?? "";

  expect(card("Corp Git")).toContain("Ready");
  expect(card("Corp Git")).toContain("installed on acme, infra");
  expect(card("GitHub")).toContain("No sign-in yet");
  expect(card("GitHub")).toContain("Create GitHub App");

  const adds = [
    ...page.querySelectorAll("[role=group][aria-label='Add a host'] button"),
  ].map((each) => each.textContent);

  // github.com is listed already, so it isn't offered again.
  expect(adds).toEqual(["GitHub Enterprise", "Other git host"]);

  // With a host listed, going on with none isn't asked.
  expect(page.textContent).not.toContain("Go on with no code host");
});

test("server setup with no host takes going on with none as its answer", async () => {
  const { page, sent } = step("server", {
    hosts: [],
    setup: state,
    "technical-users": [],
  });

  await shows(page, "Go on with no code host for now");

  const box = page.querySelector<HTMLInputElement>("input[type=checkbox]");

  await act(async () => {
    box?.click();
    await until(() => sent.length > 0);
  });

  expect(sent).toEqual([
    { method: "PUT", path: "setup/server", body: { noHosts: true } },
  ]);
});

test("server setup only shows the hosts the deploy's file sets", async () => {
  const { page } = step("server", {
    hosts: [enterprise],
    setup: { ...state, lockedIn: "/etc/pipoca/pipoca.json", server: true },
    "technical-users": [],
  });

  await shows(page, "/etc/pipoca/pipoca.json");

  expect(page.querySelector("[aria-label='Add a host']")).toBeNull();

  expect(
    page.querySelector(`[aria-label='Edit ${enterprise.host}']`),
  ).toBeNull();

  expect(page.textContent).not.toContain("Create GitHub App");
});

test("your setup signs in to each host, and picks the email to commit as there", async () => {
  const { page } = step("person", {
    account: {
      admin: false,
      hosts: [
        {
          host: enterprise.host,
          label: "Corp Git",
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
      connections: [{ host: enterprise.host, login: "pedro", connectedAt: "" }],
    },
    setup: { ...state, person: true },
    "commit-as": { default: null, hosts: [] },
    [`emails/${enterprise.host}`]: {
      name: "Pedro Klein",
      emails: ["pedro@corp.example"],
    },
    preferences: { autoFix: true, reply: false },
  });

  await shows(page, "Fix my pull requests");
  await shows(page, "pedro@corp.example");

  const corp = page.querySelector("ul[aria-label='Corp Git']");

  expect(corp?.textContent).toContain("Signed in as pedro");

  expect(
    [
      ...(corp?.querySelectorAll(
        "form[aria-label='Commit as on Corp Git'] option",
      ) ?? []),
    ].map(({ textContent }) => textContent),
  ).toEqual(["Use the default", "pedro@corp.example"]);

  const forge = page.querySelector("ul[aria-label='Forge']");

  // Forge has no OAuth app, so a token is how to sign in there.
  expect(forge?.textContent).toContain("Not signed in");
  expect(forge?.textContent).toContain("Use a token");

  expect(page.textContent).toContain("Repositories anywhere else");
  expect(page.textContent).not.toContain("Go on without");
  expect(page.querySelector("[aria-label='Add a host']")).toBeNull();
});

test("your setup on a team with no host says so, and takes going on without one as the answer", async () => {
  const { page, sent } = step("person", {
    account: { admin: false, hosts: [], connections: [] },
    setup: state,
    "commit-as": { default: null, hosts: [] },
    preferences: { autoFix: false, reply: false },
  });

  await shows(page, "An admin adds them");

  const box = page.querySelector<HTMLInputElement>("input[type=checkbox]");

  await act(async () => {
    box?.click();
    await until(() => sent.length > 0);
  });

  expect(sent).toEqual([
    { method: "PUT", path: "setup/person", body: { withoutHosts: true } },
  ]);
});

test("your setup on a server just for you adds hosts too", async () => {
  const { page } = step(
    "person",
    {
      account: { admin: true, hosts: [], connections: [] },
      setup: state,
      "commit-as": { default: null, hosts: [] },
      hosts: [],
      preferences: { autoFix: false, reply: false },
    },
    true,
  );

  await shows(page, "Other git host");

  expect(page.textContent).not.toContain("An admin adds them");
  expect(page.textContent).toContain("Go on without a code host");
});

test("each step's done comes from the plugin's own answer", async () => {
  const answered = {
    get: async () => Promise.resolve({ ...state, server: true, person: false }),
  };

  const done = await Promise.all(
    (web.setup ?? []).map(async ({ audience, done: check }) => [
      audience,
      await check(answered as never),
    ]),
  );

  expect(done).toEqual([
    ["server", true],
    ["person", false],
  ]);
});

test("server setup says a private host needs a team Environment for team work", async () => {
  const { page } = step("server", {
    hosts: [
      {
        ...enterprise,
        reach: { private: true, through: [] },
      },
    ],
    setup: { ...state, server: true },
    "technical-users": [],
  });

  await shows(page, "Team calls");

  const card = page.querySelector("ul[aria-label='Corp Git']")?.textContent;

  expect(card).toContain("Private");
  expect(card).toContain("Needs a team Environment for team work");
  expect(card).toContain("Set up a team Environment");
});
