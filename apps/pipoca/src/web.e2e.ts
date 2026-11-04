import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  type FauxResponseFactory,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  type Browser,
  chromium,
  type Locator,
  type Page,
  type Route,
} from "playwright-core";
import type { Environment, Profile } from "@pipoca/protocol";
import { installedPlugins } from "./installed";
import { serve } from "./serve";
import { setupTokenOf } from "./testdata/sign-in";

let root: string;
let server: ReturnType<typeof serve>;
let browser: Browser;
let page: Page;
let cookie: string;

const faux = fauxProvider({
  models: [{ id: "faux-1" }, { id: "faux-deep", reasoning: true }],
});

// Enough models that the menus fold providers away.
const wideProvider = fauxProvider({
  provider: "wide",
  models: Array.from({ length: 8 }, (_, index) => ({
    id: `wide-${String(index + 1)}`,
  })),
});

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "pipoca-e2e-")));

  const runtime = await ModelRuntime.create({
    authPath: join(root, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  });

  runtime.registerNativeProvider(faux.provider);
  runtime.registerNativeProvider(wideProvider.provider);

  const plugins = join(root, "plugins");
  await mkdir(join(plugins, "hello"), { recursive: true });

  await writeFile(
    join(plugins, "hello", "package.json"),
    JSON.stringify({
      pipoca: {
        id: "hello",
        title: "Hello",
        description: "Says hi.",
        engine: 1,
      },
    }),
  );

  await mkdir(join(plugins, "greeter"));

  await writeFile(
    join(plugins, "greeter", "package.json"),
    JSON.stringify({
      pipoca: {
        id: "greeter",
        title: "Greeter",
        description: "Counts hellos.",
        engine: 1,
        parts: { web: "web.tsx" },
      },
    }),
  );

  // Hooks only work when the part shares the page's React.
  await writeFile(
    join(plugins, "greeter", "web.tsx"),
    `import { Button } from "@pipoca/ui";
import { useState } from "react";

function Page() {
  const [count, setCount] = useState(0);

  return <Button onClick={() => setCount(count + 1)}>Hellos: {count}</Button>;
}

export default { name: "greeter", nav: { label: "Greeter", Page } };
`,
  );

  await mkdir(join(plugins, "faulty"));

  await writeFile(
    join(plugins, "faulty", "package.json"),
    JSON.stringify({
      pipoca: {
        id: "faulty",
        title: "Faulty",
        description: "Throws when it loads.",
        engine: 1,
        parts: { web: "web.ts" },
      },
    }),
  );

  await writeFile(
    join(plugins, "faulty", "web.ts"),
    `throw new Error("faulty on purpose");
`,
  );

  await writeFile(
    join(plugins, "enabled.json"),
    JSON.stringify(["faulty", "greeter"]),
  );

  const logs: string[] = [];

  server = serve({
    port: 0,
    database: ":memory:",
    configDir: join(root, "config"),
    sessions: { pollWaitMs: 100, offlineAfterMs: 1000 },
    agent: {
      provider: "e2e",
      dataDir: join(root, "e2e"),
      extensionPaths: [],
      folders: [root],
      models: { runtime, model: faux.getModel() },
    },
    installed: {
      root: plugins,
      plugins: await installedPlugins(plugins, () => undefined),
    },
    log: (message, fields) => {
      logs.push(`${message} ${JSON.stringify(fields)}`);
    },
  });

  browser = await chromium.launch();
  page = await browser.newPage();
  page.setDefaultTimeout(10_000);

  await page.goto(new URL(`/#setup/${setupTokenOf(logs)}`, server.url).href);
  await page.getByRole("heading", { name: "Welcome to Pipoca" }).waitFor();
  await page.getByLabel("Username").fill("pedro");
  await page.getByLabel("Password").fill("correct horse");

  await page
    .getByRole("button", { name: "Create account and continue" })
    .click();

  // The e2e runner is online with its own model, so those steps are done;
  // GitHub is listed but not connected, so code is skipped (ADR 0063).
  for (const heading of ["Where should Pi work?", "Connect a model"]) {
    await page.getByRole("heading", { name: heading }).waitFor();
    await page.getByRole("button", { name: "Continue" }).click();
  }

  for (const heading of ["Connect your code", "Make Pi yours"]) {
    await page.getByRole("heading", { name: heading }).waitFor();
    await page.getByRole("button", { name: "Skip for now" }).click();
  }

  await page.getByRole("heading", { name: "You're set, pedro" }).waitFor();
  await page.getByPlaceholder("What do you want to build first?").waitFor();
  await page.getByRole("button", { name: "Done" }).click();
  await page.getByRole("button", { name: "New session" }).waitFor();

  const [session] = await page.context().cookies();
  cookie = `${session?.name ?? ""}=${session?.value ?? ""}`;
}, 30_000);

// Picks the e2e Environment and the folder in the New session composer.
// A folder is shared unless share is false, which makes a worktree of it.
async function pickWorkspace(
  form: Locator,
  where: string,
  share = true,
): Promise<void> {
  const environment = form.getByRole("button", { name: "Environment" });

  if ((await environment.count()) > 0) {
    await environment.click();
    await form.getByRole("option", { name: /^e2e/ }).click();
  }

  await form.getByRole("button", { name: "Folder or repository" }).click();
  const search = form.getByRole("combobox", { name: "Folder or repository" });
  const picked = form.getByRole("option", { selected: true });

  // The composer remembers the last pick.
  while ((await picked.count()) > 0) {
    await picked.first().click();
  }

  await search.fill(where);

  await form
    .getByRole("option")
    .filter({ hasText: new RegExp(`${RegExp.escape(where)}(folder|clone)?$`) })
    .first()
    .click();

  await form.getByLabel(/^Share the folder/).setChecked(share);
  await search.press("Escape");
}

// Opens a section of the Settings page from the account menu.
async function openSettings(section: string): Promise<void> {
  const back = page
    .getByRole("navigation", { name: "Settings" })
    .getByRole("link", { name: "Back to Pipoca" });

  if (await back.isVisible()) {
    await back.click();
  }

  await page.getByRole("button", { name: "Account" }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();

  await page
    .getByRole("navigation", { name: "Settings" })
    .getByRole("link", { name: section, exact: true })
    .click();
}

async function openEnvironment(name: string): Promise<void> {
  await page
    .getByRole("list", { name: "Your Environments" })
    .getByRole("link", { name: new RegExp(`^${name}`) })
    .click();
}

// A folder with its own .pi asks before loading it (ADR 0031).
async function trustRepository(): Promise<void> {
  await page
    .locator('[data-role="prompt"]')
    .getByRole("button", { name: "Trust it", exact: true })
    .click();
}

afterAll(async () => {
  await browser.close();
  await server.stop();
  await rm(root, { recursive: true, force: true });
});

test("chats with a session, replays it after a reload and opens its terminal", async () => {
  faux.setResponses([fauxAssistantMessage([fauxText("hello from faux pi")])]);
  await page.goto(server.url.href);

  await page.getByRole("button", { name: "New session" }).click();
  const form = page.locator("form#create");

  await pickWorkspace(form, root);
  await form.getByRole("button", { name: "Start session" }).click();
  await page.locator("#status", { hasText: "idle" }).waitFor();

  await page.locator("#prompt-text").fill("hi");
  await page.locator("#prompt-text").press("Enter");

  const reply = page.locator('#chat li[data-role="assistant"]');
  await reply.filter({ hasText: "hello from faux pi" }).waitFor();

  await page.reload();
  await reply.filter({ hasText: "hello from faux pi" }).waitFor();

  expect(
    await page.locator('#chat li[data-role="user"]').allTextContents(),
  ).toEqual(["hi"]);

  await page.getByRole("button", { name: "Terminal" }).click();
  await page.locator("#terminal .xterm").click();
  await page.keyboard.type("echo e2e-$((6 * 7))\n");

  await page
    .locator("#terminal .xterm-rows")
    .filter({ hasText: "e2e-42" })
    .waitFor();

  await page.setViewportSize({ width: 390, height: 844 });
  const keys = page.getByRole("toolbar", { name: "Terminal keys" });
  await page.keyboard.type("echo one");
  await keys.getByRole("button", { name: "Ctrl" }).click();
  await page.keyboard.type("u");
  await page.keyboard.type("echo e2e-$((5 * 5))\n");
  const rows = page.locator("#terminal .xterm-rows");
  await rows.filter({ hasText: "e2e-25" }).waitFor();

  expect(await rows.textContent()).not.toContain("oneu");

  expect(
    await keys
      .getByRole("button", { name: "Ctrl" })
      .getAttribute("aria-pressed"),
  ).toBe("false");

  await page.setViewportSize({ width: 1280, height: 720 });
  await page.keyboard.type("SURVIVE=yes\n");
  await page.getByRole("button", { name: "Chat" }).click();
  await page.getByRole("button", { name: "Terminal" }).click();
  await rows.filter({ hasText: "e2e-25" }).waitFor();
  await page.locator("#terminal .xterm").click();
  await page.keyboard.type("echo survived=$SURVIVE\n");
  await rows.filter({ hasText: "survived=yes" }).waitFor();

  const tabs = page.getByRole("tablist", { name: "Terminals" });
  await tabs.getByRole("tab", { name: "Terminal 1" }).waitFor();
  await tabs.getByRole("button", { name: "New terminal" }).click();
  await tabs.getByRole("tab", { name: "Terminal 2" }).waitFor();
  await tabs.getByRole("button", { name: "Close Terminal 2" }).click();

  await tabs
    .getByRole("tab", { name: "Terminal 2" })
    .waitFor({ state: "detached" });

  await rows.filter({ hasText: "survived=yes" }).waitFor();
}, 30_000);

test("chats from Pi's own TUI and goes back to the chat when Pi quits", async () => {
  faux.setResponses([fauxAssistantMessage([fauxText("hello from the tui")])]);
  await page.goto(server.url.href);

  await page.getByRole("button", { name: "New session" }).click();
  const form = page.locator("form#create");

  await pickWorkspace(form, root);
  await form.getByRole("button", { name: "Start session" }).click();
  await page.locator("#status", { hasText: "idle" }).waitFor();

  await page.getByRole("button", { name: "Pi", exact: true }).click();
  const rows = page.locator("#terminal .xterm-rows");
  await rows.filter({ hasText: "Pi can explain" }).waitFor();
  await page.locator("#terminal .xterm").click();
  await page.keyboard.type("hi from the web tui");
  await page.keyboard.press("Enter");
  await rows.filter({ hasText: "hello from the tui" }).waitFor();
  await page.keyboard.press("Control+d");

  await page
    .locator('#chat li[data-role="assistant"]', {
      hasText: "hello from the tui",
    })
    .waitFor();

  expect(
    await page.locator('#chat li[data-role="user"]').allTextContents(),
  ).toEqual(["hi from the web tui"]);
}, 30_000);

test("asks the assistant from the home screen with the model picked, then continues there", async () => {
  faux.setResponses([
    fauxAssistantMessage([fauxText("From before")]),
    fauxAssistantMessage([fauxText("Happy to help")]),
  ]);

  await fetch(new URL("/api/plugins/meta/sessions", server.url), {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ text: "An older question" }),
  });

  await page.goto(server.url.href);
  await page.getByRole("heading", { name: "Earlier conversations" }).waitFor();

  await page
    .getByRole("heading", { name: "What do you want to build today?" })
    .waitFor();

  const ask = page.getByLabel("Ask the Pipoca assistant");

  const model = page
    .locator("form", { has: ask })
    .getByRole("button", { name: "Model" });

  await model.click();
  await page.getByRole("combobox", { name: "Model" }).fill("faux-deep");
  await page.getByRole("combobox", { name: "Model" }).press("Enter");

  await ask.fill("What can you do?");
  await ask.press("Enter");

  await page
    .locator('#chat li[data-role="assistant"]', { hasText: "Happy to help" })
    .waitFor();

  const projectHash = new URL(page.url()).hash;
  expect(projectHash).toMatch(/^#plugin\/projects\/[\w-]+$/);

  const assistant = (await (
    await fetch(new URL("/api/plugins/projects/assistant", server.url), {
      headers: { cookie },
    })
  ).json()) as { coordinatorId: string };

  const coordinator = (await (
    await fetch(
      new URL(`/api/sessions/${assistant.coordinatorId}`, server.url),
      {
        headers: { cookie },
      },
    )
  ).json()) as { model: { id: string } | null };

  expect(coordinator.model?.id).toBe("faux-deep");

  await page.goto(server.url.href);

  await page
    .getByRole("link", { name: "Continue with the assistant" })
    .waitFor();

  expect(await model.count()).toBe(0);

  expect(
    await page.getByRole("heading", { name: "Earlier conversations" }).count(),
  ).toBe(0);

  await page.getByRole("link", { name: "Earlier conversations" }).click();
  await page.getByRole("link", { name: "An older question" }).waitFor();

  await page.getByRole("link", { name: "Assistant", exact: true }).click();
  await page.waitForURL((url) => url.hash === projectHash);
}, 30_000);

test("goes where the assistant opens on a wide screen, and offers it on a phone", async () => {
  // What a tool opens isn't replayed, so the model waits until the page
  // follows the conversation.
  let following = Promise.withResolvers<undefined>();

  const startOne = async (): Promise<
    ReturnType<typeof fauxAssistantMessage>
  > => {
    await following.promise;
    following = Promise.withResolvers<undefined>();

    return fauxAssistantMessage(
      [
        fauxToolCall("sessions_start", {
          workspace: { kind: "folder", path: root },
        }),
      ],
      { stopReason: "toolUse" },
    );
  };

  faux.setResponses([
    startOne,
    fauxAssistantMessage([fauxText("started one")]),
    startOne,
    fauxAssistantMessage([fauxText("started another")]),
  ]);

  const ask = async (text: string): Promise<void> => {
    await page.goto(server.url.href);
    const composer = page.getByLabel("Ask the Pipoca assistant");
    await composer.fill(text);
    await composer.press("Enter");

    await page
      .locator('#chat li[data-role="user"]', { hasText: text })
      .waitFor();

    following.resolve(undefined);
  };

  await ask("Start a session in my folder");
  await page.waitForURL(/#(?!plugin\/)[\w-]+$/);

  await page.setViewportSize({ width: 390, height: 844 });
  await ask("Start another one");

  const notice = page.getByRole("status").filter({
    hasText: "Open the new Session?",
  });

  await notice.waitFor();

  expect(new URL(page.url()).hash).toMatch(/^#plugin\/projects\//);

  await notice.getByRole("link", { name: "Open" }).click();
  await page.waitForURL(/#(?!plugin\/)[\w-]+$/);
  await page.setViewportSize({ width: 1280, height: 720 });
}, 30_000);

test("asks in words before the assistant changes an Environment, and can allow it for the session", async () => {
  const [environment] = (await (
    await fetch(new URL("/api/environments", server.url), {
      headers: { cookie },
    })
  ).json()) as Environment[];

  const rename = (name: string): ReturnType<typeof fauxAssistantMessage> =>
    fauxAssistantMessage(
      [
        fauxToolCall("environments_update", {
          id: environment?.id ?? "",
          name,
        }),
      ],
      { stopReason: "toolUse" },
    );

  faux.setResponses([
    fauxAssistantMessage(
      [fauxToolCall("tool_search", { query: "change an Environment" })],
      { stopReason: "toolUse" },
    ),
    rename("lab"),
    rename(environment?.name ?? ""),
    fauxAssistantMessage([fauxText("renamed it twice")]),
  ]);

  await page.goto(server.url.href);
  const composer = page.getByLabel("Ask the Pipoca assistant");
  await composer.fill("Rename my Environment and back");
  await composer.press("Enter");

  const card = page.locator('[data-role="prompt"]');

  await card
    .getByRole("heading", {
      name: `Change the Environment “${environment?.name ?? ""}”?`,
    })
    .waitFor();

  expect(await card.locator("dt").allTextContents()).toEqual(["Name"]);
  expect(await card.locator("dd").allTextContents()).toEqual(["lab"]);

  await card.getByRole("button", { name: "Allow for this session" }).click();

  await page
    .locator('#chat li[data-role="assistant"]', { hasText: "renamed it twice" })
    .waitFor();

  expect(await card.count()).toBe(0);
}, 30_000);

test("infers the workspace from what the New session composer picks and remembers it", async () => {
  const asked: unknown[] = [];

  await page.route("**/api/sessions", async (route) => {
    asked.push(route.request().postDataJSON());

    await route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({
        error: "bad_request",
        message: "not this time",
      }),
    });
  });

  await page.goto(server.url.href);
  await page.getByRole("button", { name: "New session" }).click();
  const form = page.locator("form#create");

  await pickWorkspace(form, "https://example.com/a.git");
  await form.getByRole("button", { name: "Start session" }).click();
  await form.getByRole("alert").filter({ hasText: "not this time" }).waitFor();

  await form.getByRole("button", { name: "Folder or repository" }).click();
  const search = form.getByRole("combobox", { name: "Folder or repository" });

  await search.fill("https://example.com/b.git");
  await search.press("Enter");
  await search.press("Escape");
  const second = page.waitForResponse("**/api/sessions");

  await form.getByRole("button", { name: "Start session" }).click();
  await second;

  await page.reload();
  await page.getByRole("button", { name: "New session" }).click();
  await form.getByRole("button", { name: "Folder or repository" }).waitFor();

  await page.unroute("**/api/sessions");

  expect(asked).toMatchObject([
    {
      workspace: {
        kind: "clone",
        repository: "https://example.com/a.git",
        startPoint: "",
      },
    },
    {
      workspace: {
        kind: "repositories",
        repositories: [
          { repository: "https://example.com/a.git" },
          { repository: "https://example.com/b.git" },
        ],
      },
    },
  ]);

  expect(
    await form
      .getByRole("button", { name: "Folder or repository" })
      .textContent(),
  ).toBe("a, b");
}, 30_000);

test("starts a session with the task from the New session form", async () => {
  faux.setResponses([fauxAssistantMessage([fauxText("on it")])]);
  await page.goto(server.url.href);

  await page.getByRole("button", { name: "New session" }).click();
  const form = page.locator("form#create");

  await pickWorkspace(form, root);

  const task = form.getByLabel("What should Pi do?");

  await task.fill("Paginate the session list");
  await task.press("Control+Enter");

  await page
    .locator('#chat li[data-role="user"]', {
      hasText: "Paginate the session list",
    })
    .waitFor();

  await page
    .locator('#chat li[data-role="assistant"]', { hasText: "on it" })
    .waitFor();
}, 30_000);

test("keeps a setup step on home until it's done, and opens it from there", async () => {
  let phase: "none" | "no models" = "none";

  await page.route("**/api/environments", async (route) => {
    const real = (await (await route.fetch()).json()) as Environment[];

    await route.fulfill({
      json:
        phase === "none"
          ? []
          : real.slice(0, 1).map((each) => ({ ...each, models: [] })),
    });
  });

  await page.goto(server.url.href);
  const reminders = page.getByRole("region", { name: "Finish setting up" });

  await reminders.getByText("Where should Pi work?").waitFor();
  await reminders.getByRole("link", { name: "Set up" }).first().click();
  await page.getByRole("heading", { name: "Where should Pi work?" }).waitFor();
  await page.getByRole("button", { name: "Show the command" }).click();

  const command = page.getByLabel("Join command");
  await command.filter({ hasText: "PIPOCA_KEY=pck_" }).waitFor();

  expect(await command.textContent()).toEndWith(
    `pipoca agent --server ${server.url.origin}`,
  );

  phase = "no models";
  await page.goto(server.url.href);
  await reminders.getByText("Connect a model").waitFor();

  expect(await reminders.getByText("Where should Pi work?").count()).toBe(0);

  await page.unroute("**/api/environments");
  await page.reload();
  await reminders.getByText("Make Pi yours").waitFor();

  expect(await reminders.getByText("Connect a model").count()).toBe(0);

  for (const heading of ["Connect your code", "Make Pi yours"]) {
    await reminders.getByRole("button", { name: `Dismiss ${heading}` }).click();
  }

  await reminders.waitFor({ state: "hidden" });
  await page.reload();
  await page.getByRole("button", { name: "New session" }).waitFor();

  expect(await reminders.isVisible()).toBe(false);
}, 20_000);

test("makes an Environment and shows its key once", async () => {
  await page.goto(server.url.href);
  await openSettings("Environments");

  await page.getByRole("button", { name: "New Environment" }).click();
  await page.getByLabel("New Environment name").fill("builders");
  await page.getByRole("button", { name: "Create" }).click();

  const command = page.getByLabel("Join command");
  await command.filter({ hasText: "PIPOCA_KEY=pck_" }).waitFor();

  expect(await command.textContent()).toContain(
    `--server ${server.url.origin}`,
  );

  await page.reload();
  await page.getByRole("button", { name: "Replace key" }).waitFor();

  expect(await command.count()).toBe(0);

  await openSettings("Environments");
  await openEnvironment("e2e");

  await page
    .getByRole("list", { name: "Folders" })
    .getByText(root, { exact: true })
    .waitFor();
});

test("changes a plugin's setting on the Plugins page", async () => {
  await page.goto(server.url.href);
  await openSettings("Plugins");

  const library = page.getByRole("listitem", { name: "Library" });
  await library.getByRole("switch", { name: "On", checked: true }).waitFor();
  await library.getByRole("button", { name: "Settings" }).click();

  const limit = library.getByLabel(/^File size limit in MB/);
  expect(await limit.inputValue()).toBe("10");

  await limit.fill("25");
  await library.getByRole("button", { name: "Save" }).click();
  await library.getByText("Saved").waitFor();

  await page.reload();
  await library.getByRole("button", { name: "Settings" }).click();
  expect(await limit.inputValue()).toBe("25");

  await limit.fill("10");
  await library.getByRole("button", { name: "Save" }).click();
  await library.getByText("Saved").waitFor();
});

test("finds a plugin by a word of its name or description", async () => {
  await page.goto(server.url.href);
  await openSettings("Plugins");

  const plugins = page.getByRole("list", { name: "Plugins" });
  await plugins.getByRole("listitem", { name: "Library" }).waitFor();

  await page.getByLabel("Search plugins").fill("subagents");

  await plugins
    .getByRole("listitem", { name: "Library" })
    .waitFor({ state: "detached" });

  expect(await plugins.getByRole("listitem").count()).toBe(1);
});

test("names an alias and orders its fallbacks on the Models page", async () => {
  await page.goto(server.url.href);
  await openSettings("Models");

  await page.getByRole("button", { name: "New alias" }).click();
  await page.getByLabel("New alias name").fill("smart");
  await page.getByLabel("First model").fill("faux/one");
  await page.getByRole("button", { name: "Add alias" }).click();

  const alias = page.getByRole("region", { name: "Alias smart" });
  await alias.getByRole("listitem", { name: "faux/one" }).waitFor();

  await alias.getByLabel("Add a fallback", { exact: true }).fill("faux/two");
  await alias.getByRole("button", { name: "Add", exact: true }).click();
  await alias.getByRole("listitem", { name: "faux/two" }).waitFor();

  await alias.getByRole("button", { name: "Move faux/two up" }).click();

  await alias
    .getByRole("listitem")
    .first()
    .getByText("two", { exact: true })
    .waitFor();

  await alias
    .getByLabel("Reasoning of faux/one")
    .selectOption({ label: "High reasoning" });

  await alias.getByRole("listitem", { name: "faux/one:high" }).waitFor();

  await alias.getByRole("button", { name: "Make default" }).click();
  await alias.getByText("Default for new Sessions").waitFor();

  await alias.getByRole("button", { name: "Remove smart" }).click();
  await alias.waitFor({ state: "detached" });
});

test("edits pipoca.json on the Configuration page, and Settings follows it", async () => {
  await page.goto(server.url.href);
  await openSettings("Configuration");

  const file = page.getByRole("region", { name: "pipoca.json" });
  const contents = file.getByLabel("pipoca.json contents");
  await file.getByText("Valid", { exact: true }).waitFor();

  const before = await contents.inputValue();

  await contents.fill("{ nope");
  await file.getByText("Not valid JSON").waitFor();

  expect(await file.getByRole("button", { name: "Save" }).isDisabled()).toBe(
    true,
  );

  const edited = JSON.parse(before) as Record<string, unknown>;

  await contents.fill(
    JSON.stringify({
      ...edited,
      "git-hosts": { hosts: [{ host: "git.example.org", label: "Forge" }] },
    }),
  );

  await file.getByRole("button", { name: "Save" }).click();
  await file.getByText("Edited").waitFor({ state: "detached" });

  await openSettings("Git hosts");
  await page.getByRole("list", { name: "Hosts" }).getByText("Forge").waitFor();

  await openSettings("Configuration");
  await contents.fill(before);
  await file.getByRole("button", { name: "Save" }).click();
  await file.getByText("Edited").waitFor({ state: "detached" });
});

test("turns an installed plugin on for the next start", async () => {
  await page.goto(server.url.href);
  await openSettings("Plugins");

  const hello = page.getByRole("listitem", { name: "Hello" });
  await hello.getByText(/^Installed/).waitFor();

  page.once("dialog", (dialog) => {
    void dialog.accept();
  });

  await hello.getByRole("switch", { name: "On" }).click();
  await hello.getByText("It turns on when the server restarts.").waitFor();
  await hello.getByText("Off until restart").waitFor();

  await page.getByRole("button", { name: "Restart now" }).click();
  await page.getByText(/restart it yourself/).waitFor();

  await page.reload();
  await hello.getByRole("switch", { name: "On", checked: true }).click();
  await hello.getByRole("switch", { name: "On", checked: false }).waitFor();

  expect(await hello.getByText(/when the server restarts/).count()).toBe(0);
});

test("installs a plugin from a git repository, asks before turning it on, and removes it", async () => {
  const source = join(root, "sources", "weather");
  await mkdir(source, { recursive: true });

  await writeFile(
    join(source, "package.json"),
    JSON.stringify({
      pipoca: {
        id: "weather",
        title: "Weather",
        description: "Says the weather.",
        engine: 1,
        capabilities: ["routes"],
      },
    }),
  );

  for (const args of [
    ["init", "-q"],
    ["add", "-A"],
    ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "c"],
  ]) {
    execFileSync("git", ["-C", source, ...args]);
  }

  await page.goto(server.url.href);
  await openSettings("Plugins");

  await page.getByRole("button", { name: "Install from git" }).click();

  await page
    .getByLabel(/Install from a git repository/)
    .fill(`file://${source}`);

  await page.getByRole("button", { name: "Install", exact: true }).click();

  await page.getByText("Installed Weather, turned off.").waitFor();

  const weather = page.getByRole("listitem", { name: "Weather" });
  await weather.getByText(`file://${source} at`).waitFor();

  const asked = new Promise<string>((resolve) => {
    page.once("dialog", (dialog) => {
      resolve(dialog.message());
      void dialog.accept();
    });
  });

  await weather.getByRole("switch", { name: "On" }).click();
  expect(await asked).toContain("It asks for routes");
  await weather.getByRole("switch", { name: "On", checked: true }).click();

  page.once("dialog", (dialog) => {
    void dialog.accept();
  });

  await weather.getByRole("button", { name: "Remove" }).click();
  await weather.waitFor({ state: "detached" });
});

test("shows an installed plugin's page with the app's React and components", async () => {
  await page.goto(server.url.href);
  await openSettings("Plugins");

  expect(
    await page
      .getByRole("listitem", { name: "Greeter" })
      .getByRole("button", { name: "Remove" })
      .isDisabled(),
  ).toBe(true);

  await page.getByRole("link", { name: "Back to Pipoca" }).click();

  // A newly installed plugin's page starts under More (ADR 0040).
  await page
    .locator("#plugin-nav")
    .getByRole("button", { name: "More" })
    .click();

  await page.getByRole("link", { name: "Greeter" }).click();

  const button = page.getByRole("button", { name: "Hellos: 0" });
  await button.click();
  await page.getByRole("button", { name: "Hellos: 1" }).waitFor();
});

test("says why an installed plugin's web part didn't load, and draws the rest", async () => {
  await page.goto(server.url.href);
  await openSettings("Plugins");

  await page
    .getByRole("listitem", { name: "Faulty" })
    .getByText("Its web part didn't load: faulty on purpose")
    .waitFor();
});

test("pins a plugin page to the sidebar and keeps the rest under More", async () => {
  await page.goto(server.url.href);
  const nav = page.locator("#plugin-nav");
  const library = nav.getByRole("link", { name: "Library" });

  await nav.getByRole("link", { name: "Projects" }).waitFor();
  expect(await library.count()).toBe(0);

  await nav.getByRole("button", { name: "More" }).click();
  await nav.getByRole("button", { name: "Pin Library" }).click();
  await nav.getByRole("button", { name: "Unpin Library" }).waitFor();

  await page.reload();
  await library.waitFor();
  expect(await nav.getByRole("button", { name: "More" }).count()).toBe(1);

  await nav.getByRole("button", { name: "Unpin Library" }).click();
  await page.reload();
  await nav.getByRole("link", { name: "Projects" }).waitFor();
  expect(await library.count()).toBe(0);
});

test("puts a pin back when the server doesn't save it", async () => {
  const { promise: pinned, resolve: refuse } = Promise.withResolvers();

  await page.route("**/api/pinned-pages", async (route) => {
    if (route.request().method() !== "PUT") {
      await route.continue();

      return;
    }

    await pinned;

    await route.fulfill({
      status: 500,
      json: { error: "internal", message: "disk full" },
    });
  });

  await page.goto(server.url.href);
  const nav = page.locator("#plugin-nav");

  await nav.getByRole("button", { name: "More" }).click();
  await nav.getByRole("button", { name: "Pin Library" }).click();
  await nav.getByRole("button", { name: "Unpin Library" }).waitFor();
  refuse(undefined);

  await nav
    .getByRole("button", { name: "Pin Library", exact: true })
    .waitFor({ timeout: 2000 });

  await page.unroute("**/api/pinned-pages");
});

test("connects a model provider from Settings by answering its prompts", async () => {
  await page.goto(server.url.href);
  await openSettings("Accounts");

  await page.getByRole("button", { name: "Add provider" }).click();

  const form = page.getByRole("form", { name: "Connect a model provider" });
  await form.getByLabel("Provider").selectOption({ label: "Mistral" });
  await form.getByLabel("Log in with").selectOption({ label: "API key" });
  await form.getByRole("button", { name: "Connect" }).click();

  const card = page.getByRole("region", { name: "Connecting Mistral" });
  await card.locator('input[type="password"]').fill("sk-mistral");
  await card.getByRole("button", { name: "Continue" }).click();

  await card.getByText("Connected to Mistral.").waitFor();

  await page
    .getByRole("list", { name: "Your model logins" })
    .getByText("mistral")
    .waitFor();

  await card.getByRole("button", { name: "Close" }).click();
  await card.waitFor({ state: "detached" });

  await page
    .getByRole("button", { name: "Log out of mistral in My defaults" })
    .click();
});

test("gives a Profile its own login, then lets it inherit again", async () => {
  await page.goto(server.url.href);
  await openSettings("Accounts");

  const connect = async (form: Locator): Promise<void> => {
    await form.getByLabel("Log in with").selectOption({ label: "API key" });
    await form.getByRole("button", { name: "Connect" }).click();

    const card = page.getByRole("region", { name: "Connecting Mistral" });
    await card.locator('input[type="password"]').fill("sk-mistral");
    await card.getByRole("button", { name: "Continue" }).click();
    await card.getByText("Connected to Mistral.").waitFor();
    await card.getByRole("button", { name: "Close" }).click();
  };

  await page.getByRole("button", { name: "Add provider" }).click();

  const add = page.getByRole("form", { name: "Connect a model provider" });
  await add.getByLabel("Provider").selectOption({ label: "Mistral" });
  await connect(add);

  await page.getByRole("link", { name: "Profiles" }).click();
  await page.getByRole("link", { name: "New Profile" }).click();

  const editor = page.locator("#profiles-page form").first();
  await editor.getByLabel("Name").fill("Work");
  await editor.getByRole("button", { name: "Create Profile" }).click();

  const logins = page.getByRole("list", { name: "This Profile's logins" });
  await logins.getByText("From My defaults").waitFor();

  await logins
    .getByRole("group", { name: "mistral login" })
    .getByRole("button", { name: "Own login" })
    .click();

  await connect(page.getByRole("form", { name: "Connect Mistral" }));
  await logins.getByText("Its own login").waitFor();

  await logins
    .getByRole("group", { name: "mistral login" })
    .getByRole("button", { name: "Inherit" })
    .click();

  await logins.getByText("From My defaults").waitFor();

  page.once("dialog", async (dialog) => dialog.accept());
  await editor.getByRole("button", { name: "Delete" }).click();
  await page.getByRole("link", { name: "Accounts" }).click();

  await page
    .getByRole("button", { name: "Log out of mistral in My defaults" })
    .click();
});

test("signs in to an MCP server of the base Profile from Settings and comes back to Pipoca", async () => {
  // An MCP server whose authorization server signs anyone in at once.
  const linear: Bun.Server<undefined> = Bun.serve({
    port: 0,
    fetch: (request): Response => {
      const url = new URL(request.url);
      const origin = linear.url.origin;

      if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
        return Response.json({
          resource: `${origin}/mcp`,
          authorization_servers: [origin],
        });
      }

      if (url.pathname.startsWith("/.well-known/")) {
        return Response.json({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        });
      }

      if (url.pathname === "/authorize") {
        const back = new URL(url.searchParams.get("redirect_uri") ?? "");
        back.searchParams.set("code", "granted");
        back.searchParams.set("state", url.searchParams.get("state") ?? "");

        return Response.redirect(back.href, 302);
      }

      if (url.pathname === "/register") {
        return Response.json({ client_id: "client-1" }, { status: 201 });
      }

      if (url.pathname === "/token") {
        return Response.json({
          access_token: "access-1",
          refresh_token: "refresh-1",
          token_type: "Bearer",
          expires_in: 3600,
        });
      }

      return new Response("unauthorized", { status: 401 });
    },
  });

  const base = async (mcpServers: unknown): Promise<void> => {
    await fetch(new URL("/api/base", server.url), {
      method: "PUT",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ mcpServers }),
    });
  };

  try {
    await base({ linear: { url: `${linear.url.origin}/mcp` } });

    await page.goto(server.url.href);
    await openSettings("Accounts");
    await page.getByRole("button", { name: "Sign in to linear" }).click();

    const card = page.getByRole("region", { name: "Connecting linear" });
    const opened = page.context().waitForEvent("page");
    await card.getByRole("link", { name: "Open the sign-in page" }).click();

    const tab = await opened;
    await tab.getByText("Signed in. You can close this tab.").waitFor();
    await tab.close();

    await card.getByText("Connected to linear.").waitFor();
    await page.getByRole("button", { name: "Log out of linear" }).waitFor();
  } finally {
    await base({});
    await linear.stop(true);
  }
});

test("makes an MCP token that works once shown, and revokes it", async () => {
  await page.goto(server.url.href);
  await openSettings("Access tokens");

  await page.getByLabel("Client name").fill("My laptop");
  await page.getByRole("button", { name: "New token" }).click();

  const command = await page.getByLabel("Add command").textContent();
  const secret = /Bearer (pcm_[\w-]+)/.exec(command ?? "")?.[1] ?? "";

  const ping = async (): Promise<number> =>
    (
      await fetch(new URL("/api/mcp", server.url), {
        method: "POST",
        headers: {
          authorization: `Bearer ${secret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      })
    ).status;

  expect(command).toContain(`${server.url.origin}/api/mcp`);
  expect(await ping()).toBe(200);

  await page.reload();
  await page.getByLabel("Add command").waitFor({ state: "detached" });
  expect(await page.content()).not.toContain(secret);

  page.once("dialog", async (dialog) => dialog.accept());

  await page.getByRole("button", { name: "Revoke My laptop" }).click();
  await page.getByText("No client has a token.").waitFor();
  expect(await ping()).toBe(401);
});

test("says why an MCP token wasn't revoked", async () => {
  await page.goto(server.url.href);
  await openSettings("Access tokens");

  await page.getByLabel("Client name").fill("Old laptop");
  await page.getByRole("button", { name: "New token" }).click();
  const revoke = page.getByRole("button", { name: "Revoke Old laptop" });

  await page.route("**/api/mcp-tokens/*", async (route) =>
    route.fulfill({
      status: 500,
      json: { error: "internal", message: "token store is locked" },
    }),
  );

  page.once("dialog", async (dialog) => dialog.accept());
  await revoke.click();
  await page.getByRole("alert").getByText("token store is locked").waitFor();
  await page.unroute("**/api/mcp-tokens/*");

  page.once("dialog", async (dialog) => dialog.accept());
  await revoke.click();
  await page.getByText("No client has a token.").waitFor();
  expect(await page.getByRole("alert").count()).toBe(0);
});

test("edits an Environment's variables and secrets without showing secret values", async () => {
  await page.goto(server.url.href);
  await openSettings("Environments");
  await openEnvironment("e2e");

  const editor = page.locator("#environments-page form");

  await editor.getByRole("button", { name: "Add", exact: true }).click();

  // Pasting a .env into a name fills the rows.
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: server.url.origin,
  });

  await page.evaluate(
    "navigator.clipboard.writeText('export MODE=test\\n# a comment\\nTOKEN=\"s3cret\"\\n')",
  );

  await editor.getByLabel("Name of row 1").press("ControlOrMeta+V");

  await editor.getByRole("button", { name: "Keep TOKEN secret" }).click();
  await editor.getByRole("button", { name: "Save" }).click();

  await editor
    .getByPlaceholder("Saved, type to replace")
    .and(editor.getByLabel("Value of TOKEN"))
    .waitFor();

  await page.reload();

  expect(await editor.getByLabel("Value of MODE").inputValue()).toBe("test");
  expect(await editor.getByLabel("Value of TOKEN").inputValue()).toBe("");
  expect(await page.content()).not.toContain("s3cret");

  await editor.getByRole("button", { name: "Remove TOKEN" }).click();

  // A change made elsewhere while the page is open survives a save here.
  const [environment] = (await (
    await fetch(new URL("/api/environments", server.url), {
      headers: { cookie },
    })
  ).json()) as { readonly id: string; readonly name: string }[];

  await fetch(
    new URL(`/api/environments/${environment?.id ?? ""}`, server.url),
    {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ image: "elsewhere:1" }),
    },
  );

  await editor.getByLabel("Name", { exact: true }).fill("Laptops");
  await editor.getByRole("button", { name: "Save" }).click();

  const environments = async (): Promise<
    readonly { readonly name: string }[]
  > =>
    (await (
      await fetch(new URL("/api/environments", server.url), {
        headers: { cookie },
      })
    ).json()) as {
      readonly name: string;
    }[];

  let saved = await environments();
  while (saved[0]?.name !== "Laptops") {
    await Bun.sleep(50);
    saved = await environments();
  }

  expect(saved[0]).toMatchObject({
    name: "Laptops",
    image: "elsewhere:1",
    variables: { MODE: "test" },
    secrets: [],
  });

  await fetch(
    new URL(`/api/environments/${environment?.id ?? ""}`, server.url),
    {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        name: environment?.name,
        image: null,
        variables: {},
      }),
    },
  );
}, 30_000);

test("starts and stops runner pods from a template's Kubernetes section", async () => {
  const template = (await (
    await fetch(new URL("/api/templates", server.url), {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "Pods" }),
    })
  ).json()) as { readonly id: string };

  await page.goto(server.url.href);
  await openSettings("Environments");
  await page.locator("summary", { hasText: "Pods" }).click();

  const section = page.getByLabel("Kubernetes", { exact: true });
  await section.getByText("isn't running in a cluster").waitFor();

  await section.getByLabel("Workspace").selectOption("claim");
  await section.getByLabel("Claim size").fill("2Gi");
  await section.getByLabel("Most pods").fill("3");
  await section.getByRole("button", { name: "Start runner pods" }).click();
  await section.getByRole("button", { name: "Stop runner pods" }).waitFor();

  const settings = async (): Promise<unknown> =>
    (
      (await (
        await fetch(
          new URL(
            `/api/plugins/kubernetes/templates/${template.id}`,
            server.url,
          ),
          { headers: { cookie } },
        )
      ).json()) as { readonly settings: unknown }
    ).settings;

  expect(await settings()).toMatchObject({
    workspace: "claim",
    claimSize: "2Gi",
    maxPods: 3,
    storageClass: null,
  });

  await page.reload();
  await page.locator("summary", { hasText: "Pods" }).click();

  expect(await section.getByLabel("Claim size").inputValue()).toBe("2Gi");

  await section.getByLabel(/^Pod patch/).fill("{");
  await section.getByRole("button", { name: "Save" }).click();
  await section.getByRole("alert").getByText("isn't valid JSON").waitFor();

  await section.getByLabel(/^Pod patch/).fill("{}");
  await section.getByRole("button", { name: "Save" }).click();
  await section.getByRole("alert").waitFor({ state: "detached" });

  await section.getByRole("button", { name: "Stop runner pods" }).click();
  await section.getByRole("button", { name: "Start runner pods" }).waitFor();

  expect(await settings()).toBeNull();

  await fetch(new URL(`/api/templates/${template.id}`, server.url), {
    method: "DELETE",
    headers: { cookie },
  });
});

test("deletes an Environment from its page", async () => {
  const { environment } = (await (
    await fetch(new URL("/api/environments", server.url), {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "throwaway" }),
    })
  ).json()) as { readonly environment: { readonly id: string } };

  await page.goto(`${server.url.href}#environments/${environment.id}`);

  page.once("dialog", (dialog) => {
    void dialog.accept();
  });

  await page.getByRole("button", { name: "Delete throwaway" }).click();

  await page.getByRole("link", { name: /^throwaway/ }).waitFor({
    state: "detached",
  });
});

test("lists everyone on the admins' People page, with their Environments a click away", async () => {
  await page.goto(server.url.href);
  await openSettings("People");

  const pedro = page.getByRole("row", { name: "pedro", exact: true });
  await pedro.waitFor();

  expect(await pedro.getByText(/^you\b/).count()).toBe(1);
  expect(await pedro.getByLabel("Role of pedro").inputValue()).toBe("admin");

  await pedro.getByRole("button", { name: "More for pedro" }).click();

  await page
    .getByLabel("pedro's work")
    .getByRole("list", { name: "Environments" })
    .waitFor();
});

test("adds company sign-in from a preset, tests it, and removes it", async () => {
  await page.goto(server.url.href);
  await openSettings("Sign-in");

  await page
    .getByRole("list", { name: "Add a provider" })
    .getByRole("button", { name: /Okta/ })
    .click();

  const form = page.getByRole("form", { name: "New Okta sign-in" });
  await form.getByLabel("Issuer").fill("https://127.0.0.1:1");
  await form.getByLabel("Client ID").fill("pipoca");
  await form.getByRole("button", { name: "Add provider" }).click();

  const providers = page.getByRole("list", { name: "Providers" });
  await providers.getByText("0 people signed in this week").waitFor();

  await providers.getByRole("button", { name: "Test Okta" }).click();
  await providers.getByText("Can't reach it").waitFor();

  page.once("dialog", (dialog) => {
    void dialog.accept();
  });

  await providers.getByRole("button", { name: "Edit Okta" }).click();
  await page.getByRole("button", { name: "Remove Okta" }).click();
  await providers.waitFor({ state: "detached" });
});

test("guides an admin from a token-only host to a Connect button", async () => {
  await page.goto(server.url.href);
  await openSettings("Git hosts");

  await page.getByRole("button", { name: "Add a host" }).click();

  const form = page.getByRole("form", { name: "New host" });
  await form.getByLabel("Host").fill("git.example.com");
  await form.getByRole("button", { name: "Add host" }).click();

  const hosts = page.getByRole("list", { name: "Hosts" });
  await hosts.getByText("Tokens only").waitFor();

  await page
    .getByRole("button", { name: "Set up Connect for git.example.com" })
    .click();

  const setup = page.getByRole("region", {
    name: "Set up Connect for git.example.com",
  });

  await setup.getByLabel("Client ID").fill("Iv1.abc");
  await setup.getByLabel("Client secret").fill("shh");
  await setup.getByRole("button", { name: "Save" }).click();

  await hosts.getByText("Sign-in ready").waitFor();
  await setup.getByRole("button", { name: "Connect your account" }).waitFor();

  await setup.getByRole("button", { name: "Done" }).click();
  await page.getByRole("button", { name: "Edit git.example.com" }).click();
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Remove git.example.com" }).click();
  await hosts.getByText("git.example.com").waitFor({ state: "detached" });
});

test("invites someone by email, who joins with their link and a password", async () => {
  await page.goto(server.url.href);
  await openSettings("People");

  await page.getByRole("button", { name: "Invite people" }).click();

  const dialog = page.getByRole("dialog", { name: "Invite people" });
  await dialog.getByLabel("Email addresses").fill("Bea@Example.com");
  await dialog.getByLabel("Email addresses").press("Enter");
  await dialog.getByRole("button", { name: "Admins" }).click();
  await dialog.getByRole("button", { name: "Invite 1 person" }).click();

  const link =
    (await dialog
      .getByRole("list", { name: "Invite links" })
      .getByText(/#join\//)
      .textContent()) ?? "";

  await dialog.getByRole("button", { name: "Done" }).click();
  await page.getByRole("tab", { name: "Invites · 1" }).click();
  await page.getByRole("row", { name: "bea@example.com" }).waitFor();

  const context = await browser.newContext();

  try {
    const tab = await context.newPage();
    await tab.goto(link);

    await tab
      .getByRole("heading", { name: "pedro invited you to Pipoca" })
      .waitFor();

    const form = tab.getByRole("form", { name: "Make your account" });
    expect(await form.getByLabel("Username").inputValue()).toBe("bea");

    await form.getByLabel("Password").fill("correct horse");
    await form.getByRole("button", { name: "Join" }).click();
    await tab.getByText("Step 1 of").or(tab.getByText("Step 2 of")).waitFor();
  } finally {
    await context.close();
  }

  await page.getByRole("tab", { name: /^Members/ }).click();
  await page.getByRole("row", { name: "bea", exact: true }).waitFor();
}, 30_000);

test("shows why an Environment's last runner pod failed", async () => {
  await page.route("**/api/plugins/kubernetes/environments/*", async (route) =>
    route.fulfill({
      json: {
        settings: {
          workspace: "pod",
          capacity: 1,
          maxPods: 5,
          idleSeconds: 300,
          claimSize: "10Gi",
          storageClass: null,
          podPatch: {},
        },
        startsPods: true,
        editable: false,
        lastFailure: {
          pod: "pi-runner-1a2b3c4d",
          problem: "runner exited with 1: EACCES: permission denied",
          at: "2026-10-25T11:00:00.000Z",
          retryAt: "2026-10-25T11:00:20.000Z",
        },
      },
    }),
  );

  await page.goto(server.url.href);
  await openSettings("Environments");
  await openEnvironment("e2e");

  const failure = page
    .getByLabel("Kubernetes", { exact: true })
    .getByRole("alert");

  await failure.getByText("EACCES: permission denied").waitFor();

  expect(await failure.textContent()).toContain(
    "Runner pod pi-runner-1a2b3c4d failed",
  );

  await page.unroute("**/api/plugins/kubernetes/environments/*");
});

test("keeps a Profile that follows a repository read-only until it is copied", async () => {
  const profile = (await (
    await fetch(new URL("/api/profiles", server.url), {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "Team kit", agentsMd: "Be careful." }),
    })
  ).json()) as { readonly id: string };

  const meta = join(root, "config", "profiles", profile.id, "profile.json");

  await writeFile(
    meta,
    JSON.stringify({
      ...(JSON.parse(await readFile(meta, "utf8")) as object),
      source: {
        url: "https://example.com/team/kit.git",
        path: "profiles/kit",
        commit: "0123456789abcdef",
      },
    }),
  );

  await page.goto(`${server.url.href}#profiles/${profile.id}`);

  const synced = page.getByLabel("Synced from a repository");
  await synced.getByText("0123456").waitFor();

  expect(await page.getByRole("button", { name: "Save" }).count()).toBe(0);

  await synced.getByRole("button", { name: "Make a copy" }).click();

  await page.getByRole("link", { name: "Team kit copy" }).waitFor();

  expect(await page.getByLabel("Synced from a repository").count()).toBe(0);
  expect(await page.getByRole("button", { name: "Save" }).count()).toBe(1);
});

test("lists a Profile's packages as chips and edits its folder's files", async () => {
  await page.goto(server.url.href);
  await openSettings("Profiles");
  await page.getByRole("link", { name: "New Profile" }).click();

  const editor = page.locator("#profiles-page form").first();
  const add = editor.getByLabel("Add to Pi packages");

  await editor.getByLabel("Name").fill("Tools");
  await add.fill("npm:pi-subagents");
  await add.press("Enter");
  await add.fill("./tools");
  await add.press("Enter");
  await editor.getByRole("button", { name: "Remove npm:pi-subagents" }).click();
  await editor.getByRole("button", { name: "Create Profile" }).click();
  await page.getByRole("link", { name: "Tools" }).waitFor();
  await page.reload();

  const packages = page.getByRole("list", { name: "Packages", exact: true });

  await packages.getByText("./tools").first().waitFor();
  expect(await packages.getByRole("listitem").count()).toBe(1);

  const profilesPage = page.locator("#profiles-page");
  const tabs = profilesPage.getByRole("navigation", { name: "Profile" });

  await profilesPage.getByRole("link", { name: "Open as files" }).click();
  await profilesPage.getByRole("button", { name: "settings.json" }).waitFor();

  await profilesPage
    .getByPlaceholder("skills/review/SKILL.md")
    .fill("prompts/fix.md");

  await profilesPage.getByRole("button", { name: "New", exact: true }).click();
  await profilesPage.getByLabel("prompts/fix.md").fill("Fix $1.");
  await profilesPage.getByRole("button", { name: "Save file" }).click();
  await profilesPage.getByRole("button", { name: "prompts/fix.md" }).waitFor();

  await tabs.getByRole("link", { name: "Prompts" }).click();
  await profilesPage.getByRole("button", { name: /^fix/ }).waitFor();

  await tabs.getByRole("link", { name: "Skills" }).click();
  await profilesPage.getByLabel("New in Skills").fill("review");
  await profilesPage.getByRole("button", { name: "New", exact: true }).click();

  expect(
    await profilesPage.getByLabel("skills/review/SKILL.md").inputValue(),
  ).toContain("name: review");

  await profilesPage.getByRole("button", { name: "Save file" }).click();
  await profilesPage.getByRole("button", { name: /^review/ }).waitFor();

  await tabs.getByRole("link", { name: "Overview" }).click();

  await page
    .getByRole("list", { name: "Skills" })
    .getByRole("switch", { name: "review" })
    .waitFor();

  await page.getByRole("list", { name: "Prompts" }).getByText("/fix").waitFor();

  await profilesPage.getByRole("button", { name: "Add package" }).click();
  await profilesPage.getByLabel("Package source").fill("npm:pi-lint");
  await profilesPage.getByRole("button", { name: "Add", exact: true }).click();
  await packages.getByRole("switch", { name: "npm:pi-lint" }).waitFor();
  await packages.getByRole("button", { name: "Remove npm:pi-lint" }).click();

  await packages
    .getByRole("switch", { name: "npm:pi-lint" })
    .waitFor({ state: "detached" });

  await page
    .getByRole("list", { name: "Skills" })
    .getByRole("switch", { name: "review" })
    .click();

  await page
    .getByRole("list", { name: "Skills" })
    .getByRole("switch", { name: "review", checked: false })
    .waitFor();

  await packages.getByRole("switch", { name: "./tools" }).click();

  await packages
    .getByRole("switch", { name: "./tools", checked: false })
    .waitFor();

  await profilesPage.getByRole("button", { name: "Add to Pi's" }).click();
  await profilesPage.getByLabel("Added to Pi's prompt").fill("Be brief.");

  await profilesPage
    .getByRole("button", { name: "Save system prompt" })
    .click();

  await page.reload();

  expect(
    await profilesPage.getByLabel("Added to Pi's prompt").inputValue(),
  ).toBe("Be brief.");

  const settings = JSON.parse(
    await readFile(
      join(root, "config", "profiles", "tools", "settings.json"),
      "utf8",
    ),
  ) as { skills?: unknown; packages?: unknown };

  expect(settings.skills).toEqual(["-skills/review"]);

  expect(settings.packages).toEqual([
    { source: "./tools", extensions: [], skills: [], prompts: [], themes: [] },
  ]);

  page.once("dialog", async (dialog) => dialog.accept());
  await editor.getByRole("button", { name: "Delete" }).click();

  await page
    .getByRole("link", { name: "Tools" })
    .waitFor({ state: "detached" });
});

test("builds a Profile on another, over My defaults", async () => {
  await page.goto(server.url.href);
  await openSettings("Profiles");

  const profiles = page.getByRole("navigation", { name: "Profiles" });
  await profiles.getByRole("link", { name: "My defaults" }).click();

  const editor = page.locator("#profiles-page form").first();
  const add = editor.getByLabel("Add to Pi packages");

  await add.fill("npm:my-provider");
  await add.press("Enter");
  await editor.getByRole("button", { name: "Save" }).click();
  await editor.getByText("Saved").waitFor();
  await page.reload();
  await editor.getByText("npm:my-provider").waitFor();

  // A package nobody can install would stop every later Session.
  await editor.getByRole("button", { name: "Remove npm:my-provider" }).click();
  await editor.getByRole("button", { name: "Save" }).click();
  await editor.getByText("Saved").waitFor();

  await page.getByRole("link", { name: "New Profile" }).click();
  await editor.getByLabel("Name").fill("Deep");
  await editor.getByRole("button", { name: "Builds on" }).click();
  await page.getByRole("option", { name: "Default" }).click();
  await editor.getByRole("button", { name: "Create Profile" }).click();
  await profiles.getByRole("link", { name: "Deep" }).waitFor();
  await page.reload();

  expect(
    await page.getByRole("button", { name: "Builds on" }).textContent(),
  ).toContain("Default");

  page.once("dialog", async (dialog) => dialog.accept());
  await editor.getByRole("button", { name: "Delete" }).click();

  await profiles
    .getByRole("link", { name: "Deep" })
    .waitFor({ state: "detached" });
});

test("imports a Profile from a picked folder with its files", async () => {
  const folder = join(root, "agent-folder");

  await mkdir(join(folder, "skills", "lint"), { recursive: true });
  await writeFile(join(folder, "skills", "lint", "SKILL.md"), "# Lint");
  await writeFile(join(folder, "auth.json"), "{}");

  await page.goto(server.url.href);
  await openSettings("Profiles");

  await page
    .locator("#profiles-page")
    .getByLabel("Choose a folder")
    .setInputFiles(folder);

  await page.getByRole("link", { name: "agent-folder" }).waitFor();

  await page
    .getByRole("list", { name: "Skills" })
    .getByText("lint")
    .first()
    .waitFor();
});

test("makes a Profile and starts a session that follows its instructions", async () => {
  let request = "";

  faux.setResponses([
    (context) => {
      request = JSON.stringify(context);

      return fauxAssistantMessage([fauxText("arr")]);
    },
  ]);

  await page.goto(server.url.href);
  await openSettings("Profiles");
  await page.getByRole("link", { name: "New Profile" }).click();

  const editor = page.locator("#profiles-page form");

  await editor.getByLabel("Name").fill("Pirate");
  await editor.getByRole("button", { name: "Create Profile" }).click();
  await page.getByRole("link", { name: "Pirate" }).waitFor();
  await page.getByRole("link", { name: "Instructions" }).click();

  const instructions = page.locator("#profiles-page");

  await instructions.getByLabel("AGENTS.md").fill("Answer like a pirate.");
  await instructions.getByRole("button", { name: "Save" }).first().click();

  await instructions
    .getByRole("button", { name: "Save" })
    .first()
    .and(page.locator(":disabled"))
    .waitFor();

  await page.getByRole("link", { name: "Back to Pipoca" }).click();
  await page.getByRole("button", { name: "New session" }).click();
  const form = page.locator("form#create");

  await pickWorkspace(form, root);
  await form.getByRole("button", { name: "Profile" }).click();
  await form.getByRole("option", { name: "Pirate" }).click();

  const task = form.getByLabel("What should Pi do?");

  await task.fill("Say hello");
  await task.press("Control+Enter");

  await page
    .locator('#chat li[data-role="assistant"]', { hasText: "arr" })
    .waitFor();

  expect(request).toContain("Answer like a pirate.");
}, 30_000);

test("archives a session, shows it only with archived sessions and unarchives it", async () => {
  await page.goto(server.url.href);

  await page.getByRole("button", { name: "New session" }).click();
  const form = page.locator("form#create");

  await pickWorkspace(form, root);
  await form.getByRole("button", { name: "Start session" }).click();
  await page.locator("#status", { hasText: "idle" }).waitFor();
  const id = new URL(page.url()).hash.slice(1);
  const item = page.locator(`#sessions li[data-id="${id}"]`);
  await item.waitFor();

  await page.getByRole("button", { name: "Session actions" }).click();
  await page.getByRole("menuitem", { name: "Archive" }).click();
  await page.locator("#status", { hasText: "archived" }).waitFor();
  await page.locator("#prompt").waitFor({ state: "hidden" });
  await page.reload();
  await page.locator("#status", { hasText: "archived" }).waitFor();

  await item.waitFor({ state: "detached" });
  await page.getByLabel("Show archived").check();
  await item.waitFor();
  await page.getByRole("button", { name: "Session actions" }).click();
  await page.getByRole("menuitem", { name: "Unarchive" }).click();
  await page.locator("#status", { hasText: "idle" }).waitFor();

  expect(new URL(page.url()).hash.slice(1)).toBe(id);
  expect(await page.locator("#prompt").isVisible()).toBe(true);
}, 30_000);

test("forks a session from a picked message and opens it with that message to edit", async () => {
  faux.setResponses([
    fauxAssistantMessage([fauxText("first answer")]),
    fauxAssistantMessage([fauxText("second answer")]),
  ]);

  await page.goto(server.url.href);

  await page.getByRole("button", { name: "New session" }).click();
  const form = page.locator("form#create");

  await pickWorkspace(form, root);
  await form.getByRole("button", { name: "Start session" }).click();
  await page.locator("#status", { hasText: "idle" }).waitFor();
  const id = new URL(page.url()).hash.slice(1);

  for (const [text, answer] of [
    ["Plan the release\nwith notes", "first answer"],
    ["Write the changelog", "second answer"],
  ] as const) {
    await page.locator("#prompt-text").fill(text);
    await page.locator("#prompt-text").press("Enter");

    await page
      .locator('#chat li[data-role="assistant"]', { hasText: answer })
      .waitFor();
  }

  await page.getByRole("button", { name: "Session actions" }).click();
  await page.getByRole("menuitem", { name: "Fork" }).click();

  const messages = page.getByRole("listbox", { name: "Fork from a message" });

  const options = await messages.getByRole("option").allInnerTexts();

  expect(options.map((text) => text.replace(/\s+/g, " "))).toEqual([
    "Write the changelog just now",
    "Plan the release just now",
  ]);

  await messages.getByRole("option", { name: /Plan the release/ }).click();
  await page.waitForURL((url) => url.hash !== "" && url.hash !== `#${id}`);
  const fork = new URL(page.url()).hash.slice(1);

  await page.locator(`#sessions li[data-id="${fork}"]`).waitFor();
  await page.locator("#status", { hasText: "idle" }).waitFor();

  expect(await page.locator("#prompt-text").inputValue()).toBe(
    "Plan the release\nwith notes",
  );

  expect(await page.locator("#chat li[data-role]").count()).toBe(0);
}, 30_000);

test("finds sessions by search and notifies when one finishes", async () => {
  await page.context().grantPermissions(["notifications"]);

  await page.addInitScript(() => {
    const shown: string[] = [];

    Object.assign(globalThis, {
      shown,
      Notification: Object.assign(
        class {
          constructor(title: string) {
            shown.push(title);
          }

          addEventListener(): void {
            return undefined;
          }
        },
        { permission: "granted" },
      ),
    });
  });

  // Long enough for the two-second session poll to see it working.
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 3" })], {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage([fauxText("done here")]),
  ]);

  await page.goto(server.url.href);

  await page.getByRole("button", { name: "New session" }).click();
  const form = page.locator("form#create");

  await pickWorkspace(form, root);
  await form.getByRole("button", { name: "Start session" }).click();
  await page.locator("#status", { hasText: "idle" }).waitFor();
  const id = new URL(page.url()).hash.slice(1);
  const item = page.locator(`#sessions li[data-id="${id}"]`);

  await page.getByRole("button", { name: "Search" }).click();
  const search = page.getByLabel("Search sessions");
  await search.fill("no-such-session");
  await item.waitFor({ state: "detached" });
  await page.getByText("No sessions match.").waitFor();
  await search.fill("pipoca-e2e");
  await item.waitFor();

  await page.locator("#prompt-text").fill("finish");
  await page.locator("#prompt-text").press("Enter");

  await page
    .locator("#plugin-nav")
    .getByRole("link", { name: "Projects" })
    .click();

  await page.waitForFunction(() =>
    (globalThis as unknown as { shown: string[] }).shown.some((title) =>
      title.startsWith("Pi finished in"),
    ),
  );
}, 30_000);

test("answers the agent's questions in the prompt card", async () => {
  faux.setResponses([
    fauxAssistantMessage(
      [
        fauxText("Two quick questions."),
        fauxToolCall("ask_user", {
          questions: [
            {
              id: "size",
              label: "Size",
              prompt: "Which size?",
              type: "single",
              options: [
                { value: "s", label: "Small", description: "Cheap" },
                { value: "l", label: "Large", description: "Fast" },
              ],
            },
          ],
        }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage([fauxText("going large")]),
  ]);

  await page.goto(server.url.href);

  await page.getByRole("button", { name: "New session" }).click();
  const form = page.locator("form#create");

  await pickWorkspace(form, root);
  await form.getByRole("button", { name: "Start session" }).click();
  await page.locator("#status", { hasText: "idle" }).waitFor();

  await page.locator("#prompt-text").fill("pick a size");
  await page.locator("#prompt-text").press("Enter");

  const card = page.locator('[data-role="prompt"]');
  await card.getByRole("heading", { level: 2, name: "Which size?" }).waitFor();
  await page.locator("#sessions").getByText("Needs you").waitFor();
  await card.getByLabel("Large").check();

  expect(
    await page.locator("#chat").getByText("Two quick questions.").count(),
  ).toBe(1);

  await card.getByText("Fast").waitFor();
  await card.getByRole("button", { name: "Review answers" }).click();
  await card.locator("dd", { hasText: "Large" }).waitFor();
  await card.getByRole("button", { name: "Submit" }).click();

  await page
    .locator('#chat li[data-role="assistant"]', { hasText: "going large" })
    .waitFor();

  await card.waitFor({ state: "detached" });

  await page
    .locator("#sessions")
    .getByText("Needs you")
    .waitFor({ state: "detached" });

  const work = page.locator('#chat li[data-role="work"]');

  await work
    .locator("summary", { hasText: /Worked for \d+s\s*· 1 other step/ })
    .waitFor();

  await page
    .locator('#chat [data-role="answer-meta"]', { hasText: "faux-1" })
    .getByText("just now")
    .waitFor();

  await work.locator("summary").first().click();
  await work.getByText("Asked").click();
  await work.locator("pre", { hasText: "Large" }).waitFor();
}, 30_000);

test("shows the session's changes and usage from their plugins", async () => {
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  await writeFile(join(root, ".git/info/exclude"), "/*\n!/notes.txt\n");

  faux.setResponses([
    fauxAssistantMessage([
      fauxToolCall("write", { path: "notes.txt", content: "new notes\n" }),
    ]),
    fauxAssistantMessage([fauxText("wrote it")]),
  ]);

  await page.goto(server.url.href);

  await page.getByRole("button", { name: "New session" }).click();
  const form = page.locator("form#create");

  await pickWorkspace(form, root);
  await form.getByRole("button", { name: "Start session" }).click();
  await page.locator("#status", { hasText: "idle" }).waitFor();

  await page.locator("#prompt-text").fill("write notes");
  await page.locator("#prompt-text").press("Enter");

  await page.getByRole("button", { name: "Diff, 1 file changed" }).click();
  const changes = page.getByRole("dialog", { name: "Changes" });
  await changes.getByText("Changes (1 file)").waitFor();
  await changes.locator("tr", { hasText: "new notes" }).waitFor();
  await page.keyboard.press("Escape");
  await changes.waitFor({ state: "hidden" });

  await page
    .locator('#plugin-header [data-plugin="usage"] [title*=" out "]')
    .waitFor();
}, 30_000);

test("lists a Session's pending wake-ups above the composer and cancels one", async () => {
  faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall("schedule_wakeup", {
          delay_minutes: 30,
          reason: "Check CI on #552",
          message: "See whether CI passed.",
        }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage([fauxText("I'll check back")]),
  ]);

  await page.goto(server.url.href);

  await page.getByRole("button", { name: "New session" }).click();
  const form = page.locator("form#create");

  await pickWorkspace(form, root);
  await form.getByRole("button", { name: "Start session" }).click();
  await page.locator("#status", { hasText: "idle" }).waitFor();

  await page.locator("#prompt-text").fill("check CI later");
  await page.locator("#prompt-text").press("Enter");

  const wakeUps = page.getByRole("list", { name: "Wake-ups" });
  await wakeUps.getByText("Check CI on #552").waitFor();

  await wakeUps
    .getByRole("button", { name: "Cancel wake-up: Check CI on #552" })
    .click();

  await wakeUps.waitFor({ state: "detached" });
}, 30_000);

test("writes a routine from a starter, runs it by hand and opens its run", async () => {
  faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall("end_run", {
          result: "done",
          summary: "three new issues",
        }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage([fauxText("three new issues")]),
  ]);

  await page.goto(`${server.url.href}#plugin/routines/new`);
  await page.getByRole("button", { name: "Issue to pull request" }).click();

  expect(await page.getByLabel("Name").inputValue()).toBe(
    "issue-to-pull-request",
  );

  expect(await page.getByLabel("Routine JSON").inputValue()).toContain(
    '"event": "git-hosts.issue"',
  );

  await page.getByLabel("Name").fill("daily-issues");

  await page.getByLabel("Routine JSON").fill(
    JSON.stringify({
      title: "Summarise new issues",
      triggers: [{ cron: "0 8 * * 1-5", timeZone: "Europe/Berlin" }],
      run: {
        prompt: "Summarise the new issues.",
        workspace: { kind: "folder", path: root },
      },
    }),
  );

  await page.getByRole("button", { name: "Save" }).click();
  await page.getByRole("heading", { name: "Summarise new issues" }).waitFor();
  await page.getByText(/^Next run /).waitFor();

  await page.getByRole("button", { name: "Run now" }).click();

  const run = page.getByRole("link", { name: /by hand/ });
  await run.getByText("Done").waitFor();
  await run.getByText("three new issues").waitFor();
  await run.click();

  await page
    .locator('#chat li[data-role="assistant"]', { hasText: "three new issues" })
    .waitFor();
}, 30_000);

test("shows a turn as working between steps until Pi finishes it", async () => {
  const { promise: answered, resolve: answer } =
    Promise.withResolvers<undefined>();

  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("bash", { command: "true" })], {
      stopReason: "toolUse",
    }),
    async () => {
      await answered;

      return fauxAssistantMessage([fauxText("all done")]);
    },
  ]);

  await page.goto(server.url.href);

  await page.getByRole("button", { name: "New session" }).click();
  const form = page.locator("form#create");

  await pickWorkspace(form, root);
  await form.getByRole("button", { name: "Start session" }).click();
  await page.locator("#status", { hasText: "idle" }).waitFor();

  await page.locator("#prompt-text").fill("check");
  await page.locator("#prompt-text").press("Enter");

  const work = page.locator('#chat li[data-role="work"]');
  await work.getByText("ran 1 command").waitFor();
  await Bun.sleep(300);

  expect(await work.locator("summary").first().textContent()).toContain(
    "Working",
  );

  answer(undefined);
  await work.getByText(/^Worked for/).waitFor();
}, 30_000);

test("folds a working turn to one line, and opens every step when the chat is set to Verbose", async () => {
  const { promise: answered, resolve: answer } =
    Promise.withResolvers<undefined>();

  faux.setResponses([
    fauxAssistantMessage(
      [fauxToolCall("bash", { command: "echo from-the-step" })],
      { stopReason: "toolUse" },
    ),
    async () => {
      await answered;

      return fauxAssistantMessage([fauxText("all done")]);
    },
  ]);

  await page.goto(server.url.href);

  await page.getByRole("button", { name: "New session" }).click();
  const form = page.locator("form#create");

  await pickWorkspace(form, root);
  await form.getByRole("button", { name: "Start session" }).click();
  await page.locator("#status", { hasText: "idle" }).waitFor();
  const sessionUrl = page.url();

  await page.locator("#prompt-text").fill("check");
  await page.locator("#prompt-text").press("Enter");

  const work = page.locator('#chat li[data-role="work"]');
  await work.getByText("ran 1 command").waitFor();

  expect(await work.locator("details[open]").count()).toBe(0);

  answer(undefined);
  await work.getByText(/^Worked for/).waitFor();

  await openSettings("General");

  await page
    .getByRole("group", { name: "Tool activity" })
    .getByRole("button", { name: "Verbose" })
    .click();

  await page.goto(sessionUrl);

  await work.getByText("from-the-step").first().waitFor();

  await openSettings("General");

  await page
    .getByRole("group", { name: "Tool activity" })
    .getByRole("button", { name: "Quiet" })
    .click();
}, 30_000);

test("creates a Project and shares a file through its library", async () => {
  const repository = join(root, "site");
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", repository]);
  await writeFile(join(repository, "README.md"), "site\n");
  execFileSync("git", ["add", "."], { cwd: repository });

  execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "first"],
    { cwd: repository },
  );

  await page.goto(server.url.href);

  await page
    .locator("#plugin-nav")
    .getByRole("link", { name: "Projects" })
    .click();

  const form = page.locator("form.project-create");
  await form.getByLabel("Name").fill("Site");
  await form.getByLabel("Goal").fill("Publish the docs site.");
  await form.getByRole("button", { name: "Repositories" }).click();
  const search = form.getByRole("combobox", { name: "Repositories" });
  await search.fill(repository);
  await form.getByRole("option", { name: `Use ${repository}` }).click();
  await search.press("Escape");
  await form.getByRole("button", { name: "Create Project" }).click();
  await page.getByRole("heading", { level: 1, name: "Site" }).waitFor();
  const rail = page.getByRole("navigation", { name: "Threads" });
  await rail.getByText("No threads yet.").waitFor();

  await page.getByRole("button", { name: "Project settings" }).click();

  const settings = page.getByRole("complementary", {
    name: "Project settings",
  });

  expect(await settings.getByLabel("Goal").inputValue()).toBe(
    "Publish the docs site.",
  );

  await settings.getByLabel("Name").fill("Site docs");
  await settings.getByLabel("Thread model").fill("faux/faux-1");
  await settings.getByRole("button", { name: "Save settings" }).click();

  await page
    .getByRole("heading", { level: 1, name: "Site docs" })
    .waitFor({ timeout: 1000 });

  expect(await settings.getByLabel("Thread model").inputValue()).toBe(
    "faux/faux-1",
  );

  await settings.getByRole("button", { name: "Close settings" }).click();

  await page
    .locator("#project-nav")
    .getByRole("link", { name: /^Site/ })
    .filter({ hasText: "1 repository · coordinator" })
    .waitFor();

  const calls = faux.state.callCount;

  faux.setResponses([
    fauxAssistantMessage(
      [fauxToolCall("start_thread", { title: "Docs", message: "write docs" })],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage([fauxText("ok")]),
    fauxAssistantMessage([fauxText("ok")]),
    fauxAssistantMessage([fauxText("noted")]),
  ]);

  await page.locator("#prompt-text").fill("start a docs thread");
  await page.locator("#prompt-text").press("Enter");

  await page
    .locator('#chat li[data-role="assistant"]')
    .getByText(/^(ok|noted)$/)
    .first()
    .waitFor();

  const card = page.locator('#chat [aria-label="Thread Docs"]');
  await card.getByRole("link", { name: "Open Docs fullscreen" }).waitFor();
  expect(await page.locator("#chat").getByText("start_thread").count()).toBe(0);

  const row = rail.getByRole("listitem", { name: "Docs" });
  await row.getByText(/^e2e · /).waitFor();
  await row.getByRole("button", { name: "Actions for Docs" }).click();

  await page.getByRole("menuitemradio", { name: "Ready for review" }).click();

  const review = rail
    .getByRole("region", { name: "Review" })
    .getByRole("listitem", { name: "Docs" });

  await review.waitFor();
  expect(await rail.getByRole("region", { name: "Needs you" }).count()).toBe(0);

  // The thread's reply wakes the coordinator, and both take scripted replies
  // that later tests would otherwise lose to them.
  await review.getByRole("link").click();

  const side = page.getByRole("complementary", { name: "Docs" });
  await side.locator('li[data-role="assistant"]').getByText(/^ok$/).waitFor();

  expect(
    await page
      .locator("#project-nav")
      .getByRole("link", { name: /^Site docs/ })
      .getAttribute("aria-current"),
  ).toBe("page");

  const threadId = new URL(page.url()).hash.split("/").at(-1) ?? "";

  expect(
    await page.locator(`#sessions li[data-id="${threadId}"]`).count(),
  ).toBe(0);

  await page.goto(server.url.href);
  await page.goto(`${server.url.href}#${threadId}`);
  await side.waitFor();
  expect(new URL(page.url()).hash).toEndWith(`/${threadId}`);

  await side.getByRole("button", { name: "Open fullscreen" }).click();
  await page.getByRole("heading", { level: 1, name: /Docs$/ }).waitFor();
  await side.waitFor({ state: "detached" });

  await page
    .getByRole("button", { name: "Show beside the coordinator" })
    .click();

  await side.getByRole("button", { name: "Back to threads" }).click();
  await side.waitFor({ state: "detached" });
  await rail.getByRole("listitem", { name: "Docs" }).waitFor();
  await page.setViewportSize({ width: 390, height: 780 });
  await rail.getByRole("listitem", { name: "Docs" }).getByRole("link").click();
  await side.waitFor();
  await side.getByRole("button", { name: "Back to threads" }).click();
  await rail.getByRole("button", { name: "Hide threads" }).click();
  await page.setViewportSize({ width: 1280, height: 720 });

  while (faux.state.callCount < calls + 4) {
    await Bun.sleep(20);
  }

  await page
    .locator('#chat li[data-role="notice"]')
    .getByRole("link", { name: "Docs" })
    .first()
    .waitFor();

  expect(
    await page
      .locator('#chat li[data-role="user"]')
      .filter({ hasText: "[Project notice]" })
      .count(),
  ).toBe(0);

  faux.setResponses([
    fauxAssistantMessage([fauxText(`See [Docs](thread:${threadId}).`)]),
  ]);

  await page.locator("#prompt-text").fill("where are the docs?");
  await page.locator("#prompt-text").press("Enter");

  const chip = page
    .locator('#chat li[data-role="assistant"]')
    .getByRole("link", { name: /^Docs/ });

  await chip.getByText("Ready for review").waitFor();
  await chip.click();
  await side.waitFor();
  await side.getByRole("button", { name: "Back to threads" }).click();

  const pluginNav = page.locator("#plugin-nav");

  await pluginNav.getByRole("button", { name: "More" }).click();
  await pluginNav.getByRole("link", { name: "Library" }).click();

  await page.getByText("No files yet.").waitFor();

  await page.getByLabel("Upload files").setInputFiles({
    name: "brief.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("the brief\n"),
  });

  await page.getByRole("link", { name: "brief.txt" }).waitFor();
  await page.getByText(/user:\S+ wrote brief\.txt \(10 bytes\)$/).waitFor();

  const nav = page.locator("#project-nav").getByRole("link", { name: /^Site/ });
  await nav.click();
  await page.getByRole("button", { name: "Session actions" }).click();
  await page.getByRole("menuitem", { name: "Archive" }).click();
  await page.locator("#status", { hasText: "archived" }).waitFor();
  await nav.waitFor({ state: "detached" });

  await rail
    .getByRole("listitem", { name: "Docs" })
    .getByText(/^Archived · /)
    .waitFor();

  await page
    .locator("#plugin-nav")
    .getByRole("link", { name: "Projects" })
    .click();

  await page
    .locator("section", {
      has: page.getByRole("heading", { name: "Archived" }),
    })
    .getByRole("button", { name: /^Site docs/ })
    .click();

  await page.getByRole("button", { name: "Project settings" }).click();
  await settings.getByRole("button", { name: "Unarchive Project" }).click();
  await nav.waitFor();

  await rail
    .getByRole("listitem", { name: "Docs" })
    .getByText(/^Archived · /)
    .waitFor({ state: "detached" });

  page.once("dialog", async (dialog) => dialog.accept());
  await settings.getByRole("button", { name: "Archive Project" }).click();
  await nav.waitFor({ state: "detached" });
}, 30_000);

test("shows a Project made elsewhere on the open Projects page", async () => {
  let made = false;
  const { promise: listed, resolve: list } = Promise.withResolvers();

  await page.route("**/api/plugins/projects/projects", async (route) =>
    route.fulfill({
      json: made
        ? [
            {
              id: "elsewhere",
              name: "Made elsewhere",
              threads: 0,
              needsYou: 0,
              repositories: 1,
              coordinatorState: "idle",
            },
          ]
        : [],
    }),
  );

  await page.route("**/api/changes", async (route) => {
    await listed;
    made = true;

    await route.fulfill({
      contentType: "text/event-stream",
      body: `retry: 60000\ndata: ${JSON.stringify({ topic: "projects.projects" })}\n\n`,
    });
  });

  await page.goto(server.url.href);

  await page
    .locator("#plugin-nav")
    .getByRole("link", { name: "Projects" })
    .click();

  const pluginPage = page.locator("#plugin-page");
  await pluginPage.getByText("No Projects yet.").waitFor();
  list(undefined);

  await pluginPage
    .getByRole("button", { name: /^Made elsewhere/ })
    .waitFor({ timeout: 2000 });

  await page.unroute("**/api/changes");
  await page.unroute("**/api/plugins/projects/projects");
});

test("shows a plugin page's failure without taking the app down", async () => {
  await page.route("**/api/plugins/projects/projects", async (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({
        error: "internal",
        message: "projects store is unreadable",
      }),
    }),
  );

  await page.goto(server.url.href);

  await page
    .locator("#plugin-nav")
    .getByRole("link", { name: "Projects" })
    .click();

  const pluginPage = page.locator("#plugin-page");

  await pluginPage
    .getByRole("alert")
    .filter({ hasText: "projects store is unreadable" })
    .waitFor();

  await page
    .locator("#plugin-nav")
    .getByRole("alert")
    .filter({ hasText: "projects store is unreadable" })
    .waitFor();

  await page.unroute("**/api/plugins/projects/projects");
  await pluginPage.getByRole("button", { name: "Try again" }).click();
  await page.getByRole("heading", { name: "New Project" }).waitFor();
  await page.getByRole("button", { name: "New session" }).waitFor();
});

test("keeps a plugin's newest list when an older load answers last", async () => {
  const projects = (name: string): object[] => [
    {
      id: name,
      name,
      needsYou: 0,
      repositories: 1,
      coordinatorState: "idle",
    },
  ];

  const loads: Route[] = [];
  const { promise: watching, resolve: watched } = Promise.withResolvers();

  await page.route("**/api/plugins/projects/projects", async (route) => {
    loads.push(route);
    watched(undefined);

    if (loads.length === 2) {
      await route.fulfill({ json: projects("Newer") });
    }
  });

  // One change arrives while the list's first load is still on its way.
  await page.route("**/api/changes", async (route) => {
    await watching;

    await route.fulfill({
      contentType: "text/event-stream",
      body: `retry: 60000\ndata: ${JSON.stringify({ topic: "sessions" })}\n\n`,
    });
  });

  await page.goto(server.url.href);

  const nav = page.locator("#project-nav");
  await nav.getByRole("link", { name: /^Newer/ }).waitFor();
  await loads[0]?.fulfill({ json: projects("Older") });
  await page.waitForTimeout(500);

  const shown = await nav.getByRole("link").allTextContents();

  expect(shown.map((text) => text.split("1 repository")[0])).toEqual(["Newer"]);

  await page.unroute("**/api/changes");
  await page.unroute("**/api/plugins/projects/projects");
});

test("attaches an image to a message and shows it in the chat", async () => {
  faux.setResponses([fauxAssistantMessage([fauxText("a tiny pixel")])]);
  await page.goto(server.url.href);

  await page.getByRole("button", { name: "New session" }).click();
  const form = page.locator("form#create");

  await pickWorkspace(form, root);
  await form.getByRole("button", { name: "Start session" }).click();
  await page.locator("#status", { hasText: "idle" }).waitFor();

  await page.getByLabel("Attach images").setInputFiles({
    name: "pixel.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      "base64",
    ),
  });

  await page.getByRole("img", { name: "pixel.png" }).waitFor();
  await page.locator("#prompt-text").fill("what is this?");
  await page.locator("#prompt-text").press("Enter");

  await page
    .locator('#chat li[data-role="assistant"]', { hasText: "a tiny pixel" })
    .waitFor();

  expect(await page.getByRole("img", { name: "pixel.png" }).count()).toBe(0);

  await page.reload();

  await page
    .locator('#chat li[data-role="user"]', { hasText: "what is this?" })
    .getByRole("img", { name: "Image 1 sent with this message" })
    .waitFor();
}, 30_000);

test("picks a slash command from the composer's menu", async () => {
  await mkdir(join(root, ".pi", "prompts"), { recursive: true });

  await writeFile(
    join(root, ".pi", "prompts", "review.md"),
    "---\ndescription: Review the diff\n---\nReview the current diff.\n",
  );

  faux.setResponses([fauxAssistantMessage([fauxText("reviewed")])]);
  await page.goto(server.url.href);

  await page.getByRole("button", { name: "New session" }).click();
  const form = page.locator("form#create");

  await pickWorkspace(form, root);
  await form.getByRole("button", { name: "Start session" }).click();
  await page.locator("#status", { hasText: "idle" }).waitFor();
  await trustRepository();

  const box = page.locator("#prompt-text");
  await box.pressSequentially("/rev");

  await page
    .getByRole("listbox", { name: "Commands" })
    .getByRole("option", { name: /\/review\s+Review the diff/ })
    .click();

  expect(await box.inputValue()).toBe("/review ");
  await box.press("Enter");

  await page
    .locator('#chat li[data-role="user"]', {
      hasText: "Review the current diff.",
    })
    .waitFor();
}, 30_000);

test("mentions a workspace file from the composer's menu", async () => {
  const project = join(root, "mentions");
  execFileSync("git", ["init", "--quiet", project]);
  await writeFile(join(project, "mention-target.md"), "notes\n");
  faux.setResponses([fauxAssistantMessage([fauxText("read it")])]);
  await page.goto(server.url.href);

  await page.getByRole("button", { name: "New session" }).click();
  const form = page.locator("form#create");

  await pickWorkspace(form, project);
  await form.getByRole("button", { name: "Start session" }).click();
  await page.locator("#status", { hasText: "idle" }).waitFor();

  const box = page.locator("#prompt-text");
  await box.pressSequentially("summarize @mention-ta");

  await page
    .getByRole("listbox", { name: "Files" })
    .getByRole("option", { name: "@mention-target.md" })
    .click();

  expect(await box.inputValue()).toBe("summarize @mention-target.md ");
  await box.press("Enter");

  await page
    .locator('#chat li[data-role="user"]', {
      hasText: "summarize @mention-target.md",
    })
    .waitFor();
}, 30_000);

test("creates a pull request from the Changes panel", async () => {
  const project = join(root, "widgets");
  const remote = join(root, "widgets.git");
  const bin = join(root, "bin");
  const github = "https://github.com/acme/widgets.git";

  const git = (...args: string[]): string =>
    execFileSync("git", args, { cwd: project, encoding: "utf8" });

  execFileSync("git", ["init", "--quiet", "--bare", remote]);
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", project]);
  await writeFile(join(project, "README.md"), "widgets\n");
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "first");
  git("config", `url.${remote}.insteadOf`, github);
  git("remote", "add", "origin", github);
  git("push", "--quiet", "origin", "main");

  await mkdir(bin);

  await writeFile(
    join(bin, "gh"),
    "#!/bin/sh\necho https://github.com/acme/widgets/pull/12\n",
    { mode: 0o755 },
  );

  const saved = { ...process.env };

  Object.assign(process.env, {
    PATH: `${bin}:${saved["PATH"] ?? ""}`,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  });

  try {
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("write", { path: "widget.ts", content: "export {};\n" }),
      ]),
      fauxAssistantMessage([fauxText("added the widget")]),
      fauxAssistantMessage([fauxText("Add a widget\n\nStarts the module.")]),
    ]);

    await page.goto(server.url.href);
    await page.getByRole("button", { name: "New session" }).click();
    const form = page.locator("form#create");

    await pickWorkspace(form, project, false);
    await form.getByRole("button", { name: "Start session" }).click();
    await page.locator("#status", { hasText: "idle" }).waitFor();

    await page.locator("#prompt-text").fill("add a widget");
    await page.locator("#prompt-text").press("Enter");

    await page.getByRole("button", { name: "Diff, 1 file changed" }).click();
    const changes = page.getByRole("dialog", { name: "Changes" });
    await changes.getByText("Changes (1 file)").waitFor();

    await changes
      .getByRole("button", { name: "More ways to create a PR" })
      .click();

    await changes.getByRole("menuitem", { name: "Create draft PR" }).waitFor();
    await page.keyboard.press("Escape");

    await changes
      .getByRole("button", { name: "Create PR", exact: true })
      .click();

    const view = changes.getByRole("link", { name: "View PR" });
    await view.waitFor();

    expect(await view.getAttribute("href")).toBe(
      "https://github.com/acme/widgets/pull/12",
    );

    const branch = execFileSync(
      "git",
      ["for-each-ref", "--format=%(refname:short) %(subject)", "refs/heads"],
      { cwd: remote, encoding: "utf8" },
    );

    expect(branch).toContain("Add a widget");
  } finally {
    process.env = saved;
  }
}, 30_000);

test("follows the system theme until a theme is picked, and keeps the pick", async () => {
  const theme = async (): Promise<string | null> =>
    page.locator("html").getAttribute("data-theme");

  await page.emulateMedia({ colorScheme: "light" });
  await page.goto(server.url.href);
  expect(await theme()).toBe("light");

  await page.emulateMedia({ colorScheme: "dark" });

  await page.locator('html[data-theme="dark"]').waitFor({ state: "attached" });

  await page.getByRole("button", { name: /^Theme: system/ }).click();
  expect(await theme()).toBe("light");
  await page.reload();
  expect(await theme()).toBe("light");

  await page.getByRole("button", { name: /^Theme: light/ }).click();
  await page.getByRole("button", { name: /^Theme: dark/ }).click();
  await page.getByRole("button", { name: /^Theme: system/ }).waitFor();
  expect(await theme()).toBe("dark");
});

test("queues a message while Pi works, takes one back and sends one now", async () => {
  let release = (): void => undefined;

  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  faux.setResponses([
    async () => {
      await gate;

      return fauxAssistantMessage([fauxText("finally done")]);
    },
  ]);

  await page.goto(server.url.href);
  await page.getByRole("button", { name: "New session" }).click();
  const form = page.locator("form#create");

  await pickWorkspace(form, root);
  await form.getByRole("button", { name: "Start session" }).click();
  await page.locator("#status", { hasText: "idle" }).waitFor();

  const box = page.locator("#prompt-text");
  await box.fill("start");
  await box.press("Enter");
  await page.locator("#status", { hasText: "running" }).waitFor();

  await page.getByText("Enter queues").waitFor();
  await box.fill("not yet");
  await box.press("Enter");
  const takeBack = page.getByRole("button", { name: 'Take back "not yet"' });
  await takeBack.click();
  await takeBack.waitFor({ state: "detached" });
  expect(await box.inputValue()).toBe("not yet");

  await box.fill("right away");
  await box.press("Enter");
  await page.getByRole("button", { name: 'Send "right away" now' }).click();

  await page
    .locator("p", { hasText: "right away" })
    .getByText("Steering")
    .waitFor();

  release();

  await page
    .locator('#chat li[data-role="assistant"]', { hasText: "finally done" })
    .waitFor();
}, 30_000);

test("sends comments on diff lines to Pi as one message", async () => {
  const project = join(root, "review");
  execFileSync("git", ["init", "--quiet", project]);
  await writeFile(join(project, "notes.txt"), "old notes\n");
  execFileSync("git", ["add", "."], { cwd: project });

  execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "first"],
    { cwd: project },
  );

  faux.setResponses([
    fauxAssistantMessage([
      fauxToolCall("write", { path: "notes.txt", content: "new notes\n" }),
    ]),
    fauxAssistantMessage([fauxText("rewrote them")]),
    fauxAssistantMessage([fauxText("will fix")]),
  ]);

  await page.goto(server.url.href);
  await page.getByRole("button", { name: "New session" }).click();
  const form = page.locator("form#create");

  await pickWorkspace(form, project);
  await form.getByRole("button", { name: "Start session" }).click();
  await page.locator("#status", { hasText: "idle" }).waitFor();

  await page.locator("#prompt-text").fill("rewrite the notes");
  await page.locator("#prompt-text").press("Enter");

  await page.getByRole("button", { name: "Diff, 1 file changed" }).click();
  const changes = page.getByRole("dialog", { name: "Changes" });
  await changes.getByText("Changes (1 file)").waitFor();

  await changes
    .getByRole("button", { name: "Comment on notes.txt line 1" })
    .click();

  const comment = changes.getByRole("textbox", {
    name: "Comment on notes.txt line 1",
  });

  await comment.fill("keep the old wording");
  await comment.press("Enter");
  await changes.getByText("1 comment on the diff").waitFor();
  await changes.getByRole("button", { name: "Send to Pi" }).click();

  await page
    .locator('#chat li[data-role="user"]', {
      hasText: "notes.txt:1`: keep the old wording",
    })
    .waitFor();

  await page
    .locator('#chat li[data-role="assistant"]', { hasText: "will fix" })
    .waitFor();

  await changes
    .getByText("1 comment on the diff")
    .waitFor({ state: "detached" });
}, 30_000);

test("keeps the closed sessions drawer out of reach on a phone", async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(server.url.href);

  const newSession = page.getByRole("button", { name: "New session" });
  await page.getByRole("button", { name: "Open sessions" }).click();
  await newSession.waitFor();

  await page.getByRole("link", { name: "Projects" }).click();
  await newSession.waitFor({ state: "hidden" });

  expect(await newSession.count()).toBe(0);

  await page.setViewportSize({ width: 1280, height: 720 });
});

test("moves focus into the sessions drawer, closes it with Escape and gives focus back", async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(server.url.href);

  const menu = page.getByRole("button", { name: "Open sessions" });
  const newSession = page.getByRole("button", { name: "New session" });
  await menu.click();
  await newSession.waitFor();

  expect(await page.locator("aside :focus").count()).toBe(1);

  await page.keyboard.press("Escape");
  await newSession.waitFor({ state: "hidden" });

  expect(await page.locator(":focus").getAttribute("aria-label")).toBe(
    "Open sessions",
  );

  await page.setViewportSize({ width: 1280, height: 720 });
});

test("opens the sessions drawer without sliding when motion is reduced", async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(server.url.href);

  await page.getByRole("button", { name: "Open sessions" }).click();

  expect((await page.locator("aside").boundingBox())?.x).toBe(0);

  await page.emulateMedia({ reducedMotion: null });
  await page.setViewportSize({ width: 1280, height: 720 });
});

test("switches a session's model and reasoning level from the composer", async () => {
  await page.goto(server.url.href);
  await page.getByRole("button", { name: "New session" }).click();
  const form = page.locator("form#create");

  await pickWorkspace(form, root);
  await form.getByRole("button", { name: "Start session" }).click();
  await page.locator("#status", { hasText: "idle" }).waitFor();

  const composer = page.locator("form#prompt");
  const model = composer.getByRole("button", { name: "Model" });
  const reasoning = composer.getByRole("slider", { name: "Reasoning" });

  await model.filter({ hasText: "faux-1" }).waitFor();
  await model.click();
  expect(await reasoning.count()).toBe(0);

  await composer
    .getByRole("option", { name: "faux-deep", exact: true })
    .click();

  await model.click();
  await composer.getByTitle("high", { exact: true }).click();
  await reasoning.press("ArrowLeft");
  await reasoning.press("ArrowRight");
  await model.filter({ hasText: "faux-deep · high" }).waitFor();

  let asked: { model: string; reasoning: unknown } | undefined;

  faux.setResponses([
    (_context, options, _state, used) => {
      asked = { model: used.id, reasoning: options?.reasoning };

      return fauxAssistantMessage([fauxText("thought hard")]);
    },
  ]);

  await page.locator("#prompt-text").fill("think");
  await page.locator("#prompt-text").press("Enter");

  await page
    .locator('#chat li[data-role="assistant"]', { hasText: "thought hard" })
    .waitFor();

  expect(asked).toEqual({ model: "faux-deep", reasoning: "high" });
}, 30_000);

test("folds other providers' models away in the composer's model menu, and keeps recent ones on top", async () => {
  await page.goto(server.url.href);
  await page.getByRole("button", { name: "New session" }).click();
  const form = page.locator("form#create");

  await pickWorkspace(form, root);
  await form.getByRole("button", { name: "Start session" }).click();
  await page.locator("#status", { hasText: "idle" }).waitFor();

  const composer = page.locator("form#prompt");
  const model = composer.getByRole("button", { name: "Model" });
  const search = composer.getByRole("combobox", { name: "Model" });

  const option = (name: string) =>
    composer.getByRole("option", { name, exact: true });

  await model.filter({ hasText: "faux-1" }).waitFor();
  await model.click();

  await option("faux-deep").waitFor();
  expect(await option("wide-1").count()).toBe(0);
  expect(await option("wide (8)").getAttribute("aria-expanded")).toBe("false");

  await search.fill("wide 3");

  expect(await composer.getByRole("option").allTextContents()).toEqual([
    "wide-3",
  ]);

  await search.fill("");
  await option("wide (8)").click();
  await option("wide-2").click();
  await model.filter({ hasText: "wide-2" }).waitFor();

  await model.click();

  const options = composer.getByRole("option");

  expect(await options.first().getAttribute("aria-label")).toMatch(/^Recent/);
  expect(await options.nth(1).textContent()).toBe("wide-2wide");
  expect(await option("faux (2)").getAttribute("aria-expanded")).toBe("false");

  await page.keyboard.press("Escape");
}, 30_000);

test("starts a session at the reasoning level picked in the New session form", async () => {
  await page.goto(server.url.href);
  await page.getByRole("button", { name: "New session" }).click();
  const form = page.locator("form#create");

  await pickWorkspace(form, root);
  await form.getByRole("button", { name: "Model" }).click();
  await form.getByRole("combobox", { name: "Model" }).fill("faux/faux-deep");
  await form.getByRole("combobox", { name: "Model" }).press("Enter");
  await form.getByRole("button", { name: "Model" }).click();
  await form.getByTitle("high", { exact: true }).click();
  await form.getByRole("button", { name: "Start session" }).click();
  await page.locator("#status", { hasText: "idle" }).waitFor();

  const composer = page.locator("form#prompt");

  await composer
    .getByRole("button", { name: "Model" })
    .filter({ hasText: "faux-deep · high" })
    .waitFor();
}, 30_000);

test("runs Pi's built-in commands from the composer", async () => {
  await page.goto(server.url.href);
  await page.getByRole("button", { name: "New session" }).click();
  const form = page.locator("form#create");

  await pickWorkspace(form, root);
  await form.getByRole("button", { name: "Start session" }).click();
  await page.locator("#status", { hasText: "idle" }).waitFor();

  const box = page.locator("#prompt-text");

  await box.fill("/");
  await page.getByRole("option", { name: /\/session/ }).waitFor();

  await box.fill("/name Release prep");
  await box.press("Enter");
  await page.getByRole("heading", { name: "Release prep" }).waitFor();

  await box.fill("/session");
  await box.press("Enter");
  expect(await box.inputValue()).toBe("/session ");
  await box.press("Enter");

  await page
    .locator("#chat", { hasText: "0 user and 0 assistant messages" })
    .waitFor();

  expect(await page.locator('#chat li[data-role="user"]').count()).toBe(0);
}, 30_000);

test("logs in to a provider from the model menu", async () => {
  await page.goto(server.url.href);
  await page.getByRole("button", { name: "New session" }).click();
  const form = page.locator("form#create");

  await pickWorkspace(form, root);
  await form.getByRole("button", { name: "Start session" }).click();
  await page.locator("#status", { hasText: "idle" }).waitFor();

  const composer = page.locator("form#prompt");

  await composer.getByRole("button", { name: "Model" }).click();
  await composer.getByRole("button", { name: "Log in to a provider…" }).click();
  await page.getByRole("button", { name: "Sign in with an API key" }).click();
  await page.getByRole("button", { name: "OpenAI", exact: true }).click();
  await page.locator("input[type=password]").fill("sk-e2e");
  await page.getByRole("button", { name: "Submit" }).click();

  await page
    .locator("#chat", { hasText: "Saved the API key for OpenAI." })
    .waitFor();

  await composer.getByRole("button", { name: "Model" }).click();
  await composer.getByText("openai", { exact: true }).waitFor();
  await page.keyboard.press("Escape");

  const box = page.locator("#prompt-text");

  await box.fill("/logout openai");
  await box.press("Enter");
  await page.locator("#chat", { hasText: "Logged out of OpenAI." }).waitFor();
}, 30_000);

test("draws an extension's widget and footer as Pi's TUI does, at the composer's width", async () => {
  const folder = join(root, "focus");
  await mkdir(join(folder, ".pi", "extensions"), { recursive: true });

  await writeFile(
    join(folder, ".pi", "extensions", "focus.ts"),
    `export default (pi) => {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setStatus("plan", "planning");
    ctx.ui.setWidget("focus", (tui, theme) => ({
      render: (width) => [theme.bold("FOCUS"), theme.fg("accent", "=".repeat(width))],
      invalidate: () => {},
    }));
    ctx.ui.setFooter((tui, theme, footer) => ({
      render: () => ["status: " + [...footer.getExtensionStatuses().values()].join(" ")],
      invalidate: () => {},
    }));
  });
};
`,
  );

  await page.goto(server.url.href);
  await page.getByRole("button", { name: "New session" }).click();
  const form = page.locator("form#create");

  await pickWorkspace(form, folder);
  await form.getByRole("button", { name: "Start session" }).click();
  await page.locator("#status", { hasText: "idle" }).waitFor();
  await trustRepository();

  await page.locator("footer", { hasText: "status: planning" }).waitFor();

  const widget = page.locator("pre", { hasText: "FOCUS" });
  const focus = widget.locator("span", { hasText: "FOCUS" });
  const rule = widget.locator("span", { hasText: "===" });

  expect(await focus.getAttribute("style")).toContain("font-weight: bold");

  // The rule is as wide as the host was told, so it fills the widget.
  const filled = async (): Promise<number> => {
    const [box, line] = await Promise.all([
      widget.boundingBox(),
      rule.boundingBox(),
    ]);

    return (line?.width ?? 0) / (box?.width ?? 1);
  };

  const columns = async (): Promise<number> =>
    (await rule.textContent())?.length ?? 0;

  const settled = async (): Promise<number> => {
    let last = -1;

    for (;;) {
      await Bun.sleep(500);
      const now = await columns();

      if (now === last) {
        return now;
      }

      last = now;
    }
  };

  const wide = await settled();
  expect(await filled()).toBeGreaterThan(0.85);
  expect(await filled()).toBeLessThanOrEqual(1);

  await page.setViewportSize({ width: 700, height: 800 });

  expect(await settled()).toBeLessThan(wide);
  expect(await filled()).toBeGreaterThan(0.85);
  expect(await filled()).toBeLessThanOrEqual(1);

  // The widgets mount after the chat scrolls to its end, and still leave the
  // last reply in view.
  faux.setResponses([
    fauxAssistantMessage([fauxText(Array(40).fill("line").join("\n\n"))]),
  ]);

  await page.locator("#prompt-text").fill("talk a lot");
  await page.locator("#prompt-text").press("Enter");
  await page.locator("#status", { hasText: "idle" }).waitFor();
  await page.reload();
  await page.locator("footer", { hasText: "status: planning" }).waitFor();
  await Bun.sleep(500);

  expect(
    await page.evaluate(
      "(() => { const box = document.querySelector('#chat').parentElement; return box.scrollHeight - box.scrollTop - box.clientHeight; })()",
    ),
  ).toBeLessThan(2);

  await page.setViewportSize({ width: 1280, height: 720 });
}, 30_000);

test("draws a subagent run as a card in the chat, with its fleet in the header", async () => {
  let finish = (): void => undefined;

  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });

  // The parent and its child share the faux model: the child is the one
  // without the subagent tool. It lists the folder, then waits to answer.
  const script = [
    fauxAssistantMessage(
      [fauxToolCall("subagent", { agent: "worker", task: "Check the tests" })],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage([fauxText("Started a worker")]),
  ];

  const answer: FauxResponseFactory = async (context) => {
    const tools = context.messages.flatMap((m) =>
      m.role === "system" ? (m.toolsAdded ?? []).map(({ name }) => name) : [],
    );

    if (tools.includes("subagent")) {
      return script.shift() ?? fauxAssistantMessage([fauxText("Thanks")]);
    }

    if (!context.messages.some((m) => m.role === "toolResult")) {
      return fauxAssistantMessage([fauxToolCall("ls", { path: "." })], {
        stopReason: "toolUse",
      });
    }

    await finished;

    return fauxAssistantMessage([fauxText("The tests pass")]);
  };

  faux.setResponses(Array.from({ length: 6 }, () => answer));

  await page.goto(server.url.href);
  await page.getByRole("button", { name: "New session" }).click();
  const form = page.locator("form#create");

  await pickWorkspace(form, root);
  await form.getByRole("button", { name: "Start session" }).click();
  await page.locator("#status", { hasText: "idle" }).waitFor();

  const box = page.locator("#prompt-text");
  await box.fill("check the tests in the background");
  await box.press("Enter");

  const card = page.locator('#chat li[data-role="card"]', {
    hasText: "Check the tests",
  });

  await card.getByText(/Running · 1 tool/).waitFor();
  await card.getByText("faux/faux-1").waitFor();
  await page.getByRole("button", { name: "1 running" }).waitFor();

  await card.getByRole("button", { name: /worker/ }).click();
  await card.getByText("› ls .").waitFor();
  await card.getByRole("button", { name: "Stop" }).waitFor();

  finish();

  await card.getByText(/Done · 1 tool/).waitFor();
  await card.getByText("The tests pass").waitFor();
  await page.getByRole("button", { name: "Subagents" }).waitFor();
  await page.getByText("Subagents finished: worker done").waitFor();

  await page.reload();

  await page
    .locator('#chat li[data-role="card"]', { hasText: "Check the tests" })
    .getByText(/Done · 1 tool/)
    .waitFor();
}, 30_000);

test("pins the agent's checklist above the composer while it has open steps", async () => {
  const folder = join(root, "checklist");
  await mkdir(folder, { recursive: true });

  const update = (statuses: readonly string[]) =>
    fauxAssistantMessage(
      [
        fauxToolCall("update_checklist", {
          items: ["Read the code", "Write the fix", "Run the tests"].map(
            (text, at) => ({ text, status: statuses[at] ?? "pending" }),
          ),
        }),
      ],
      { stopReason: "toolUse" },
    );

  faux.setResponses([
    update(["completed", "in_progress", "pending"]),
    fauxAssistantMessage([fauxText("Working on the fix")]),
  ]);

  await page.goto(server.url.href);
  await page.getByRole("button", { name: "New session" }).click();
  const form = page.locator("form#create");

  await pickWorkspace(form, folder);
  await form.getByRole("button", { name: "Start session" }).click();
  await page.locator("#status", { hasText: "idle" }).waitFor();

  const box = page.locator("#prompt-text");
  await box.fill("fix the bug");
  await box.press("Enter");
  await page.getByText("Working on the fix").waitFor();

  const list = page.getByRole("region", { name: "Checklist" });
  const summary = list.getByRole("button", { name: /Write the fix/ });

  await summary.getByText("1 of 3").waitFor();

  expect(await page.locator("#chat").textContent()).not.toContain(
    "update_checklist",
  );

  await summary.click();
  await list.getByText("Run the tests").waitFor();

  await page.reload();
  await list.getByRole("button", { name: /Write the fix/ }).waitFor();

  faux.setResponses([
    update(["completed", "completed", "completed"]),
    fauxAssistantMessage([fauxText("All fixed")]),
  ]);

  await box.fill("finish it");
  await box.press("Enter");
  await page.getByText("All fixed").waitFor();
  await list.waitFor({ state: "hidden" });
}, 30_000);

test("signs out and back in with the password", async () => {
  await page.goto(server.url.href);
  await page.getByRole("button", { name: "Account" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await page.getByRole("heading", { name: "Sign in" }).waitFor();

  await page.getByLabel("Name").fill("pedro");
  await page.getByLabel("Password").fill("wrong password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("alert").filter({ hasText: "Wrong name" }).waitFor();

  await page.getByLabel("Password").fill("correct horse");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("button", { name: "New session" }).waitFor();
});

test("opens a page the Session opened in a browser through its preview", async () => {
  const app = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request): Response =>
      request.headers.get("host") === `localhost:${String(app.port)}`
        ? new Response("<h1>plan from the app</h1>", {
            headers: { "content-type": "text/html" },
          })
        : new Response("wrong host", { status: 403 }),
  });

  faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall("bash", {
          command: `"$BROWSER" http://localhost:${String(app.port)}/`,
        }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage([fauxText("opened the plan")]),
  ]);

  // Previews live on subdomains, which an IP address doesn't have.
  const site = `http://localhost:${server.url.port}`;
  const context = await browser.newContext();

  await context.request.post(`${site}/api/auth/login`, {
    data: { name: "pedro", password: "correct horse" },
  });

  const [environment] = (await (
    await context.request.get(`${site}/api/environments`)
  ).json()) as { id: string }[];

  const { id } = (await (
    await context.request.post(`${site}/api/sessions`, {
      data: {
        environment: environment?.id,
        workspace: { kind: "folder", path: root },
      },
    })
  ).json()) as { id: string };

  const tab = await context.newPage();
  await tab.goto(`${site}/#${id}`);
  await tab.locator("#status", { hasText: "idle" }).waitFor();
  await tab.locator("#prompt-text").fill("open the plan");
  await tab.locator("#prompt-text").press("Enter");

  const pages = tab.getByRole("list", { name: "Opened pages" });
  await pages.waitFor();

  const [preview] = await Promise.all([
    context.waitForEvent("page"),
    pages.getByRole("link", { name: "Open" }).click(),
  ]);

  await preview.getByRole("heading", { name: "plan from the app" }).waitFor();

  expect(new URL(preview.url()).hostname).toBe(
    `${String(app.port)}--${id}.localhost`,
  );

  await pages.getByRole("button", { name: "Dismiss" }).click();
  await pages.waitFor({ state: "detached" });

  await context.close();
  await app.stop(true);
});

test("opens Settings as its own page, grouped by who each page is for", async () => {
  await page.goto(server.url.href);
  await openSettings("General");

  expect(await page.locator("#plugin-nav").count()).toBe(0);

  const menu = page.getByRole("navigation", { name: "Settings" });

  expect(
    await menu.getByRole("heading", { level: 3 }).allTextContents(),
  ).toEqual(["You", "Workspace", "Server, for admins"]);

  await menu.getByRole("link", { name: "Integrations" }).click();
  await page.getByRole("tab", { name: "Email" }).click();
  await page.getByRole("tab", { name: "Email", selected: true }).waitFor();

  await menu.getByRole("link", { name: "Back to Pipoca" }).click();
  await page.locator("#plugin-nav").waitFor();
});

test("offers push notifications in Settings and shows a pushed notification from the service worker", async () => {
  await openSettings("Notifications");
  await page.getByRole("button", { name: "Turn on for this device" }).waitFor();

  const origin = new URL(server.url).origin;

  const context = await browser.newContext();
  const [name = "", value = ""] = cookie.split("=");
  await context.addCookies([{ name, value, url: origin }]);
  await context.grantPermissions(["notifications"], { origin });

  const tab = await context.newPage();
  await tab.goto(origin);

  const cdp = await context.newCDPSession(tab);

  const registered = new Promise<string>((resolve) => {
    cdp.on("ServiceWorker.workerRegistrationUpdated", ({ registrations }) => {
      const [registration] = registrations.filter(
        ({ scopeURL, isDeleted }) => scopeURL === `${origin}/` && !isDeleted,
      );

      if (registration !== undefined) {
        resolve(registration.registrationId);
      }
    });
  });

  await cdp.send("ServiceWorker.enable");

  const started = context.waitForEvent("serviceworker");

  await tab.evaluate(
    "navigator.serviceWorker.register('/sw.js', { scope: '/' }).then(() => navigator.serviceWorker.ready).then(() => undefined)",
  );

  // Headless Chromium keeps no shown notifications, so the worker's calls
  // are recorded instead.
  const worker = context.serviceWorkers()[0] ?? (await started);

  await worker.evaluate(
    "self.shown = []; self.registration.showNotification = (title, options) => { self.shown.push(title + ': ' + options.body); return Promise.resolve(); }",
  );

  await cdp.send("ServiceWorker.deliverPushMessage", {
    origin,
    registrationId: await registered,
    data: JSON.stringify({
      title: "Pi needs you",
      body: "Fix the login page",
      session: "session-1",
      url: "/#session-1",
    }),
  });

  const shown = async (): Promise<string[]> =>
    worker.evaluate<string[]>("self.shown");

  while ((await shown()).length === 0) {
    await tab.waitForTimeout(50);
  }

  expect(await shown()).toEqual(["Pi needs you: Fix the login page"]);

  await context.close();
}, 30_000);

test("signs in in the browser for the desktop app and hands it a link only it can use", async () => {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const context = await browser.newContext();
  const tab = await context.newPage();
  tab.setDefaultTimeout(10_000);

  await tab.goto(new URL(`/#app/${challenge}`, server.url).href);
  await tab.getByLabel("Name").fill("pedro");
  await tab.getByLabel("Password").fill("correct horse");
  await tab.getByRole("button", { name: "Sign in" }).click();

  await tab
    .getByRole("heading", { name: "Sign in to the Pipoca app" })
    .waitFor();

  const handed = tab.waitForResponse("**/api/auth/app");
  await tab.getByRole("button", { name: "Open Pipoca" }).click();
  const { link } = (await (await handed).json()) as { link: string };
  const token = new URL(link).searchParams.get("link") ?? "";

  await tab.getByRole("heading", { name: "Pipoca is open" }).waitFor();

  const app = new URL(`/api/auth/link/${token}`, server.url);
  app.searchParams.set("verifier", verifier);
  const signedIn = await fetch(app, { redirect: "manual" });

  await tab.goto(server.url.href);
  await tab.getByRole("button", { name: "New session" }).waitFor();

  expect(link.startsWith("pipoca://signed-in?")).toBe(true);
  expect(signedIn.status).toBe(303);

  await context.close();
});

test("opens the team hub from the sidebar and lists team work anyone can pick up", async () => {
  await page.goto(server.url.href);

  // An earlier test signs out and back in, which ends the first cookie.
  const signedIn = (await page.context().cookies()).find(
    ({ name }) => name === "pipoca-session",
  );

  const current = `${signedIn?.name ?? ""}=${signedIn?.value ?? ""}`;

  const post = async (path: string, body: unknown): Promise<unknown> =>
    (
      await fetch(new URL(path, server.url), {
        method: "POST",
        headers: { "content-type": "application/json", cookie: current },
        body: JSON.stringify(body),
      })
    ).json();

  const { environment } = (await post("/api/environments", {
    name: "team-pods",
    team: true,
  })) as { environment: Environment };

  const profile = (await post("/api/profiles", {
    name: "Team work",
    team: true,
  })) as Profile;

  const folder = join(root, "release-notes");

  await mkdir(folder, { recursive: true });

  await post("/api/sessions", {
    team: true,
    environment: environment.id,
    profile: profile.id,
    workspace: { kind: "folder", path: folder },
  });

  await page.goto(server.url.href);
  await page.getByRole("link", { name: "Team", exact: true }).click();

  const running = page.locator("section").filter({ hasText: "Running now" });

  await running.getByRole("link", { name: "release-notes" }).waitFor();

  await page
    .getByRole("navigation", { name: "Team" })
    .getByRole("link", { name: "Sessions" })
    .click();

  await page.getByRole("heading", { name: "Sessions" }).waitFor();
  await page.getByRole("link", { name: "release-notes" }).click();

  expect(new URL(page.url()).hash).not.toContain("team");

  await page.goto(server.url.href);

  const own = page.locator("#sessions");

  await own.waitFor();

  expect(await own.getByText("release-notes").count()).toBe(0);

  const docs = join(root, "team-docs");

  await mkdir(docs, { recursive: true });
  await page.goto(new URL("/#team", server.url).href);
  await page.getByRole("button", { name: "Start team work" }).click();

  const form = page.getByRole("dialog", { name: "Start team work" });

  await form.getByRole("button", { name: "Folder or repository" }).click();

  const search = form.getByRole("combobox", { name: "Folder or repository" });

  await search.fill(docs);
  await form.getByRole("option", { name: `Use ${docs}` }).click();
  await search.press("Escape");
  await form.getByLabel("What should Pi do?").fill("Write the release notes");
  await form.getByRole("button", { name: "Start session" }).click();
  await page.waitForURL((url) => !url.hash.startsWith("#team"));

  await page.getByRole("button", { name: "Session actions" }).click();
  await page.getByRole("menuitem", { name: "Who steers" }).click();

  const access = page.getByRole("dialog", {
    name: "Who steers this team work",
  });

  await access.getByRole("button", { name: "View only" }).click();
  await access.getByRole("button", { name: "Save" }).click();
  await access.waitFor({ state: "hidden" });
  await page.locator("header").getByText("View only").waitFor();

  await page.goto(new URL("/#team/sessions", server.url).href);
  await page.getByRole("link", { name: "team-docs" }).waitFor();
});

test("shows plugin panels on the team hub and lets an admin lay out a page of them", async () => {
  await page.goto(new URL("/#team", server.url).href);

  await page
    .getByRole("region", { name: "Spend this month" })
    .getByText(/you used \$0\.00/)
    .waitFor();

  const nav = page.getByRole("navigation", { name: "Team" });

  await nav.getByRole("button", { name: "Add page" }).click();
  await nav.getByLabel("New page title").fill("Costs");
  await nav.getByLabel("New page title").press("Enter");

  await page.getByRole("heading", { name: "Costs" }).waitFor();

  await page
    .getByText("No panels here yet. Edit the layout to add some.")
    .waitFor();

  await page.getByRole("button", { name: "Edit layout" }).click();
  await page.getByLabel("Add a panel").selectOption("usage/spend");
  await page.getByRole("button", { name: "Done" }).click();

  await page.getByRole("region", { name: "Spend this month" }).waitFor();
  await page.reload();
  await page.getByRole("region", { name: "Spend this month" }).waitFor();

  expect(new URL(page.url()).hash).toBe("#team/page/costs");

  await page.getByRole("button", { name: "Edit layout" }).click();
  await page.getByRole("button", { name: "Remove page" }).click();
  await page.getByRole("heading", { name: "Team home" }).waitFor();

  expect(await nav.getByRole("link", { name: "Costs" }).count()).toBe(0);
});
