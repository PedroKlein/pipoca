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
import { definePlugin } from "@pipoca/plugins";
import type { Environment, Profile, Session } from "@pipoca/protocol";
import { until } from "@pipoca/testing/until";
import { protocolVersion, versionHeader } from "@pipoca/protocol";
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
      description: "Says hi.",
      pipoca: { id: "hello", entry: "plugin.ts" },
    }),
  );

  await mkdir(join(plugins, "greeter", "web"), { recursive: true });

  await writeFile(
    join(plugins, "greeter", "package.json"),
    JSON.stringify({ pipoca: { id: "greeter", entry: "plugin.ts" } }),
  );

  await writeFile(
    join(plugins, "greeter", "plugin.ts"),
    `import { definePlugin } from "@pipoca/plugins";

export const greeter = definePlugin({
  id: "greeter",
  title: "Greeter",
  description: "Counts hellos.",
});
`,
  );

  // Hooks only work when the part shares the page's React.
  await writeFile(
    join(plugins, "greeter", "web", "index.tsx"),
    `import { defineWeb } from "@pipoca/plugins/web";
import { Button } from "@pipoca/ui";
import { useState } from "react";
import { greeter } from "../plugin";

function Page() {
  const [count, setCount] = useState(0);

  return <Button onClick={() => setCount(count + 1)}>Hellos: {count}</Button>;
}

export const web = defineWeb(greeter, {
  pages: [{ path: "", label: "Greeter", Page, nav: {} }],
});
`,
  );

  await mkdir(join(plugins, "faulty", "web"), { recursive: true });

  await writeFile(
    join(plugins, "faulty", "package.json"),
    JSON.stringify({ pipoca: { id: "faulty", entry: "plugin.ts" } }),
  );

  await writeFile(
    join(plugins, "faulty", "plugin.ts"),
    `import { definePlugin } from "@pipoca/plugins";

export const faulty = definePlugin({
  id: "faulty",
  title: "Faulty",
  description: "Throws when it loads.",
});
`,
  );

  await writeFile(
    join(plugins, "faulty", "web", "index.tsx"),
    `throw new Error("faulty on purpose");
`,
  );

  await mkdir(join(plugins, "vault", "web"), { recursive: true });

  await writeFile(
    join(plugins, "vault", "package.json"),
    JSON.stringify({
      description: "Keeps keys.",
      pipoca: { entry: "plugin.ts" },
    }),
  );

  await writeFile(
    join(plugins, "vault", "plugin.ts"),
    `import { Config, definePlugin, Secret, Type } from "@pipoca/plugins";

export const vault = definePlugin({
  id: "vault",
  title: "Vault",
  description: "Keeps keys for other services.",
  config: Config.object({
    greeting: Config.string({ title: "Greeting", default: "Hello" }),
    keys: Config.collection({
      title: "Keys",
      key: "name",
      admin: true,
      item: Type.Object({
        name: Type.String({ title: "Name" }),
        token: Secret({ title: "Token" }),
      }),
    }),
  }),
});
`,
  );

  await writeFile(
    join(plugins, "vault", "web", "index.tsx"),
    `import { defineWeb, Slot, useViewer } from "@pipoca/plugins/web";
import { Page } from "@pipoca/ui";
import { vault } from "../plugin";

function VaultPage({ path }: { readonly path: string }) {
  const { person } = useViewer();

  return (
    <Page title="Vault" description={\`Keys for \${person.name}\`}>
      <p>Open at {path === "" ? "the start" : path}</p>
      <Slot name="settings.general" />
    </Page>
  );
}

function General() {
  return <p>Vault keeps your keys.</p>;
}

export const web = defineWeb(vault, {
  pages: [{ path: "", label: "Vault", Page: VaultPage, nav: { pinned: true } }],
  settings: { group: "server", form: "auto" },
  slots: { "settings.general": General },
});
`,
  );

  const logs: string[] = [];

  server = serve({
    port: 0,
    database: ":memory:",
    configDir: join(root, "config"),
    runners: { pollWaitMs: 100, offlineAfterMs: 1000 },
    agent: {
      provider: "e2e",
      dataDir: join(root, "e2e"),
      extensionPaths: [],
      folders: [root],
      models: { runtime, model: faux.getModel() },
    },
    definitions: [
      definePlugin({ id: "anchor", title: "Anchor", description: "" }),
      definePlugin({
        id: "leaning",
        title: "Leaning",
        description: "",
        requires: ["anchor"],
      }),
    ],
    installed: {
      root: plugins,
      plugins: await installedPlugins(
        plugins,
        () => undefined,
        (id) => id === "faulty" || id === "greeter" || id === "vault",
      ),
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
  await page.getByLabel("Your name").fill("Pedro Klein");
  await page.getByLabel("Username").fill("pedro");
  await page.getByLabel("Password").fill("correct horse");

  // Setup reads the templates once, as it opens.
  await page.route("**/api/environment-templates", podTemplate);

  await page
    .getByRole("button", { name: "Create account and continue" })
    .click();

  await setUpServerAndPerson();

  const [session] = await page.context().cookies();
  cookie = `${session?.name ?? ""}=${session?.value ?? ""}`;
}, 30_000);

const continueButton = (): Locator =>
  page.getByRole("button", { name: "Continue" });

// A template whose runners a plugin starts, such as in a cluster.
async function podTemplate(route: Route): Promise<void> {
  await route.fulfill({
    json: [
      {
        id: "pods",
        name: "Cloud pod",
        isolation: "process",
        image: "runner:1",
        setupScript: "",
        variables: {},
        source: null,
        runnersFrom: {
          plugin: "kubernetes",
          label: "Kubernetes",
          icon: "cloud",
          choice: "A pod for each person",
        },
      },
    ],
  });
}

// The first admin goes through the server's setup, then their own, and
// once the server's is finished Back no longer leads into it.
async function setUpServerAndPerson(): Promise<void> {
  const setup = page.getByRole("banner");

  await page
    .getByRole("heading", { name: "Who is this Pipoca for?" })
    .waitFor();

  await setup.getByText("Server setup").waitFor();
  expect(await setup.getByText("Step 1 of 10").count()).toBe(1);

  expect(
    await page.getByRole("radio", { name: /^A team/, checked: true }).count(),
  ).toBe(1);

  const plugins = page.getByRole("heading", {
    name: "What should this server do?",
  });

  // A server just for its person has no one to sign in or bots to share,
  // so the plugins' steps for teams leave its setup.
  await page.getByRole("radio", { name: /^Just me/ }).check();
  await continueButton().click();
  await plugins.waitFor();
  await setup.getByText("Step 2 of 3").waitFor();
  await page.getByRole("button", { name: "Back" }).click();
  await page.getByRole("radio", { name: /^A team/ }).check();
  await continueButton().click();
  await plugins.waitFor();
  await setup.getByText("Step 2 of 10").waitFor();

  await page.getByRole("list", { name: "Adds a setup step" }).waitFor();
  await continueButton().click();

  // Sign-in names no provider until the admin adds one.
  await page.getByRole("heading", { name: "How people sign in" }).waitFor();

  await page
    .getByRole("list", { name: "Add a provider" })
    .getByRole("button", { name: /Any OpenID provider/ })
    .waitFor();

  await page.getByRole("button", { name: "Skip for now" }).click();

  // Code hosts come after sign-in. No host is added for you, and going on
  // with none is an answer.
  await page
    .getByRole("heading", { name: "Where does the team's code live?" })
    .waitFor();

  expect(await continueButton().isDisabled()).toBe(true);
  await page.getByLabel("Go on with no code host for now").check();
  await continueButton().click();

  await page.getByRole("heading", { name: "Server default Profile" }).waitFor();
  expect(await continueButton().isDisabled()).toBe(true);

  // What team Sessions run with belongs to the team, not to everyone.
  const teamProfiles = page.getByRole("list", { name: "Team Profiles" });

  await teamProfiles.getByRole("button", { name: "Add", exact: true }).click();
  await teamProfiles.getByLabel("Team Profile name").fill("Release");
  await teamProfiles.getByRole("button", { name: "Add", exact: true }).click();
  await teamProfiles.getByText("Release").waitFor();

  const made = (await (
    await page.request.get(new URL("/api/profiles?scope=team", server.url).href)
  ).json()) as Profile[];

  expect(made.map(({ name }) => name)).toContain("Release");

  const row = (name: string): Locator =>
    teamProfiles.getByRole("listitem").filter({ hasText: name });

  await row("Release").getByText("Team default").waitFor();

  await teamProfiles.getByRole("button", { name: "Add", exact: true }).click();
  await teamProfiles.getByLabel("Team Profile name").fill("Docs");
  await teamProfiles.getByRole("button", { name: "Add", exact: true }).click();
  await row("Docs").getByRole("button", { name: "Make default" }).click();
  await row("Docs").getByText("Team default").waitFor();
  await row("Release").getByRole("button", { name: "Make default" }).waitFor();

  await page.getByRole("button", { name: "Skip for now" }).click();

  // No provider is required, and the list has every provider Pi knows plus
  // the ones packages add on the runners, such as the e2e runner's.
  await page.getByRole("heading", { name: "Shared model keys" }).waitFor();
  const shared = page.getByRole("list", { name: "Shared model keys" });
  await shared.getByText("No shared key yet").waitFor();
  expect(await continueButton().isDisabled()).toBe(false);

  await page.getByRole("button", { name: "Add a shared key" }).click();
  await page.getByRole("combobox", { name: "Add a shared key" }).fill("faux");

  await page.getByRole("option", { name: /^faux.*Added by a package/ }).click();

  const key = page.getByRole("form", { name: "Key for faux" });
  await key.getByLabel("faux key").fill("sk-faux-team");
  await key.getByRole("button", { name: "Save key" }).click();
  await key.waitFor({ state: "detached" });

  await shared
    .getByRole("listitem")
    .filter({ hasText: "faux" })
    .getByText("goes to team runners", { exact: false })
    .waitFor();

  await continueButton().click();

  // A template whose runners a plugin starts is offered as the plugin
  // words it, with the template's own name and image.
  await page.getByRole("heading", { name: "Where do Sessions run?" }).waitFor();

  const pod = page
    .getByRole("list", { name: "Where Sessions run" })
    .getByRole("listitem")
    .filter({ hasText: "A pod for each person" });

  await pod.getByText("From plugin: Kubernetes").waitFor();

  const choice = pod.getByRole("checkbox", { name: /^A pod for each person/ });
  await choice.click();

  expect(await pod.getByLabel("Name people see").inputValue()).toBe(
    "Cloud pod",
  );

  expect(await pod.getByLabel("Image").inputValue()).toBe("runner:1");
  await choice.click();
  await pod.getByLabel("Image").waitFor({ state: "detached" });
  await page.unroute("**/api/environment-templates", podTemplate);
  await continueButton().click();

  for (const heading of ["Add a mailbox", "Add a Slack bot"]) {
    await page.getByRole("heading", { name: heading }).waitFor();
    await page.getByRole("button", { name: "Skip for now" }).click();
  }

  const finish = page.getByRole("button", {
    name: "Finish and set up my account",
  });

  await page.getByRole("heading", { name: "What new people get" }).waitFor();
  await finish.click();

  const welcome = page.getByRole("heading", {
    name: "Welcome to your team's Pipoca",
  });

  await welcome.waitFor();
  await setup.getByText("Your setup").waitFor();

  expect(await page.getByRole("button", { name: "Back" }).count()).toBe(0);
  await page.getByText("Server setup is done.").waitFor();

  await page.getByRole("button", { name: "Start" }).click();

  // No git host is listed yet, which isn't done until the person goes on
  // without one.
  await page.getByRole("heading", { name: "Connect your code" }).waitFor();
  await page.getByText("No code host is set up on this server yet").waitFor();
  expect(await continueButton().isDisabled()).toBe(true);
  await page.getByLabel("Go on without a code host").check();
  await continueButton().click();

  // The key shared in server setup gives a model, so that step is done.
  await page.getByRole("heading", { name: "Your models" }).waitFor();

  await page
    .getByRole("list", { name: "Shared by the server" })
    .getByRole("listitem")
    .filter({ hasText: "faux" })
    .getByText("Ready")
    .waitFor();

  await continueButton().click();

  await page.getByRole("heading", { name: "Where should Pi work?" }).waitFor();
  await continueButton().click();

  // Pi's defaults is an answer, so the step finishes with no Skip.
  await page.getByRole("heading", { name: "Make Pi yours" }).waitFor();

  await page
    .getByRole("radio", { name: /^Pi's defaults/, checked: true })
    .waitFor();

  expect(await page.getByRole("button", { name: "Skip for now" }).count()).toBe(
    0,
  );

  await continueButton().click();

  await page.getByRole("heading", { name: "You're set" }).waitFor();
  await page.getByPlaceholder("What should Pi do first?").waitFor();
  await page.getByRole("button", { name: "Go to home" }).click();
  await page.getByRole("button", { name: "New session" }).waitFor();

  // Later tests start with no shared key.
  await page.request.delete(
    new URL("/api/ext/logins/credentials/faux?layer=base", server.url).href,
    { headers: { [versionHeader]: String(protocolVersion) } },
  );
}

// Opens the workspace whose switcher entry matches.
async function switchWorkspace(name: RegExp): Promise<void> {
  await page.getByRole("button", { name: "Switch workspace" }).click();
  await page.getByRole("menuitemradio", { name }).click();
}

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

  // It remembers the last model and reasoning level too, which picking an
  // Environment resets only when the form lists more than one by then.
  const model = form.getByRole("button", { name: "Model" });

  if ((await model.textContent())?.trim() !== "Default model") {
    await model.click();

    await form
      .getByRole("group", { name: "Reasoning" })
      .getByRole("button", { name: "default", exact: true })
      .click();

    await form.getByRole("option", { name: /^Environment default/ }).click();
  }

  await form.getByRole("button", { name: "Folder or repository" }).click();
  const search = form.getByRole("combobox", { name: "Folder or repository" });

  const picked = form
    .getByRole("list", { name: "Picked" })
    .getByRole("button", { name: /^Remove / });

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

test("draws the agent's Mermaid diagrams in chat and shows broken ones as code", async () => {
  let told = false;

  faux.setResponses([
    (context) => {
      told = JSON.stringify(context).includes("```mermaid");

      return fauxAssistantMessage([
        fauxText(
          [
            "How it flows:",
            "```mermaid",
            "graph LR",
            "  browser[Browser] --> server[Server]",
            "```",
            "And one that's wrong:",
            "```mermaid",
            "graph LR",
            "  a -->",
            "```",
          ].join("\n"),
        ),
      ]);
    },
  ]);

  await page.goto(server.url.href);
  await page.getByRole("button", { name: "New session" }).click();
  const form = page.locator("form#create");

  await pickWorkspace(form, root);
  await form.getByRole("button", { name: "Start session" }).click();
  await page.locator("#status", { hasText: "idle" }).waitFor();

  // Mermaid loads on the first diagram, which on a slow link takes a while.
  let release = (): void => undefined;

  const loaded = new Promise<void>((resolve) => {
    release = resolve;
  });

  await page.route("**/*.js", async (route) => {
    await loaded;
    await route.continue();
  });

  await page.locator("#prompt-text").fill("draw it");
  await page.locator("#prompt-text").press("Enter");

  const reply = page.locator('#chat li[data-role="assistant"]');
  await reply.getByText("Drawing the diagram").first().waitFor();
  release();
  await reply.locator("svg", { hasText: "Browser" }).waitFor();
  await reply.getByText("This diagram didn't draw").waitFor();

  expect(told).toBe(true);
  expect(await reply.getByText("Drawing the diagram").count()).toBe(0);
  expect(await reply.locator("svg").count()).toBe(1);
  expect(await reply.locator("pre", { hasText: "a -->" }).count()).toBe(1);
  expect(await reply.locator("pre", { hasText: "Browser" }).count()).toBe(0);
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
  faux.setResponses([fauxAssistantMessage([fauxText("Happy to help")])]);

  await page.goto(server.url.href);

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
    await fetch(new URL("/api/ext/projects/assistant", server.url), {
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
    await page.getByRole("link", { name: "Earlier conversations" }).count(),
  ).toBe(0);

  // Starting fresh keeps the conversation before it reachable.
  await fetch(
    new URL(
      `/api/ext/projects/projects/${projectHash.split("/").at(-1) ?? ""}/fresh`,
      server.url,
    ),
    { method: "POST", headers: { cookie } },
  );

  await page
    .locator("#plugin-nav")
    .getByRole("link", { name: "Earlier conversations" })
    .click();

  await page.getByRole("heading", { name: "Earlier conversations" }).waitFor();
  await page.getByRole("link", { name: /What can you do/ }).click();

  await page
    .locator('#chat li[data-role="assistant"]', { hasText: "Happy to help" })
    .waitFor();

  await page
    .locator("#plugin-page")
    .getByRole("link", { name: "Assistant", exact: true })
    .click();

  await page.waitForURL((url) => url.hash === projectHash);

  // The sidebar's Assistant entry opens the same assistant (ADR 0052).
  await page.goto(server.url.href);

  await page
    .locator("#plugin-nav")
    .getByRole("link", { name: "Assistant", exact: true })
    .click();

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

test("shows a routine the assistant wants to create as a card, which Create allows", async () => {
  faux.setResponses([
    fauxAssistantMessage(
      [fauxToolCall("tool_search", { query: "make a routine" })],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      [
        fauxToolCall("routines", {
          action: "create",
          name: "morning-notes",
          summary: "Writes notes after triage.",
          routine: {
            title: "Morning notes",
            when: [
              {
                kind: "event",
                event: "routines.run_ended",
                where: [{ field: "routine", is: "triage" }],
              },
            ],
            do: {
              kind: "session",
              prompt: "Write the notes.",
              workspace: { kind: "folder", path: root },
            },
            limits: { dailySpend: 5 },
          },
        }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage([fauxText("made the routine")]),
  ]);

  await page.goto(server.url.href);
  const composer = page.getByLabel("Ask the Pipoca assistant");
  await composer.fill("Write notes after triage");
  await composer.press("Enter");

  const card = page.getByRole("region", { name: "Routine" });

  await card.getByText("Morning notes").waitFor();

  expect(await card.locator("p").textContent()).toBe(
    `After triage ends, follow the instructions in ${root}.`,
  );

  await card.getByText("Acts as you · default Profile").waitFor();

  await page
    .locator('[data-role="prompt"]')
    .getByRole("button", { name: "Create" })
    .click();

  await page
    .locator('#chat li[data-role="assistant"]', { hasText: "made the routine" })
    .waitFor();

  expect(await card.count()).toBe(0);
}, 30_000);

test("shows a Project the assistant makes as a card that stays in the chat, with what it starts on", async () => {
  const repository = join(root, "readmes");
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", repository]);
  await writeFile(join(repository, "README.md"), "readmes\n");
  execFileSync("git", ["add", "."], { cwd: repository });

  execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"],
    { cwd: repository },
  );

  faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall("projects_create", {
          name: "Readme check",
          repositories: [repository],
          firstMessage: "Check every README against the code",
        }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage([fauxText("on it")]),
    fauxAssistantMessage([fauxText("on it")]),
  ]);

  await page.goto(server.url.href);
  const composer = page.getByLabel("Ask the Pipoca assistant");
  await composer.fill("Make a Project that checks the READMEs");
  await composer.press("Enter");

  const projectsNamed = async (): Promise<
    { id: string; name: string; coordinatorId: string }[]
  > =>
    (await (
      await fetch(new URL("/api/ext/projects/projects", server.url), {
        headers: { cookie },
      })
    ).json()) as { id: string; name: string; coordinatorId: string }[];

  let project = (await projectsNamed()).find(
    ({ name }) => name === "Readme check",
  );

  for (let tries = 0; project === undefined && tries < 50; tries++) {
    await page.waitForTimeout(100);

    project = (await projectsNamed()).find(
      ({ name }) => name === "Readme check",
    );
  }

  // A wide screen goes to what the assistant made; its chat keeps the card.
  await page
    .waitForURL((url) => url.hash.includes(project?.id ?? "-"), {
      timeout: 2000,
    })
    .catch(() => undefined);

  const assistant = (await (
    await fetch(new URL("/api/ext/projects/assistant", server.url), {
      headers: { cookie },
    })
  ).json()) as { id: string };

  await page.goto(
    new URL(`/#plugin/projects/${assistant.id}`, server.url).href,
  );

  await page.reload();

  const card = page.locator('#chat [aria-label="Project Readme check"]');

  await card.getByText(/^1 repository/).waitFor();
  await card.getByRole("link", { name: "Open", exact: true }).waitFor();
  await card.getByText(/^Coordinator /).waitFor();

  await page
    .locator('#chat li[data-role="assistant"]', { hasText: "on it" })
    .waitFor();

  await card.waitFor();

  expect(await page.locator("#chat").getByText("projects_create").count()).toBe(
    0,
  );

  const coordinator = (await (
    await fetch(
      new URL(`/api/sessions/${project?.coordinatorId ?? ""}`, server.url),
      { headers: { cookie } },
    )
  ).json()) as { firstMessage?: string };

  expect(coordinator.firstMessage).toBe("Check every README against the code");
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

  // A blank start point is left out rather than sent empty.
  expect(JSON.stringify(asked)).not.toContain("startPoint");

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

  await reminders
    .getByRole("listitem")
    .filter({ hasText: "Where should Pi work?" })
    .getByRole("link", { name: "Set up" })
    .click();

  await page.getByRole("heading", { name: "Where should Pi work?" }).waitFor();
  await page.getByRole("button", { name: "Show the command" }).click();

  const command = page.getByLabel("Join command");
  await command.filter({ hasText: "PIPOCA_KEY=pck_" }).waitFor();

  expect(await command.textContent()).toEndWith(
    `pipoca agent --server ${server.url.origin}`,
  );

  phase = "no models";
  await page.goto(server.url.href);
  await reminders.getByText("Your models").waitFor();

  expect(await reminders.getByText("Where should Pi work?").count()).toBe(0);

  // A host added after the person went on without one brings their code
  // step back.
  const hosts = new URL("/api/ext/git-hosts/hosts", server.url);

  await fetch(hosts, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ host: "git.example.com", label: "Forge" }),
  });

  await page.unroute("**/api/environments");
  await page.reload();
  await reminders.getByText("Connect your code").waitFor();

  // Pi's defaults, picked in setup, finished the Profile step.
  expect(await reminders.getByText("Your models").count()).toBe(0);
  expect(await reminders.getByText("Make Pi yours").count()).toBe(0);

  await reminders
    .getByRole("button", { name: "Dismiss Connect your code" })
    .click();

  await reminders.waitFor({ state: "hidden" });
  await page.reload();
  await page.getByRole("button", { name: "New session" }).waitFor();

  expect(await reminders.isVisible()).toBe(false);

  await fetch(`${hosts.href}/git.example.com`, {
    method: "DELETE",
    headers: { cookie },
  });
}, 20_000);

test("a person with no model pastes a key of their own in Your models, and adds a provider's package to their default Profile", async () => {
  // The runners report no model logged in, so only a login counts.
  await page.route("**/api/environments", async (route) => {
    const real = (await (await route.fetch()).json()) as Environment[];

    await route.fulfill({
      json: real.map((each) => ({ ...each, models: [] })),
    });
  });

  const api = (path: string): string => new URL(path, server.url).href;
  const headers = { [versionHeader]: String(protocolVersion) };

  const defaults = async (): Promise<Profile> =>
    (await (
      await page.request.get(api("/api/me/profile-defaults"), { headers })
    ).json()) as Profile;

  const before = (await defaults()).packages;

  await page.goto(server.url.href);

  await page
    .getByRole("region", { name: "Finish setting up" })
    .getByRole("listitem")
    .filter({ hasText: "Your models" })
    .getByRole("link", { name: "Set up" })
    .click();

  await page.getByRole("heading", { name: "Your models" }).waitFor();
  expect(await continueButton().isDisabled()).toBe(true);

  const providers = page.getByRole("list", { name: "Model providers" });
  await page.getByLabel("Search providers").fill("faux");

  const row = providers.getByRole("listitem").filter({ hasText: "faux" });
  await row.getByText("Added by a package").waitFor();
  await row.getByRole("button", { name: "Add a key for faux" }).click();

  const key = page.getByRole("form", { name: "Key for faux" });
  await key.getByLabel("faux key").fill("sk-faux-mine");
  await key.getByRole("button", { name: "Save key" }).click();

  await row.getByText("Key saved").waitFor();
  await until(async () => !(await continueButton().isDisabled()));

  await page.getByRole("button", { name: "Add package" }).click();
  const added = page.getByRole("form", { name: "Add a provider's package" });
  await added.getByLabel("Package").fill("npm:pi-provider-example");
  await added.getByRole("button", { name: "Add" }).click();

  await page
    .getByRole("status")
    .getByText("Added npm:pi-provider-example to your default Profile", {
      exact: false,
    })
    .waitFor();

  expect((await defaults()).packages).toEqual([
    ...before,
    "npm:pi-provider-example",
  ]);

  await page.request.put(api("/api/me/profile-defaults"), {
    headers,
    data: { packages: before },
  });

  await page.request.delete(
    api("/api/ext/logins/credentials/faux?layer=defaults"),
    { headers },
  );

  await page.unroute("**/api/environments");
});

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

test("finds a plugin by a word of its name or description", async () => {
  await page.goto(server.url.href);
  await openSettings("Plugins");

  const plugins = page.getByRole("list", { name: "Plugins" });
  await plugins.getByRole("listitem", { name: "Routines" }).waitFor();

  await page.getByLabel("Search plugins").fill("subagents");

  await plugins
    .getByRole("listitem", { name: "Routines" })
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

test("opens a shared Profile's file from the Configuration tree and saves it", async () => {
  const folder = join(root, "config", "profiles", "tree");
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "AGENTS.md"), "Be brief.\n");

  await page.goto(server.url.href);
  await openSettings("Configuration");

  const tree = page.getByRole("navigation", { name: "Config files" });
  await tree.getByRole("button", { name: "profiles/" }).click();
  await tree.getByRole("button", { name: "tree/" }).click();
  await tree.getByRole("button", { name: "AGENTS.md" }).click();

  const file = page.getByRole("region", { name: "profiles/tree/AGENTS.md" });
  const contents = file.getByLabel("profiles/tree/AGENTS.md contents");

  await page.waitForFunction(
    'document.querySelector(\'[aria-label="profiles/tree/AGENTS.md contents"]\')?.value === "Be brief.\\n"',
  );

  await contents.fill("Be very brief.");
  await file.getByRole("button", { name: "Save" }).click();
  await file.getByText("Edited").waitFor({ state: "detached" });

  expect(await readFile(join(folder, "AGENTS.md"), "utf8")).toBe(
    "Be very brief.\n",
  );
});

test("turns an installed plugin on for the next start", async () => {
  await page.goto(server.url.href);
  await openSettings("Plugins");

  const hello = page.getByRole("listitem", { name: "hello" });
  await hello.getByText(/^Installed/).waitFor();

  await hello.getByRole("switch", { name: "On" }).click();
  await confirmIn("Turn on");
  await hello.getByText("It turns on when the server restarts.").waitFor();
  await hello.getByText("Off until restart").waitFor();

  await page.getByRole("button", { name: "Restart now" }).click();
  await page.getByText(/restart it yourself/).waitFor();

  await page.reload();
  await hello.getByRole("switch", { name: "On", checked: true }).click();
  await hello.getByRole("switch", { name: "On", checked: false }).waitFor();

  expect(await hello.getByText(/when the server restarts/).count()).toBe(0);
});

test("turns a built-in plugin off for the next start and back on", async () => {
  await page.goto(server.url.href);
  await openSettings("Plugins");

  const checklist = page.getByRole("listitem", { name: "Checklist" });
  await checklist.getByText(/^Built in/).waitFor();

  await checklist.getByRole("switch", { name: "On", checked: true }).click();
  await checklist.getByText("It turns off when the server restarts.").waitFor();
  await checklist.getByText("On until restart").waitFor();

  await checklist.getByRole("switch", { name: "On", checked: false }).click();
  await checklist.getByRole("switch", { name: "On", checked: true }).waitFor();

  expect(await checklist.getByText(/when the server restarts/).count()).toBe(0);
});

test("turns off a plugin with the ones that need it after asking, and back on with them", async () => {
  await page.goto(server.url.href);
  await openSettings("Plugins");

  const anchor = page.getByRole("listitem", { name: "Anchor" });
  const leaning = page.getByRole("listitem", { name: "Leaning" });
  await anchor.getByText("Needed by Leaning").waitFor();
  await leaning.getByText("Needs Anchor").waitFor();

  await anchor.getByRole("switch", { name: "On", checked: true }).click();

  const dialog = page.getByRole("dialog");

  await dialog
    .getByText("Leaning needs Anchor, so it turns off too. Its data stays.")
    .waitFor();

  await dialog.getByRole("button", { name: "Turn off" }).click();

  await leaning.getByRole("switch", { name: "On", checked: false }).waitFor();
  await anchor.getByRole("switch", { name: "On", checked: false }).waitFor();

  await leaning.getByRole("switch", { name: "On", checked: false }).click();
  await dialog.getByText("It needs Anchor, so it turns on too.").waitFor();
  await dialog.getByRole("button", { name: "Turn on" }).click();

  await anchor.getByRole("switch", { name: "On", checked: true }).waitFor();
  await leaning.getByRole("switch", { name: "On", checked: true }).waitFor();
});

test("installs a plugin from a git repository, asks before turning it on, and removes it", async () => {
  const source = join(root, "sources", "weather");
  await mkdir(source, { recursive: true });

  await writeFile(
    join(source, "package.json"),
    JSON.stringify({
      description: "Says the weather.",
      pipoca: { id: "weather", entry: "plugin.ts" },
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

  await page.getByText("Installed weather, turned off.").waitFor();

  const weather = page.getByRole("listitem", { name: "weather" });
  await weather.getByText(`file://${source} at`).waitFor();

  await weather.getByRole("switch", { name: "On" }).click();

  expect(
    await page.getByRole("dialog", { name: "Turn on weather?" }).textContent(),
  ).toContain("with the server's access");

  await confirmIn("Turn on");
  await weather.getByRole("switch", { name: "On", checked: true }).click();

  await weather.getByRole("button", { name: "Remove" }).click();
  await confirmIn("Remove");
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

test("shows the name given at setup on General, beside the username", async () => {
  await page.goto(server.url.href);
  await openSettings("General");

  const you = page.getByRole("list", { name: "You" });
  await you.getByText("Pedro Klein").waitFor();
  await you.getByText(/^@pedro · /).waitFor();
});

test("edits the person's name and what new Sessions start with on General", async () => {
  await page.goto(server.url.href);
  await openSettings("General");

  const you = page.getByRole("list", { name: "You" });
  await you.getByRole("button", { name: "Edit profile" }).click();

  const dialog = page.getByRole("dialog", { name: "Edit profile" });
  await dialog.getByLabel("Your name").fill("Pedro K.");
  await dialog.getByRole("button", { name: "Save" }).click();
  await dialog.waitFor({ state: "detached" });
  await you.getByText("Pedro K.").waitFor();

  const startWith = page.locator("section", {
    has: page.getByRole("heading", { name: "New Sessions start with" }),
  });

  const [environment] = (await (
    await fetch(new URL("/api/environments", server.url), {
      headers: { cookie },
    })
  ).json()) as Environment[];

  const saved = page.waitForResponse("**/api/me");
  await startWith.getByLabel("Environment").selectOption(environment?.id ?? "");
  await saved;

  const me = async (): Promise<unknown> =>
    (
      await fetch(new URL("/api/me", server.url), { headers: { cookie } })
    ).json();

  expect(await me()).toMatchObject({
    displayName: "Pedro K.",
    defaultEnvironment: environment?.id,
  });

  await startWith.getByLabel("Profile").waitFor();

  await fetch(new URL("/api/me", server.url), {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({
      displayName: "Pedro Klein",
      defaultEnvironment: null,
    }),
  });
}, 30_000);

test("signs a person out in every browser from General", async () => {
  const [invite] = (await (
    await fetch(new URL("/api/invites", server.url), {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({}),
    })
  ).json()) as { readonly id: string; readonly token: string }[];

  const first = await browser.newContext();
  const second = await browser.newContext();

  try {
    const tab = await first.newPage();
    await tab.goto(new URL(`/#join/${invite?.token ?? ""}`, server.url).href);

    const account = tab.getByRole("form", { name: "Make your account" });
    await account.getByLabel("Username").fill("dora");
    await account.getByLabel("Password").fill("correct horse");
    await account.getByRole("button", { name: "Join" }).click();
    await tab.getByRole("list", { name: "Your steps" }).waitFor();

    await first.request.patch(new URL("/api/me/setup", server.url).href, {
      data: { finished: true },
    });

    const other = await second.newPage();
    await other.goto(server.url.href);
    await other.getByLabel("Name").fill("dora");
    await other.getByLabel("Password").fill("correct horse");
    await other.getByRole("button", { name: "Sign in" }).click();
    await other.getByRole("button", { name: "New session" }).waitFor();

    await tab.goto(new URL("/#settings/general", server.url).href);
    await tab.reload();
    await tab.getByRole("button", { name: "Sign out everywhere" }).click();

    await tab
      .getByRole("dialog", { name: "Sign out everywhere?" })
      .getByRole("button", { name: "Sign out everywhere" })
      .click();

    await tab.getByRole("heading", { name: "Sign in" }).waitFor();
    await other.reload();
    await other.getByRole("heading", { name: "Sign in" }).waitFor();
  } finally {
    await first.close();
    await second.close();

    // A shared link stays open after someone joins with it, so revoke it
    // and leave the People page's invites as the later tests expect them.
    await fetch(new URL(`/api/invites/${invite?.id ?? ""}`, server.url), {
      method: "DELETE",
      headers: { cookie },
    });
  }
}, 30_000);

test("draws a defined plugin's page and slots, pinned for someone who never changed their pins", async () => {
  await page.route("**/api/me/pinned-pages", async (route) => {
    await (route.request().method() === "GET"
      ? route.fulfill({ json: { pages: null } })
      : route.continue());
  });

  try {
    await page.goto(server.url.href);
    const nav = page.locator("#plugin-nav");

    await nav.getByRole("link", { name: "Assistant", exact: true }).waitFor();

    expect(
      await nav.getByRole("link", { name: "Artifacts", exact: true }).count(),
    ).toBe(0);

    await nav.getByRole("link", { name: "Vault" }).click();
    await page.getByRole("heading", { name: "Vault" }).waitFor();
    await page.getByText("Keys for pedro").waitFor();
    await page.getByText("Open at the start").waitFor();
    await page.getByText("Vault keeps your keys.").waitFor();
  } finally {
    await page.unroute("**/api/me/pinned-pages");
  }

  await openSettings("General");
  await page.getByText("Vault keeps your keys.").waitFor();
});

test("saves a collection item with a secret from the config's form, and keeps the secret sealed", async () => {
  await page.goto(server.url.href);
  await openSettings("Vault");

  await page.getByRole("button", { name: "Add" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill("github");
  await dialog.getByLabel("Token").fill("ghp_plain");
  await dialog.getByRole("button", { name: "Save" }).click();
  await dialog.waitFor({ state: "detached" });

  const keys = page.getByRole("list", { name: "Keys" });
  await keys.getByText("github").waitFor();

  const saved = await readFile(join(root, "config", "pipoca.json"), "utf8");

  const { vault } = JSON.parse(saved) as {
    vault: { keys: { name: string; token: Record<string, string> }[] };
  };

  expect(vault.keys.map(({ name }) => name)).toEqual(["github"]);
  expect(Object.keys(vault.keys[0]?.token ?? {})).toEqual(["sealed"]);
  expect(saved).not.toContain("ghp_plain");

  await page.reload();
  await keys.getByRole("button", { name: "Edit" }).click();

  const token = page.getByRole("dialog").getByLabel("Token");
  expect(await token.inputValue()).toBe("");

  expect(await token.getAttribute("placeholder")).toBe(
    "Saved, type to replace",
  );
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
  const artifacts = nav.getByRole("link", { name: "Artifacts", exact: true });

  await nav.getByRole("link", { name: "Assistant", exact: true }).waitFor();
  expect(await artifacts.count()).toBe(0);

  await nav.getByRole("button", { name: "More" }).click();
  await nav.getByRole("button", { name: "Pin Artifacts" }).click();
  await nav.getByRole("button", { name: "Unpin Artifacts" }).waitFor();

  await page.reload();
  await artifacts.waitFor();
  expect(await nav.getByRole("button", { name: "More" }).count()).toBe(1);

  await nav.getByRole("button", { name: "Unpin Artifacts" }).click();
  await page.reload();
  await nav.getByRole("link", { name: "Assistant", exact: true }).waitFor();
  expect(await artifacts.count()).toBe(0);
});

test("puts a pin back when the server doesn't save it", async () => {
  const { promise: pinned, resolve: refuse } = Promise.withResolvers();

  await page.route("**/api/me/pinned-pages", async (route) => {
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
  await nav.getByRole("button", { name: "Pin Artifacts" }).click();
  await nav.getByRole("button", { name: "Unpin Artifacts" }).waitFor();
  refuse(undefined);

  await nav
    .getByRole("button", { name: "Pin Artifacts", exact: true })
    .waitFor({ timeout: 2000 });

  await page.unroute("**/api/me/pinned-pages");
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

  await editor.getByRole("button", { name: "Delete" }).click();
  await confirmIn("Delete");
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
    await fetch(new URL("/api/settings/base-profile", server.url), {
      method: "PUT",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ mcpServers }),
    });
  };

  // The test's MCP server is on a loopback address, which an admin allows.
  const allow = async (privateHosts: readonly string[]): Promise<void> => {
    await fetch(new URL("/api/plugins/logins/config", server.url), {
      method: "PUT",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ value: { privateHosts } }),
    });
  };

  try {
    await allow([linear.url.host]);
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
    await allow([]);
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

  await page.getByRole("button", { name: "Revoke My laptop" }).click();
  await confirmIn("Revoke");
  await page.getByText("No client has a token.").waitFor();
  expect(await ping()).toBe(401);
});

test("says why an MCP token wasn't revoked", async () => {
  await page.goto(server.url.href);
  await openSettings("Access tokens");

  await page.getByLabel("Client name").fill("Old laptop");
  await page.getByRole("button", { name: "New token" }).click();
  const revoke = page.getByRole("button", { name: "Revoke Old laptop" });

  await page.route("**/api/me/access-tokens/*", async (route) =>
    route.fulfill({
      status: 500,
      json: { error: "internal", message: "token store is locked" },
    }),
  );

  await revoke.click();
  await confirmIn("Revoke");
  await page.getByRole("alert").getByText("token store is locked").waitFor();
  await page.unroute("**/api/me/access-tokens/*");

  await revoke.click();
  await confirmIn("Revoke");
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
    await fetch(new URL("/api/environment-templates", server.url), {
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
          new URL(`/api/ext/kubernetes/templates/${template.id}`, server.url),
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

  await fetch(
    new URL(`/api/environment-templates/${template.id}`, server.url),
    {
      method: "DELETE",
      headers: { cookie },
    },
  );
});

test("deletes an Environment from its page", async () => {
  const environment = (await (
    await fetch(new URL("/api/environments", server.url), {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "throwaway" }),
    })
  ).json()) as { readonly id: string };

  await page.goto(`${server.url.href}#settings/environments/${environment.id}`);

  await page.getByRole("button", { name: "Delete throwaway" }).click();
  await confirmIn("Delete");

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

  await providers.getByRole("button", { name: "Edit Okta" }).click();
  await page.getByRole("button", { name: "Remove Okta" }).click();
  await confirmIn("Remove");
  await providers.waitFor({ state: "detached" });
});

test("shows the Slack bots and mailboxes the deploy file sets read-only", async () => {
  const locked = async (route: Route): Promise<void> => {
    await route.fulfill({
      json: { value: {}, lockedIn: "/etc/pipoca/pipoca.json" },
    });
  };

  const bots = async (route: Route): Promise<void> => {
    await route.fulfill({
      json: [
        {
          name: "team-bot",
          team: "Acme",
          botUser: "U1",
          connected: true,
          error: null,
        },
      ],
    });
  };

  const mailboxes = async (route: Route): Promise<void> => {
    await route.fulfill({
      json: [{ name: "support", address: "support@example.com", error: null }],
    });
  };

  await page.route("**/api/plugins/{slack,email}/config", locked);
  await page.route("**/api/ext/slack/bots", bots);
  await page.route("**/api/ext/email/mailboxes", mailboxes);
  await page.goto(server.url.href);
  await openSettings("Integrations");

  for (const [section, list, item] of [
    ["Slack", "Slack bots", "team-bot"],
    ["Email", "Mailboxes", "support"],
  ] as const) {
    await page
      .getByRole("navigation", { name: "Integrations" })
      .getByRole("link", { name: section })
      .click();

    const listed = page.getByRole("list", { name: list });
    await listed.getByText("Set in deploy file").waitFor();

    expect(
      await listed.getByRole("button", { name: `Remove ${item}` }).count(),
    ).toBe(0);

    await page
      .getByRole("note")
      .filter({ hasText: "/etc/pipoca/pipoca.json" })
      .waitFor();

    expect(await page.getByRole("button", { name: /^Add a/ }).count()).toBe(0);
  }

  await page.unroute("**/api/plugins/{slack,email}/config", locked);
  await page.unroute("**/api/ext/slack/bots", bots);
  await page.unroute("**/api/ext/email/mailboxes", mailboxes);
});

test("guides an admin from a token-only host to a Connect button", async () => {
  await page.goto(server.url.href);
  await openSettings("Git hosts");

  // No host is listed until an admin adds one.
  const hosts = page.getByRole("list", { name: "Hosts" });
  await hosts.getByRole("button", { name: "Add GitHub" }).waitFor();

  await page.getByRole("button", { name: "Add a host" }).click();

  const form = page.getByRole("form", { name: "New host" });
  await form.getByLabel("Host").fill("git.example.com");
  await form.getByRole("button", { name: "Add host" }).click();

  const added = hosts
    .getByRole("listitem")
    .filter({ hasText: "git.example.com" });

  await added.getByText("Tokens only").waitFor();

  await page
    .getByRole("button", { name: "Set up Connect for git.example.com" })
    .click();

  const setup = page.getByRole("region", {
    name: "Set up Connect for git.example.com",
  });

  await setup.getByLabel("Client ID").fill("Iv1.abc");
  await setup.getByLabel("Client secret").fill("shh");
  await setup.getByRole("button", { name: "Save" }).click();

  await added.getByText("Sign-in ready").waitFor();
  await setup.getByRole("button", { name: "Connect your account" }).waitFor();

  await setup.getByRole("button", { name: "Done" }).click();
  await page.getByRole("button", { name: "Edit git.example.com" }).click();
  await page.getByRole("button", { name: "Remove git.example.com" }).click();
  await confirmIn("Remove");
  await hosts.getByText("git.example.com").waitFor({ state: "detached" });
});

test("an admin adds a host with its sign-in in server setup, and people find it in their own", async () => {
  await page.goto(new URL("/#get-started/server:git-hosts", server.url).href);

  await page
    .getByRole("heading", { name: "Where does the team's code live?" })
    .waitFor();

  const adds = page.getByRole("group", { name: "Add a host" });
  await adds.getByRole("button", { name: "GitHub Enterprise" }).click();

  const form = page.getByRole("form", { name: "New host" });
  expect(await form.getByLabel("Label").inputValue()).toBe("GitHub Enterprise");
  await form.getByLabel("Host").fill("git.corp.example");
  await form.getByLabel("Label").fill("Corp Git");
  await form.getByRole("button", { name: "Add host" }).click();

  const card = page.getByRole("list", { name: "Corp Git" });
  await card.getByText("No sign-in yet").waitFor();

  // A host listed is the step's answer.
  expect(await page.getByText("Go on with no code host").count()).toBe(0);
  expect(await continueButton().isDisabled()).toBe(false);

  await card
    .getByRole("button", { name: "Set up sign-in for git.corp.example" })
    .click();

  const setup = page.getByRole("region", {
    name: "Set up Connect for git.corp.example",
  });

  await setup.getByLabel("Client ID").fill("Iv1.corp");
  await setup.getByLabel("Client secret").fill("shh");
  await setup.getByRole("button", { name: "Save" }).click();
  await card.getByText("Ready").waitFor();

  await card.getByRole("button", { name: "Create GitHub App" }).click();

  await page
    .getByRole("form", { name: "A GitHub App for Corp Git" })
    .getByRole("button", { name: "Create on git.corp.example" })
    .waitFor();

  await page.goto(new URL("/#get-started/git-hosts", server.url).href);
  await page.getByRole("heading", { name: "Connect your code" }).waitFor();

  const mine = page.getByRole("list", { name: "Corp Git" });
  await mine.getByRole("button", { name: "Sign in with Corp Git" }).waitFor();
  await mine.getByRole("button", { name: "use a token" }).click();
  await mine.getByLabel("Personal access token").waitFor();

  await fetch(
    new URL("/api/ext/git-hosts/hosts/git.corp.example", server.url),
    {
      method: "DELETE",
      headers: { cookie },
    },
  );
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
    await tab.getByText("Your setup", { exact: true }).waitFor();
  } finally {
    await context.close();
  }

  await page.getByRole("tab", { name: /^Members/ }).click();
  await page.getByRole("row", { name: "bea", exact: true }).waitFor();
}, 30_000);

test("chooses what new people get, and someone who joins picks an offered Profile in their setup", async () => {
  const shared = (await (
    await fetch(new URL("/api/profiles", server.url), {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        name: "Backend kit",
        shared: true,
        agentsMd: "Adds the Go skills",
      }),
    })
  ).json()) as { readonly id: string };

  await page.goto(server.url.href);
  await openSettings("People");

  const card = page.getByRole("region", { name: "What new people get" });
  await card.getByRole("button", { name: "Edit" }).click();

  const form = card.getByRole("form", { name: "Choose what new people get" });
  await form.getByLabel("Backend kit").check();
  await form.getByLabel("Your default Profile").check();
  await form.getByRole("button", { name: "Save" }).click();

  await card
    .getByRole("list", { name: "New people get" })
    .getByText("Base Profile + Backend kit")
    .waitFor();

  await card.getByText("Must do: Your default Profile").waitFor();

  await page.getByRole("button", { name: "Invite people" }).click();

  const dialog = page.getByRole("dialog", { name: "Invite people" });

  await dialog
    .getByRole("region", { name: "Their setup" })
    .getByText("They pick: a Profile, from Backend kit, or their own")
    .waitFor();

  await dialog.getByRole("button", { name: "Make a link" }).click();

  const link = (await dialog.getByText(/#join\//).textContent()) ?? "";

  await dialog.getByRole("button", { name: "Close" }).click();

  const context = await browser.newContext();

  try {
    const tab = await context.newPage();
    await tab.goto(link);

    await tab
      .getByRole("list", { name: "Set up by your team" })
      .getByText("Profiles to pick from")
      .waitFor();

    const yours = tab.getByRole("list", { name: "You'll add" });
    await yours.getByText("One of the team's, or your own").waitFor();
    expect(await yours.getByText("Optional").count()).toBe(0);

    const account = tab.getByRole("form", { name: "Make your account" });
    await account.getByLabel("Username").fill("cleo");
    await account.getByLabel("Password").fill("correct horse");
    await account.getByRole("button", { name: "Join" }).click();

    await tab
      .getByRole("heading", { name: "Welcome to your team's Pipoca" })
      .waitFor();

    await tab
      .getByRole("list", { name: "Your steps" })
      .getByRole("listitem")
      .filter({ hasText: "Your default Profile" })
      .getByText("Required")
      .waitFor();

    await tab.goto(`${server.url.href}#get-started/profile`);
    await tab.getByRole("radio", { name: /^Copy a team Profile/ }).check();

    const offered = tab.getByRole("list", { name: "Profiles on offer" });
    await offered.getByRole("button", { name: "Backend kit" }).click();

    await offered
      .getByRole("button", { name: "Backend kit", pressed: true })
      .waitFor();

    expect(
      await tab.getByRole("button", { name: "Skip for now" }).count(),
    ).toBe(0);

    await tab.getByRole("button", { name: "Continue" }).click();
    await tab.getByRole("heading", { name: "You're set" }).waitFor();
  } finally {
    await context.close();
  }

  await fetch(new URL("/api/settings/newcomers", server.url), {
    method: "PUT",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ template: null, profiles: [], required: [] }),
  });

  await fetch(new URL(`/api/profiles/${shared.id}`, server.url), {
    method: "DELETE",
    headers: { cookie },
  });
}, 30_000);

test("someone who joins finds the team's template picked in Where, and Continue makes it their Environment", async () => {
  const admin = async (path: string, method: string, body?: unknown) =>
    fetch(new URL(path, server.url), {
      method,
      headers: { "content-type": "application/json", cookie },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });

  const template = (await (
    await admin("/api/environment-templates", "POST", { name: "Team kit" })
  ).json()) as { readonly id: string };

  await admin("/api/settings/newcomers", "PUT", {
    template: template.id,
    profiles: [],
    required: [],
  });

  const [invite] = (await (await admin("/api/invites", "POST", {})).json()) as {
    readonly token: string;
  }[];

  const context = await browser.newContext();

  try {
    const tab = await context.newPage();
    await tab.goto(new URL(`/#join/${invite?.token ?? ""}`, server.url).href);

    const account = tab.getByRole("form", { name: "Make your account" });
    await account.getByLabel("Username").fill("enzo");
    await account.getByLabel("Password").fill("correct horse");
    await account.getByRole("button", { name: "Join" }).click();

    await tab
      .getByRole("list", { name: "Your steps" })
      .getByRole("listitem")
      .filter({ hasText: "Where Pi works" })
      .getByText("Picked")
      .waitFor();

    await tab.goto(`${server.url.href}#get-started/where`);

    await tab
      .getByRole("checkbox", { name: /^Team kit/, checked: true })
      .waitFor();

    await tab.getByRole("button", { name: "Continue" }).click();
    await tab.getByRole("heading", { name: "Make Pi yours" }).waitFor();

    const environments = (await tab.evaluate(async () =>
      (await fetch("/api/environments")).json(),
    )) as Environment[];

    expect(environments.map(({ templateId }) => templateId)).toEqual([
      template.id,
    ]);

    await tab.getByRole("button", { name: "Back" }).click();
    await tab.getByRole("heading", { name: "Where should Pi work?" }).waitFor();

    expect(await tab.getByRole("checkbox", { name: /^Team kit/ }).count()).toBe(
      0,
    );
  } finally {
    await context.close();
  }

  await admin("/api/settings/newcomers", "PUT", {
    template: null,
    profiles: [],
    required: [],
  });

  await admin(`/api/environment-templates/${template.id}`, "DELETE");
}, 30_000);

test("someone who joins brings their Pi setup into My defaults, adding to it and leaving the shared Default alone", async () => {
  const folder = join(root, "lia-agent");

  await mkdir(join(folder, "skills", "review"), { recursive: true });
  await writeFile(join(folder, "skills", "review", "SKILL.md"), "# Review");
  await writeFile(join(folder, "AGENTS.md"), "Lia's rules");

  await writeFile(
    join(folder, "settings.json"),
    JSON.stringify({ packages: ["npm:pi-brought"] }),
  );

  const sharedBefore = await (
    await fetch(new URL("/api/profiles/default", server.url), {
      headers: { cookie },
    })
  ).json();

  const [invite] = (await (
    await fetch(new URL("/api/invites", server.url), {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: "{}",
    })
  ).json()) as { readonly token: string }[];

  const context = await browser.newContext();

  try {
    const tab = await context.newPage();
    await tab.goto(new URL(`/#join/${invite?.token ?? ""}`, server.url).href);

    const account = tab.getByRole("form", { name: "Make your account" });
    await account.getByLabel("Username").fill("lia");
    await account.getByLabel("Password").fill("correct horse");
    await account.getByRole("button", { name: "Join" }).click();

    await tab.getByRole("list", { name: "Your steps" }).waitFor();

    await tab.evaluate(async () =>
      fetch("/api/me/profile-defaults", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ packages: ["npm:pi-kept"] }),
      }),
    );

    await tab.goto(`${server.url.href}#get-started/profile`);
    await tab.getByRole("heading", { name: "Make Pi yours" }).waitFor();
    await tab.getByRole("radio", { name: /^Bring my Pi setup/ }).check();
    await tab.getByLabel("Pick the folder").setInputFiles(folder);

    await tab
      .getByRole("button", { name: /^Import \d+ items into My defaults$/ })
      .click();

    await tab
      .getByRole("status")
      .getByText(/into My defaults\.$/)
      .waitFor();

    const defaults = (await tab.evaluate(async () =>
      (await fetch("/api/me/profile-defaults")).json(),
    )) as { agentsMd: string; packages: unknown[] };

    expect(defaults.agentsMd).toBe("Lia's rules");
    expect(defaults.packages).toEqual(["npm:pi-kept", "npm:pi-brought"]);
  } finally {
    await context.close();
  }

  expect(
    await (
      await fetch(new URL("/api/profiles/default", server.url), {
        headers: { cookie },
      })
    ).json(),
  ).toEqual(sharedBefore);
}, 30_000);

test("starts a person's default Profile from a Profile a repository's pipoca.json lists, or says what to add", async () => {
  const url = "https://git.example.com/me/dotfiles.git";
  let made: unknown;

  await page.route("**/api/repositories/manifest?*", async (route) =>
    route.fulfill({
      json:
        new URL(route.request().url()).searchParams
          .get("url")
          ?.endsWith("bare.git") === true
          ? {
              found: false,
              commit: "0".repeat(40),
              profiles: [],
              templates: [],
            }
          : {
              found: true,
              commit: "3f9c2e1".padEnd(40, "0"),
              profiles: [
                {
                  name: "My Pi",
                  path: ".pi/agent",
                  holds: { skills: 6, packages: 2, agentsMd: true },
                },
                {
                  name: "Minimal",
                  path: ".pi/minimal",
                  holds: { skills: 0, packages: 0, agentsMd: true },
                },
              ],
              templates: [],
            },
    }),
  );

  await page.route("**/api/profiles", async (route) => {
    if (route.request().method() !== "POST") {
      return route.fallback();
    }

    made = route.request().postDataJSON();

    return route.fulfill({
      json: { id: "minimal", name: "Minimal", isDefault: false },
    });
  });

  await page.route("**/api/profiles/minimal", async (route) =>
    route.fulfill({
      json: { id: "minimal", name: "Minimal", isDefault: true },
    }),
  );

  try {
    await page.goto(`${server.url.href}#get-started/profile`);
    await page.getByRole("heading", { name: "Make Pi yours" }).waitFor();

    await page
      .getByRole("radio", { name: /^Start from a git repository/ })
      .check();

    await page
      .getByLabel("Repository address")
      .fill(url.replace("dotfiles", "bare"));

    await page.getByRole("button", { name: "Look" }).click();

    const nothing = page.getByRole("group", { name: "Nothing listed" });

    await nothing
      .getByText("No pipoca.json at the root of this repository")
      .waitFor();

    await nothing
      .getByRole("link", { name: "How pipoca.json works" })
      .waitFor();

    await page.getByLabel("Repository address").fill(url);
    await page.getByRole("button", { name: "Look" }).click();

    const listed = page.getByRole("group", {
      name: "Profiles in the repository",
    });

    await listed.getByText("pipoca.json lists 2 Profiles").waitFor();
    await listed.getByText("dotfiles @ 3f9c2e1").waitFor();

    await listed
      .getByText(".pi/agent · 6 skills, 2 packages, AGENTS.md")
      .waitFor();

    expect(await nothing.count()).toBe(0);

    await listed.getByRole("radio", { name: /^Minimal/ }).check();

    await listed
      .getByRole("button", { name: "Make “Minimal” my default Profile" })
      .click();

    await page
      .getByRole("status")
      .getByText("Made Minimal your default Profile.")
      .waitFor();

    expect(made).toEqual({ source: { url, path: ".pi/minimal" } });
  } finally {
    await page.unrouteAll({ behavior: "wait" });
  }
});

test("shows why an Environment's last runner pod failed", async () => {
  await page.route("**/api/ext/kubernetes/environments/*", async (route) =>
    route.fulfill({
      json: {
        settings: {
          workspace: "pod",
          capacity: 1,
          maxPods: 5,
          idleSeconds: 300,
          claimSize: "10Gi",
          storageClass: null,
          labels: {},
          annotations: {},
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

  await page.unroute("**/api/ext/kubernetes/environments/*");
});

test("names the plugin an Environment's runners come from", async () => {
  const environments = /\/api\/environments(\?.*)?$/;

  await page.route(environments, async (route) => {
    const real = (await (await route.fetch()).json()) as Environment[];

    await route.fulfill({
      json: real.map((each) =>
        each.name === "e2e"
          ? {
              ...each,
              onDemand: true,
              runnersFrom: { plugin: "pods", label: "Pod farm", icon: "cloud" },
            }
          : each,
      ),
    });
  });

  await page.goto(server.url.href);
  await openSettings("Environments");

  await page
    .getByRole("list", { name: "Your Environments" })
    .getByRole("link", { name: /^e2e/ })
    .getByText("Pod farm", { exact: true })
    .waitFor();

  await openEnvironment("e2e");

  await page
    .getByText(/^Its runners come from Pod farm: the server starts one/)
    .waitFor();

  await page.getByRole("heading", { name: "Runners" }).waitFor();
  await page.unroute(environments);
});

test("adds an Environment from a runner template whose name has a space, in setup", async () => {
  const template = (await (
    await fetch(new URL("/api/environment-templates", server.url), {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "Pod kit" }),
    })
  ).json()) as { readonly id: string };

  const templates = /\/api\/environment-templates(\?.*)?$/;

  await page.route(templates, async (route) => {
    const real = (await (await route.fetch()).json()) as { id: string }[];

    await route.fulfill({
      json: real.map((each) =>
        each.id === template.id
          ? {
              ...each,
              runnersFrom: { plugin: "pods", label: "Pod farm", icon: "cloud" },
            }
          : each,
      ),
    });
  });

  await page.goto(`${server.url.href}#get-started/where`);
  await page.getByRole("checkbox", { name: /^Pod farm/ }).click();

  const made = async (): Promise<readonly Environment[]> =>
    (
      (await (
        await fetch(new URL("/api/environments", server.url), {
          headers: { cookie },
        })
      ).json()) as Environment[]
    ).filter(({ templateId }) => templateId === template.id);

  const added = await until(made, (each) => each.length > 0);

  expect(added).toHaveLength(1);
  expect(await page.getByText("Couldn't add it.").count()).toBe(0);

  for (const { id } of added) {
    await fetch(new URL(`/api/environments/${id}`, server.url), {
      method: "DELETE",
      headers: { cookie },
    });
  }

  await fetch(
    new URL(`/api/environment-templates/${template.id}`, server.url),
    { method: "DELETE", headers: { cookie } },
  );

  await page.unroute(templates);
}, 30_000);

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

  await page.goto(`${server.url.href}#settings/profiles/${profile.id}`);

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

  await editor.getByRole("button", { name: "Delete" }).click();
  await confirmIn("Delete");

  await page
    .getByRole("link", { name: "Tools" })
    .waitFor({ state: "detached" });
});

test("builds a Profile on another, over My defaults", async () => {
  await page.goto(server.url.href);
  await openSettings("Profiles");

  const profiles = page.getByRole("navigation", { name: "Profiles" });
  await profiles.getByRole("link", { name: "My defaults" }).click();

  const profilesPage = page.locator("#profiles-page");
  const packages = page.getByRole("list", { name: "Packages", exact: true });

  await profilesPage.getByRole("button", { name: "Add package" }).click();
  await profilesPage.getByLabel("Package source").fill("npm:my-provider");
  await profilesPage.getByRole("button", { name: "Add", exact: true }).click();
  await packages.getByRole("switch", { name: "npm:my-provider" }).waitFor();
  await page.reload();
  await packages.getByText("npm:my-provider").first().waitFor();

  // A package nobody can install would stop every later Session.
  await packages
    .getByRole("button", { name: "Remove npm:my-provider" })
    .click();

  await packages
    .getByRole("switch", { name: "npm:my-provider" })
    .waitFor({ state: "detached" });

  const editor = page.locator("#profiles-page form").first();

  await page.getByRole("link", { name: "New Profile" }).click();
  await editor.getByLabel("Name").fill("Deep");
  await editor.getByLabel("What it's for").fill("Long research tasks");
  await editor.getByRole("button", { name: "Builds on" }).click();
  await page.getByRole("option", { name: "Default" }).click();
  await editor.getByRole("button", { name: "Create Profile" }).click();
  await profiles.getByRole("link", { name: "Deep" }).waitFor();
  await page.reload();

  expect(
    await page.getByRole("button", { name: "Builds on" }).textContent(),
  ).toContain("Default");

  expect(await editor.getByLabel("What it's for").inputValue()).toBe(
    "Long research tasks",
  );

  await editor.getByRole("button", { name: "Delete" }).click();
  await confirmIn("Delete");

  await profiles
    .getByRole("link", { name: "Deep" })
    .waitFor({ state: "detached" });
});

test("shows what a Profile inherits and turns a Server base skill off in it", async () => {
  const base = join(root, "config", "base");

  await mkdir(join(base, "skills", "cluster"), { recursive: true });

  await writeFile(
    join(base, "skills", "cluster", "SKILL.md"),
    "---\nname: cluster\ndescription: Debug our cluster\n---\n",
  );

  await writeFile(join(base, "AGENTS.md"), "# Working at ACME\nNever push.");

  await page.goto(server.url.href);
  await openSettings("Profiles");

  const profiles = page.getByRole("navigation", { name: "Profiles" });
  await profiles.getByRole("link", { name: /^Default/ }).click();

  const skills = page.getByRole("list", { name: "Skills" });
  const cluster = skills.getByRole("switch", { name: "cluster in Default" });

  await cluster.waitFor();
  await skills.getByText("Server base").first().waitFor();

  await page
    .getByRole("list", { name: "Instructions" })
    .getByText("Working at ACME")
    .waitFor();

  await cluster.click();

  await skills
    .getByRole("switch", { name: "cluster in Default", checked: false })
    .waitFor();

  const meta = JSON.parse(
    await readFile(
      join(root, "config", "profiles", "default", "profile.json"),
      "utf8",
    ),
  ) as { off?: unknown };

  expect(meta.off).toEqual(["skills/cluster"]);

  await page.getByRole("button", { name: "Preview what Pi gets" }).click();

  const preview = page.getByRole("dialog", {
    name: "What Pi gets with Default",
  });

  const files = preview.getByRole("list", { name: "Files" });

  await files.getByRole("button", { name: /AGENTS\.md/ }).click();
  await preview.getByText("Never push.").waitFor();
  await files.getByText("Off in Default").waitFor();
  expect(await files.getByRole("button", { name: /cluster/ }).count()).toBe(0);

  expect(
    await preview
      .getByRole("link", { name: "Download .tar.gz" })
      .getAttribute("href"),
  ).toBe("/api/profiles/default/archive?stacked=true");

  await preview.getByRole("button", { name: "Done" }).click();
  await preview.waitFor({ state: "detached" });

  await skills.getByRole("button", { name: "More for cluster" }).click();

  await page.getByRole("menuitem", { name: /Turn back on in Default/ }).click();

  await skills
    .getByRole("switch", { name: "cluster in Default", checked: true })
    .waitFor();

  await skills.getByRole("button", { name: "More for cluster" }).click();

  await page
    .getByRole("menuitem", { name: /Copy into Default to change it/ })
    .click();

  await skills.getByText("Default's copy").waitFor();
  await skills.getByRole("button", { name: "More for cluster" }).click();

  await page.getByRole("menuitem", { name: /Use Server base's again/ }).click();

  await skills
    .getByRole("switch", { name: "cluster in Default", checked: true })
    .waitFor();

  const defaults = page.getByRole("list", { name: "Defaults" });

  await defaults.getByRole("button", { name: "Thinking for Default" }).click();

  await page.getByRole("option", { name: "high", exact: true }).click();
  await defaults.getByText("high", { exact: true }).waitFor();

  const settings = JSON.parse(
    await readFile(
      join(root, "config", "profiles", "default", "settings.json"),
      "utf8",
    ),
  ) as Record<string, unknown>;

  expect(settings["defaultThinkingLevel"]).toBe("high");
  await defaults.getByRole("button", { name: "Reset" }).click();
  await defaults.getByText("Pi's own default").first().waitFor();

  await profiles.getByRole("link", { name: "Server base" }).first().click();
  await skills.getByRole("switch", { name: "cluster", exact: true }).waitFor();

  await page
    .getByText("Every Session on this server, personal and team")
    .waitFor();

  await page
    .getByRole("heading", { name: "Shared keys" })
    .or(page.getByText("Shared keys", { exact: true }))
    .first()
    .waitFor();

  await rm(base, { recursive: true, force: true });
});

test("shows a Profile's own version of a package in place of the inherited one", async () => {
  const base = join(root, "config", "base");

  await mkdir(base, { recursive: true });

  await writeFile(
    join(base, "settings.json"),
    JSON.stringify({ packages: ["npm:pi-subagents@1.4.2"] }),
  );

  await page.goto(server.url.href);
  await openSettings("Profiles");

  await page
    .getByRole("navigation", { name: "Profiles" })
    .getByRole("link", { name: /^Default/ })
    .click();

  const packages = page.getByRole("list", { name: "Packages" });

  await packages
    .getByRole("switch", { name: "package:npm:pi-subagents in Default" })
    .waitFor();

  await page.getByRole("button", { name: "Add package" }).click();
  await page.getByLabel("Package source").fill("npm:pi-subagents@1.5.0");
  await page.getByRole("button", { name: "Add", exact: true }).click();

  await packages
    .getByText(
      "npm:pi-subagents@1.5.0 · replaces npm:pi-subagents@1.4.2 from Server base",
    )
    .waitFor();

  expect(
    await packages
      .getByRole("switch", { name: "package:npm:pi-subagents in Default" })
      .count(),
  ).toBe(0);

  await packages
    .getByRole("button", { name: "Remove npm:pi-subagents@1.5.0" })
    .click();

  await packages
    .getByRole("switch", { name: "package:npm:pi-subagents in Default" })
    .waitFor();

  await rm(join(base, "settings.json"), { force: true });
});

test("lists a Profile's agents and workflows with inherited ones and edits them", async () => {
  const base = join(root, "config", "base");
  const own = join(root, "config", "profiles", "default");

  await mkdir(join(base, "agents"), { recursive: true });
  await mkdir(join(base, "workflows"), { recursive: true });
  await mkdir(join(base, "skills", "review"), { recursive: true });

  await writeFile(
    join(base, "agents", "triager.md"),
    "---\ndescription: Labels new issues\n---\n\nLabel it.\n",
  );

  await writeFile(
    join(base, "workflows", "triage.js"),
    '// Triages, then fixes.\nawait runs.run({ agent: "triager", task: args.task });\n',
  );

  await writeFile(
    join(base, "skills", "review", "SKILL.md"),
    "---\nname: review\ndescription: Reviews code\n---\n",
  );

  await page.goto(server.url.href);
  await openSettings("Profiles");

  await page
    .getByRole("navigation", { name: "Profiles" })
    .getByRole("link", { name: /^Default/ })
    .click();

  const agents = page.getByRole("list", { name: "Agents", exact: true });
  const workflows = page.getByRole("list", { name: "Workflows" });

  await agents.getByText("Labels new issues").waitFor();
  await agents.getByText("Server base").waitFor();
  await workflows.getByText("Triages, then fixes.").waitFor();

  await agents.getByRole("switch", { name: "triager in Default" }).click();

  await agents
    .getByRole("switch", { name: "triager in Default", checked: false })
    .waitFor();

  await workflows.getByRole("switch", { name: "triage in Default" }).click();

  await workflows
    .getByRole("switch", { name: "triage in Default", checked: false })
    .waitFor();

  const meta = JSON.parse(
    await readFile(join(own, "profile.json"), "utf8"),
  ) as { off?: unknown };

  expect(meta.off).toEqual(["agents/triager.md", "workflows/triage.js"]);

  await page.getByRole("button", { name: "Add agent" }).click();
  await page.getByLabel("New agent's name").fill("fixer");
  await page.getByRole("button", { name: "Add", exact: true }).click();

  const agent = page.getByRole("group", { name: "Agent fixer" });

  await agent.getByLabel("Description").fill("Fixes bugs: small ones");
  await agent.getByRole("textbox", { name: /^Model/ }).fill("faux/faux-1");
  await agent.getByLabel("Thinking level").selectOption("high");
  await agent.getByLabel("Add to Tools").fill("mcp__jira__search");
  await agent.getByLabel("Add to Tools").press("Enter");
  await agent.getByRole("checkbox", { name: "review" }).check();
  await agent.getByLabel("Prompt").fill("Fix the bug.");
  await page.getByRole("button", { name: "Save agent" }).click();
  await agents.getByRole("button", { name: /^fixer/ }).waitFor();

  expect(await readFile(join(own, "agents", "fixer.md"), "utf8")).toBe(
    '---\nname: fixer\ndescription: "Fixes bugs: small ones"\nmodel: faux/faux-1\nthinking: high\ntools: mcp__jira__search\nskills: review\n---\n\nFix the bug.\n',
  );

  await page.getByRole("button", { name: "Add workflow" }).click();
  await page.getByLabel("New workflow's name").fill("fix-loop");
  await page.getByRole("button", { name: "Add", exact: true }).click();

  const workflow = page.getByRole("group", { name: "Workflow fix-loop" });

  await workflow
    .getByLabel("Script")
    .fill(
      '// Fixes until reviewed.\nawait runs.run({ agent: "fixer", task: args.task });\nawait runs.run({ agent: "ghost", task: "?" });\n',
    );

  const started = page.getByRole("list", { name: "Agents it starts" });

  await started.getByText("fixer").waitFor();
  await started.getByText("not in this Profile").waitFor();
  expect(await started.getByRole("listitem").count()).toBe(2);

  await page.getByRole("button", { name: "Save workflow" }).click();
  await workflows.getByText("Fixes until reviewed.").waitFor();

  expect(
    await readFile(join(own, "workflows", "fix-loop.js"), "utf8"),
  ).toContain('agent: "ghost"');

  await agents.getByRole("button", { name: /^fixer/ }).click();
  await page.getByRole("button", { name: "Delete agent" }).click();
  await confirmIn("Delete agent");

  await agents
    .getByRole("button", { name: /^fixer/ })
    .waitFor({ state: "detached" });

  await agents.getByRole("switch", { name: "triager in Default" }).click();
  await workflows.getByRole("switch", { name: "triage in Default" }).click();

  await workflows
    .getByRole("switch", { name: "triage in Default", checked: true })
    .waitFor();

  await rm(base, { recursive: true, force: true });
  await rm(join(own, "workflows"), { recursive: true, force: true });
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
                {
                  value: "s",
                  label: "Small",
                  description:
                    "Cheap. Fits a side project that runs a few jobs a day, can wait for a slow build now and then, and should cost as little as it can.",
                },
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

  await page
    .locator("#sessions")
    .getByText(/ · needs you · /)
    .waitFor();

  await page
    .locator('#chat li[data-role="assistant"]', {
      hasText: "Two quick questions.",
    })
    .waitFor();

  await card.getByRole("button", { name: "Explain this question" }).waitFor();

  const wide = page.viewportSize();
  await page.setViewportSize({ width: 700, height: 900 });
  await card.locator("li", { hasText: "Small" }).hover();
  const small = await card.boundingBox();
  await card.locator("li", { hasText: "Large" }).hover();
  expect(await card.boundingBox()).toEqual(small);
  await page.setViewportSize(wide ?? { width: 1280, height: 720 });

  await card.getByLabel("Large").check();

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
    .getByText(/ · needs you · /)
    .waitFor({ state: "detached" });

  await page
    .locator('#chat li[data-role="card"]', { hasText: "Which size?" })
    .getByText("Size: Large")
    .waitFor();

  await page
    .locator('#chat [data-role="answer-meta"]', { hasText: "faux-1" })
    .getByText("just now")
    .waitFor();
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

  await page.goto(`${server.url.href}#plugin/routines`);
  await page.getByRole("link", { name: /^Issue to pull request/ }).click();

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
      when: [
        { kind: "schedule", cron: "0 8 * * 1-5", timeZone: "Europe/Berlin" },
      ],
      do: {
        kind: "session",
        prompt: "Summarise the new issues.",
        workspace: { kind: "folder", path: root },
      },
    }),
  );

  await page.getByRole("button", { name: "Save" }).click();
  await page.getByRole("heading", { name: "Summarise new issues" }).waitFor();
  await page.getByText(/^Next run /).waitFor();

  await page.getByRole("button", { name: "Run now" }).click();

  const run = page
    .getByRole("table", { name: "Runs" })
    .getByRole("row")
    .filter({ hasText: "three new issues" });

  await run.getByText("Done").waitFor();
  await run.getByRole("link", { name: /Run now/ }).click();

  await page
    .locator('#chat li[data-role="assistant"]', { hasText: "three new issues" })
    .waitFor();
}, 30_000);

test("runs a routine by hand with the inputs its form asks for", async () => {
  faux.setResponses([
    fauxAssistantMessage(
      [fauxToolCall("end_run", { result: "done", summary: "looked" })],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage([fauxText("looked")]),
  ]);

  await page.goto(`${server.url.href}#plugin/routines/new`);
  await page.getByRole("button", { name: "Write JSON" }).click();
  await page.getByLabel("Name").fill("look-at");

  await page.getByLabel("Routine JSON").fill(
    JSON.stringify({
      title: "Look at something",
      when: [{ kind: "webhook" }],
      inputs: {
        focus: { type: "string", required: true },
        mode: { type: "oneOf", values: ["fast", "slow"], default: "fast" },
      },
      do: {
        kind: "session",
        prompt: "Look at {{inputs.focus}}, {{inputs.mode}}.",
        workspace: { kind: "folder", path: root },
      },
    }),
  );

  await page.getByRole("button", { name: "Save" }).click();
  await page.getByRole("heading", { name: "Look at something" }).waitFor();
  await page.getByRole("button", { name: "Run now" }).click();

  const form = page.getByRole("form", { name: "Run with inputs" });
  await form.getByLabel("focus").fill("the docs");
  await form.getByLabel("mode").selectOption("slow");
  await form.getByRole("button", { name: "Run" }).click();

  await page
    .getByRole("table", { name: "Runs" })
    .getByRole("link", { name: /Run now/ })
    .click();

  await page
    .locator('#chat li[data-role="user"]', {
      hasText: "Look at the docs, slow.",
    })
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

  await page
    .locator('#chat li[data-role="answer-meta"]')
    .getByText(/^Worked for/)
    .waitFor();

  expect(await work.locator("summary").first().textContent()).toContain(
    "Ran 1 command",
  );
}, 30_000);

test("keeps what Pi says between steps in the chat, in the order it said it", async () => {
  faux.setResponses([
    fauxAssistantMessage(
      [
        fauxText("Looking at the folder first."),
        fauxToolCall("bash", { command: "ls" }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      [
        fauxText("Found it, now the tests."),
        fauxToolCall("bash", { command: "true" }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage([fauxText("All good.")]),
  ]);

  await page.goto(server.url.href);

  await page.getByRole("button", { name: "New session" }).click();
  const form = page.locator("form#create");

  await pickWorkspace(form, root);
  await form.getByRole("button", { name: "Start session" }).click();
  await page.locator("#status", { hasText: "idle" }).waitFor();

  await page.locator("#prompt-text").fill("check");
  await page.locator("#prompt-text").press("Enter");

  await page
    .locator('#chat li[data-role="answer-meta"]')
    .getByText(/^Worked for/)
    .waitFor();

  expect(
    await page
      .locator(
        '#chat li[data-role="assistant"], #chat li[data-role="work"] > details > summary',
      )
      .allInnerTexts(),
  ).toEqual([
    "Looking at the folder first.",
    "Ran 1 command",
    "Found it, now the tests.",
    "Ran 1 command",
    "All good.",
  ]);
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

  await page
    .locator('#chat li[data-role="answer-meta"]')
    .getByText(/^Worked for/)
    .waitFor();

  expect(await work.locator("summary").first().textContent()).toContain(
    "Ran 1 command",
  );

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

test("sends a new Project's first message and preselected Profile, and keeps the dialog open on a refusal", async () => {
  const asked: unknown[] = [];

  await page.route("**/api/ext/projects/projects", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();

      return;
    }

    asked.push(route.request().postDataJSON());

    await route.fulfill({
      status: 400,
      json: { error: "bad_request", message: "not this time" },
    });
  });

  await page.goto(`${server.url.href}#plugin/projects/all`);
  await page.getByRole("button", { name: "New Project" }).click();

  const dialog = page.getByRole("dialog", { name: "New Project" });

  await dialog.getByLabel("Name").fill("Docs");
  await dialog.getByRole("button", { name: "Repositories" }).click();
  const search = dialog.getByRole("combobox", { name: "Repositories" });
  await search.fill("https://example.com/docs.git");
  await search.press("Enter");
  await search.press("Escape");

  await dialog
    .getByLabel("First message to the coordinator")
    .fill("Check every README.");

  await dialog.getByRole("button", { name: "Create Project" }).click();
  await dialog.getByText("not this time").waitFor();
  await page.unroute("**/api/ext/projects/projects");

  expect(asked).toMatchObject([
    {
      name: "Docs",
      repositories: ["https://example.com/docs.git"],
      firstMessage: "Check every README.",
    },
  ]);

  await dialog.getByRole("button", { name: "Cancel" }).click();
  await dialog.waitFor({ state: "hidden" });
});

test("creates a Project and shares a file through its folder", async () => {
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

  await page.getByRole("button", { name: "New Project" }).click();

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
  ]);

  await page.locator("#prompt-text").fill("start a docs thread");
  await page.locator("#prompt-text").press("Enter");

  await page
    .locator('#chat li[data-role="assistant"]')
    .getByText(/^ok$/)
    .first()
    .waitFor();

  const card = page.locator('#chat [aria-label="Thread Docs"]');
  await card.getByRole("link", { name: "Open Docs fullscreen" }).waitFor();
  expect(await page.locator("#chat").getByText("start_thread").count()).toBe(0);

  // A thread's row moves between groups as its run state changes, so the
  // menu opens once it has settled as idle.
  const row = rail
    .getByRole("region", { name: "Idle" })
    .getByRole("listitem", { name: "Docs" });

  await row.getByText(/^e2e · /).waitFor();
  await row.getByRole("button", { name: "Actions for Docs" }).click();

  await page.getByRole("menuitemradio", { name: "Ready for review" }).click();

  const review = rail
    .getByRole("region", { name: "Review" })
    .getByRole("listitem", { name: "Docs" });

  await review.waitFor();
  expect(await rail.getByRole("region", { name: "Needs you" }).count()).toBe(0);

  // The thread takes a scripted reply that later tests would otherwise lose
  // to it.
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

  while (faux.state.callCount < calls + 3) {
    await Bun.sleep(20);
  }

  faux.setResponses([
    fauxAssistantMessage([fauxText(`See [Docs](thread:${threadId}).`)]),
  ]);

  await page.locator("#prompt-text").fill("where are the docs?");
  await page.locator("#prompt-text").press("Enter");

  const chip = page
    .locator('#chat li[data-role="assistant"]')
    .getByRole("link", { name: /^Docs/ });

  await chip.getByText("Ready for review").waitFor();

  // The thread's finished turn reached the coordinator as context, with no
  // turn of its own.
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

  expect(faux.state.callCount).toBe(calls + 4);
  await chip.click();
  await side.waitFor();
  await side.getByRole("button", { name: "Back to threads" }).click();

  await page.getByRole("button", { name: "Project folder" }).click();

  await page.getByText("No files here yet.").waitFor();

  await page.getByLabel("Upload files").setInputFiles({
    name: "brief.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("the brief\n"),
  });

  await page.getByRole("link", { name: "brief.txt" }).first().waitFor();

  await page
    .getByRole("list", { name: "Recent writes" })
    .getByText(/^wrote brief\.txt \(10 B\)$/)
    .waitFor();

  const nav = page.locator("#project-nav").getByRole("link", { name: /^Site/ });
  await nav.click();
  await page.getByRole("button", { name: "Session actions" }).click();
  await page.getByRole("menuitem", { name: "Archive" }).click();
  await page.locator("#status", { hasText: "archived" }).waitFor();
  await nav.waitFor({ state: "detached" });

  await rail
    .getByRole("listitem", { name: "Docs" })
    .getByText("Archived", { exact: true })
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
    .getByText("Archived", { exact: true })
    .waitFor({ state: "detached" });

  await settings.getByRole("button", { name: "Archive Project" }).click();
  await confirmIn("Archive");
  await nav.waitFor({ state: "detached" });
}, 30_000);

test("shows a Project made elsewhere on the open Projects page", async () => {
  let made = false;
  const { promise: listed, resolve: list } = Promise.withResolvers();

  await page.route("**/api/ext/projects/projects", async (route) =>
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
  await page.unroute("**/api/ext/projects/projects");
});

test("opens team Projects in the team's area, wherever the link came from", async () => {
  const summary = {
    id: "teamwork",
    name: "Concur Infra Automation",
    coordinatorId: "coordinator",
    threads: 0,
    needsYou: 0,
    repositories: 1,
    coordinatorState: "idle",
    team: true,
  };

  await page.route("**/api/ext/projects/projects", async (route) =>
    route.fulfill({ json: [] }),
  );

  await page.route("**/api/ext/projects/team/projects", async (route) =>
    route.fulfill({ json: [summary] }),
  );

  await page.route("**/api/ext/projects/projects/teamwork", async (route) =>
    route.fulfill({
      json: {
        ...summary,
        goal: "",
        instructions: "",
        repositories: ["https://git.example.com/infra.git"],
        environmentId: null,
        profileId: null,
        threadModel: null,
        assistant: false,
        formerCoordinators: [],
        threads: [],
        memory: [],
      },
    }),
  );

  await page.goto(`${server.url.href}#plugin/projects/all`);
  await page.reload();

  const pluginPage = page.locator("#plugin-page");

  await pluginPage.getByText("No Projects yet.").waitFor();

  expect(
    await pluginPage
      .getByRole("button", { name: /^Concur Infra Automation/ })
      .count(),
  ).toBe(0);

  await pluginPage.getByRole("link", { name: /^1 team Project/ }).click();
  await page.waitForURL("**/#team/plugin/projects/projects/all");
  await page.getByRole("heading", { name: "Team Projects" }).waitFor();

  await page
    .getByRole("navigation", { name: "Team" })
    .getByRole("region", { name: "Active Projects" })
    .getByRole("link", { name: /^Concur Infra Automation/ })
    .waitFor();

  await page
    .getByRole("navigation", { name: "Team" })
    .getByRole("link", { name: /^Projects\s*1$/ })
    .waitFor();

  await page.getByRole("button", { name: /^Concur Infra Automation/ }).click();

  await page.waitForURL("**/#team/plugin/projects/projects/teamwork");

  await page.goto(`${server.url.href}#plugin/projects/teamwork/settings`);
  await page.waitForURL("**/#team/plugin/projects/projects/teamwork/settings");

  await page.unroute("**/api/ext/projects/projects/teamwork");
  await page.unroute("**/api/ext/projects/team/projects");
  await page.unroute("**/api/ext/projects/projects");
});

test("shows a plugin page's failure without taking the app down", async () => {
  await page.route("**/api/ext/projects/projects", async (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({
        error: "internal",
        message: "projects store is unreadable",
      }),
    }),
  );

  // The failing list takes the sidebar's Project links with it.
  await page.goto(server.url.href);
  await page.goto(new URL("#plugin/projects/all", server.url).href);

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

  await page.unroute("**/api/ext/projects/projects");
  await pluginPage.getByRole("button", { name: "Try again" }).click();
  await page.getByRole("button", { name: "New Project" }).waitFor();
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

  await page.route("**/api/ext/projects/projects", async (route) => {
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
  await page.unroute("**/api/ext/projects/projects");
});

test("attaches an image to a message and shows it in the chat", async () => {
  faux.setResponses([fauxAssistantMessage([fauxText("a tiny pixel")])]);
  await page.goto(server.url.href);

  await page.getByRole("button", { name: "New session" }).click();
  const form = page.locator("form#create");

  await pickWorkspace(form, root);
  await form.getByRole("button", { name: "Start session" }).click();
  await page.locator("#status", { hasText: "idle" }).waitFor();

  await page.getByLabel("Attach files").setInputFiles({
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
  const reasoning = composer.getByRole("group", { name: "Reasoning" });

  await model.filter({ hasText: "faux-1" }).waitFor();
  await model.click();
  expect(await reasoning.count()).toBe(0);

  await composer
    .getByRole("option", { name: "faux-deep", exact: true })
    .click();

  await model.click();
  await reasoning.getByRole("button", { name: "high", exact: true }).click();
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

test("an admin hides a model on the Models page, and the composer's menu leaves it out", async () => {
  await page.goto(server.url.href);
  await openSettings("Models");

  const providers = page.getByRole("list", {
    name: "Providers in the model picker",
  });

  await providers.getByRole("button", { name: "Choose faux models" }).click();

  await page
    .getByRole("group", { name: "faux models" })
    .getByLabel("faux-deep")
    .uncheck();

  await providers.getByText("1 of 2 shown").waitFor();

  await page.goto(server.url.href);
  await page.getByRole("button", { name: "New session" }).click();
  const form = page.locator("form#create");

  await pickWorkspace(form, root);
  await form.getByRole("button", { name: "Start session" }).click();
  await page.locator("#status", { hasText: "idle" }).waitFor();

  const composer = page.locator("form#prompt");
  const model = composer.getByRole("button", { name: "Model" });

  await model.filter({ hasText: "faux-1" }).waitFor();
  await model.click();
  await composer.getByRole("option", { name: "faux-1", exact: true }).waitFor();

  expect(
    await composer
      .getByRole("option", { name: "faux-deep", exact: true })
      .count(),
  ).toBe(0);

  await page.keyboard.press("Escape");
  await openSettings("Models");
  await providers.getByRole("button", { name: "Choose faux models" }).click();

  await page
    .getByRole("group", { name: "faux models" })
    .getByLabel("faux-deep")
    .check();

  await providers.getByText("2 of 2 shown").waitFor();
}, 30_000);

test("lists one provider's models at a time in the composer's model menu, and keeps recent ones for the person", async () => {
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

  const rail = (name: RegExp) =>
    composer.getByRole("group", { name: "Providers" }).getByRole("button", {
      name,
    });

  await model.filter({ hasText: "faux-1" }).waitFor();
  await model.click();

  await option("faux-deep").waitFor();
  expect(await option("wide-1").count()).toBe(0);
  await rail(/^Wide\s*8$/).waitFor();

  await search.fill("wide 3");

  expect(await composer.getByRole("option").count()).toBe(1);
  await option("wide-3").waitFor();

  await search.fill("");
  await rail(/^Wide/).click();
  await option("wide-2").click();
  await model.filter({ hasText: "wide-2" }).waitFor();

  await model.click();
  await rail(/^Recent/).click();

  expect(
    await composer.getByRole("option").first().getAttribute("aria-label"),
  ).toBe("wide-2");

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

  await form
    .getByRole("group", { name: "Reasoning" })
    .getByRole("button", { name: "high", exact: true })
    .click();

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

  await composer
    .getByRole("group", { name: "Providers" })
    .getByRole("button", { name: /^OpenAI/ })
    .waitFor();

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

test("opens an artifact Pi published, in a sandbox, from its card in the chat", async () => {
  const folder = join(root, "artifact");
  await mkdir(folder, { recursive: true });

  await writeFile(
    join(folder, "report.html"),
    "<h1>Quarterly report</h1><script>document.body.append(String(window.origin))</script><button onclick=\"parent.postMessage({ pipoca: 'draft', text: 'Make the chart blue' }, '*')\">Ask Pi</button>",
  );

  faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall("publish_artifact", {
          path: "report.html",
          title: "Quarterly report",
        }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage([fauxText("Published the report")]),
  ]);

  await page.goto(server.url.href);
  await page.getByRole("button", { name: "New session" }).click();
  const form = page.locator("form#create");

  await pickWorkspace(form, folder);
  await form.getByRole("button", { name: "Start session" }).click();
  await page.locator("#status", { hasText: "idle" }).waitFor();

  const box = page.locator("#prompt-text");
  await box.fill("write the report");
  await box.press("Enter");
  await page.getByText("Published the report").waitFor();

  const card = page.getByLabel("Artifact Quarterly report");
  await card.getByText("Version 1").waitFor();
  await card.getByRole("link", { name: "Open" }).click();

  const frame = page.frameLocator(
    'iframe[title="Quarterly report, version 1"]',
  );

  await frame.getByRole("heading", { name: "Quarterly report" }).waitFor();
  await frame.getByText("null").waitFor();

  faux.setResponses([fauxAssistantMessage([fauxText("Noted the comment")])]);

  await page
    .getByRole("group", { name: "Beside the artifact" })
    .getByRole("button", { name: "Comments 0" })
    .click();

  const comment = page.getByRole("form", { name: "Comment" });

  await comment.getByRole("textbox", { name: "Comment" }).fill("Add Q4");
  await comment.getByRole("button", { name: "Comment" }).click();

  await page
    .getByRole("list", { name: "Comments" })
    .getByText("Add Q4")
    .waitFor();

  await frame.getByRole("button", { name: "Ask Pi" }).click();

  await page
    .getByText(/commented on version 1 of the artifact “Quarterly report”/)
    .waitFor();

  await page.getByText("Noted the comment").waitFor();

  expect(await page.locator("#prompt-text").inputValue()).toBe(
    "Make the chart blue",
  );
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

  await context.request.post(`${site}/api/auth/session`, {
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
  const tabs = page.getByRole("navigation", { name: "Integrations" });
  await tabs.getByRole("link", { name: "Email" }).click();
  await tabs.locator('a[aria-current="page"]', { hasText: "Email" }).waitFor();
  await page.getByRole("button", { name: "Add a mailbox" }).waitFor();
  await page.getByLabel("Seconds between mail checks").waitFor();

  await tabs.getByRole("link", { name: "Slack" }).click();
  await page.getByRole("button", { name: "Add a Slack bot" }).waitFor();

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

test("turns on push notifications before this browser has a service worker", async () => {
  const origin = new URL(server.url).origin;

  const context = await browser.newContext();
  await context.addCookies(await page.context().cookies());

  // Headless Chromium has no push service and denies notifications, so the
  // browser's side is faked. Like a real browser, subscribing fails until
  // the service worker is active.
  await context.addInitScript(`
    const owners = new WeakMap();
    const pushManager = Object.getOwnPropertyDescriptor(ServiceWorkerRegistration.prototype, "pushManager");
    Object.defineProperty(ServiceWorkerRegistration.prototype, "pushManager", {
      get() {
        const manager = pushManager.get.call(this);
        owners.set(manager, this);
        return manager;
      },
    });
    let subscription = null;
    PushManager.prototype.getSubscription = async () => subscription;
    PushManager.prototype.subscribe = async function () {
      if (owners.get(this)?.active == null) {
        throw new DOMException("Subscription failed - no active Service Worker", "AbortError");
      }
      const endpoint = "https://fcm.googleapis.com/fcm/send/e2e-device";
      subscription = {
        endpoint,
        toJSON: () => ({ endpoint, keys: { p256dh: "key", auth: "auth" } }),
        unsubscribe: async () => { subscription = null; return true; },
      };
      return subscription;
    };
    Object.defineProperty(Notification, "permission", { get: () => "granted" });
    Notification.requestPermission = async () => "granted";
  `);

  const tab = await context.newPage();
  tab.setDefaultTimeout(10_000);
  await tab.goto(origin);
  await tab.getByRole("button", { name: "Account" }).click();
  await tab.getByRole("menuitem", { name: "Settings" }).click();

  await tab
    .getByRole("navigation", { name: "Settings" })
    .getByRole("link", { name: "Notifications", exact: true })
    .click();

  await tab.getByRole("button", { name: "Turn on for this device" }).click();
  await tab.getByRole("button", { name: "Turn off on this device" }).waitFor();

  await tab.getByRole("button", { name: "Turn off on this device" }).click();
  await tab.getByRole("button", { name: "Turn on for this device" }).waitFor();

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

  const handed = tab.waitForResponse("**/api/auth/app-links");
  await tab.getByRole("button", { name: "Open Pipoca" }).click();
  const { link } = (await (await handed).json()) as { link: string };
  const token = new URL(link).searchParams.get("link") ?? "";

  await tab.getByRole("heading", { name: "Pipoca is open" }).waitFor();

  const app = new URL(`/api/auth/links/${token}`, server.url);
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

  const environment = (await post("/api/environments", {
    name: "team-pods",
    team: true,
  })) as Environment;

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
  await switchWorkspace(/^Team/);

  const running = page.locator("section").filter({ hasText: "Running now" });

  await running.getByRole("link", { name: "release-notes" }).waitFor();

  const teamNav = page.getByRole("navigation", { name: "Team" });

  await teamNav
    .locator("#team-sessions")
    .getByRole("link", { name: /release-notes/ })
    .filter({ hasText: /^.*You · / })
    .waitFor();

  expect(
    await teamNav
      .locator("#team-sessions")
      .getByText(/^(Offline|Working)$/)
      .count(),
  ).toBe(0);

  await teamNav.getByText(/^\d+ here now$/).waitFor();

  await page
    .getByRole("navigation", { name: "Team" })
    .getByRole("link", { name: /^Sessions\s*1$/ })
    .click();

  await page.getByRole("heading", { name: "Sessions" }).waitFor();

  await page
    .getByRole("navigation", { name: "Team" })
    .getByRole("link", { name: "Team assistant" })
    .click();

  await page.getByRole("heading", { name: "Team assistant" }).waitFor();
  await page.getByLabel("Ask the Pipoca assistant").waitFor();

  await page
    .getByRole("navigation", { name: "Team" })
    .getByRole("link", { name: "Sessions" })
    .click();

  await page.getByRole("link", { name: "release-notes", exact: true }).click();

  await page.waitForURL("**/#team/sessions/*");

  await page.goto(server.url.href);

  const own = page.locator("#sessions");

  await own.waitFor();

  expect(await own.getByText("release-notes").count()).toBe(0);

  const docs = join(root, "team-docs");

  await mkdir(docs, { recursive: true });
  await page.goto(new URL("/#team", server.url).href);
  await page.getByRole("button", { name: "Start team work" }).click();

  const form = page.getByRole("dialog", { name: "Start team work" });
  const whose = form.getByRole("group", { name: "Whose work" });

  await whose
    .getByRole("button", { name: "The team", pressed: true })
    .waitFor();

  await whose.getByRole("button", { name: "Just me" }).click();

  await page
    .getByRole("dialog", { name: "New session" })
    .getByRole("group", { name: "Whose work" })
    .getByRole("button", { name: "The team" })
    .click();

  await form.getByRole("button", { name: "Profile" }).click();

  await form
    .getByRole("listbox", { name: "Profile" })
    .getByText("Team Profiles, set up by admins")
    .waitFor();

  await page.keyboard.press("Escape");
  await form.getByRole("button", { name: "Folder or repository" }).click();

  const search = form.getByRole("combobox", { name: "Folder or repository" });

  await search.fill(docs);
  await form.getByRole("option", { name: `Use ${docs}` }).click();
  await search.press("Escape");
  await form.getByLabel("What should Pi do?").fill("Write the release notes");

  await form
    .getByRole("button", { name: "Who steers" })
    .getByText("Team can steer")
    .waitFor();

  await form.getByRole("button", { name: "Start", exact: true }).click();
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

  const sendTo = page.getByRole("group", { name: "Send to" });

  await sendTo.getByRole("button", { name: "To the team" }).click();
  await page.locator("#prompt-text").fill("Ship it today?");
  await page.locator("#prompt-text").press("Enter");

  const said = page.locator('[data-role="team"]', {
    hasText: "Ship it today?",
  });

  await said.getByText("Pi didn't answer").waitFor();
  await said.getByRole("button", { name: "Reply" }).click();
  await sendTo.getByRole("button", { name: "Off the record" }).click();
  await page.locator("#prompt-text").fill("Check the release first");
  await page.locator("#prompt-text").press("Enter");

  const aside = page.locator('[data-role="team"]', {
    hasText: "Check the release first",
  });

  await aside.getByText("Hidden from Pi, visible to the team").waitFor();
  await aside.getByText("Ship it today?").waitFor();

  await page.locator("header").getByRole("button", { name: "Vote" }).click();

  const opening = page.getByRole("dialog", { name: "Open a vote" });

  await opening.getByLabel("Question").fill("Ship it today?");

  const options = opening.getByPlaceholder("Type an option and press Enter");

  await options.fill("Ship");
  await options.press("Enter");
  await options.fill("Wait");
  await options.press("Enter");
  await opening.getByRole("button", { name: "Open vote" }).click();
  await opening.waitFor({ state: "hidden" });

  const vote = page.getByRole("region", { name: "Vote: Ship it today?" });

  await vote.getByRole("button", { name: /Ship/ }).click();
  await vote.getByText("1 voted").waitFor();
  await vote.getByRole("button", { name: "Close vote" }).click();
  await vote.waitFor({ state: "hidden" });
  await page.getByText(/Vote closed\. "Ship it today\?": Ship 1/).waitFor();

  await page.goto(new URL("/#team/sessions", server.url).href);

  await page
    .getByRole("main")
    .getByRole("link", { name: "team-docs" })
    .waitFor();

  const mine = (await post("/api/sessions", {
    workspace: {
      kind: "clone",
      repository: "https://git.example.com/team/handbook.git",
    },
  })) as Session;

  await page.goto(new URL(`/#${mine.id}`, server.url).href);
  await page.getByRole("button", { name: "Session actions" }).click();
  await page.getByRole("menuitem", { name: "Move to the team" }).click();

  const moving = page.getByRole("dialog", { name: "Move to the team" });

  await moving
    .getByLabel("Handoff summary")
    .fill("Goal: a handbook page on releases. Nothing done yet.");

  await moving.getByRole("button", { name: "Move to the team" }).click();
  await page.waitForURL((url) => url.hash.startsWith("#team/sessions/"));

  const moved = (await (
    await fetch(
      new URL(
        `/api/sessions/${new URL(page.url()).hash.split("/").at(-1) ?? ""}`,
        server.url,
      ),
      { headers: { cookie: current } },
    )
  ).json()) as Session;

  expect(moved).toMatchObject({
    ownedBy: "team",
    firstMessage: "Goal: a handbook page on releases. Nothing done yet.",
  });

  await page.goto(`${server.url.href}#plugin/routines`);
  await page.getByRole("button", { name: "More ways to add" }).click();
  await page.getByRole("menuitem", { name: "New team routine" }).click();

  await page
    .getByRole("heading", {
      name: "What should happen by itself for the team?",
    })
    .waitFor();

  await page.getByRole("button", { name: "Write JSON" }).click();
  await page.getByRole("heading", { name: "New team routine" }).waitFor();
  await page.getByLabel("Name").fill("weekly-notes");

  await page.getByLabel("Routine JSON").fill(
    JSON.stringify({
      title: "Write the weekly notes",
      when: [
        { kind: "schedule", cron: "0 16 * * 5", timeZone: "Europe/Berlin" },
      ],
      do: {
        kind: "session",
        prompt: "Write the weekly notes.",
        workspace: { kind: "folder", path: folder },
        environment: environment.id,
        profile: profile.id,
      },
    }),
  );

  await page.getByRole("button", { name: "Save" }).click();
  await page.getByRole("heading", { name: "Write the weekly notes" }).waitFor();
  await page.goto(`${server.url.href}#plugin/routines`);

  await page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "The team's" }) })
    .getByRole("link", { name: /Write the weekly notes/ })
    .waitFor();

  await page.goto(new URL("/#team", server.url).href);

  await page
    .getByRole("navigation", { name: "Team" })
    .getByRole("link", { name: "Routines", exact: true })
    .click();

  await page
    .getByRole("table", { name: "Routines" })
    .getByRole("link", { name: "Write the weekly notes" })
    .waitFor();
}, 30_000);

test("shows plugin panels on the team hub and lets an admin lay out a page of them", async () => {
  await page.goto(new URL("/#team", server.url).href);

  await page
    .getByRole("region", { name: "Spend this month" })
    .getByText(/you used \$0\.00/)
    .waitFor();

  await page
    .getByRole("region", { name: "Pull requests" })
    .getByText("No pull requests to show yet.")
    .waitFor();

  const nav = page.getByRole("navigation", { name: "Team" });

  await nav.getByRole("button", { name: /^More/ }).click();
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

  await nav.getByRole("link", { name: "Costs" }).waitFor({ state: "detached" });
});

test("an admin sets up team work from Team setup: its Profiles, Environments, credentials, budgets and audit log", async () => {
  await page.goto(new URL("/#team", server.url).href);

  const team = page.getByRole("navigation", { name: "Team" });

  await team.getByRole("button", { name: /^More/ }).click();
  await team.getByRole("link", { name: "Team setup" }).click();

  const nav = page.getByRole("navigation", { name: "Team setup" });

  await page.getByRole("heading", { name: "Team Profiles" }).waitFor();
  await page.getByRole("link", { name: "New team Profile" }).click();
  await page.getByLabel("Name").fill("Backend");
  await page.getByRole("button", { name: "Create Profile" }).click();

  await page.getByRole("link", { name: "Open as files" }).waitFor();
  expect(new URL(page.url()).hash).toMatch(/^#team\/setup\/profiles\/.+/);

  expect(
    await page
      .getByRole("navigation", { name: "Profiles" })
      .getByRole("link", { name: "My defaults" })
      .count(),
  ).toBe(0);

  const teamProfiles = (await (
    await page.request.get(new URL("/api/profiles?scope=team", server.url).href)
  ).json()) as Profile[];

  expect(teamProfiles.map(({ name }) => name)).toContain("Backend");

  // The open Profile's form shows until the new one replaces it.
  await page.getByRole("link", { name: "New team Profile" }).click();
  await page.getByRole("button", { name: "Create Profile" }).waitFor();
  await page.getByLabel("Name").fill("Frontend");
  await page.getByRole("button", { name: "Create Profile" }).click();

  await page.getByRole("button", { name: "Make team default" }).click();

  await page
    .getByRole("navigation", { name: "Profiles" })
    .getByRole("link", { name: /^Frontend/ })
    .getByText("Default")
    .waitFor();

  await nav.getByRole("link", { name: /^Profiles/ }).click();

  const rows = page.getByRole("list", { name: "Team Profiles" });

  const row = (name: string): Locator =>
    rows.getByRole("listitem").filter({ hasText: name });

  await row("Frontend").getByText("Team default").waitFor();
  await row("Backend").getByText("0 Sessions").waitFor();

  await row("Backend").getByRole("button", { name: "Backend actions" }).click();
  await page.getByRole("menuitem", { name: "Duplicate" }).click();
  await row("Backend copy").waitFor();

  await row("Backend")
    .first()
    .getByRole("button", { name: "Backend actions" })
    .click();

  await page.getByRole("menuitem", { name: "Make team default" }).click();
  await row("Backend").first().getByText("Team default").waitFor();

  await nav.getByRole("link", { name: /^Environments/ }).click();
  await page.getByRole("heading", { name: "Team Environments" }).waitFor();
  await page.getByRole("button", { name: "New Environment" }).click();
  await page.getByLabel("New Environment name").fill("team-machines");
  await page.getByRole("button", { name: "Create" }).click();

  await page.getByRole("link", { name: "Team Environments" }).waitFor();

  expect(new URL(page.url()).hash).toMatch(/^#team\/setup\/environments\/.+/);

  await nav.getByRole("link", { name: "Credentials" }).click();
  await page.getByRole("heading", { name: "Credentials" }).waitFor();
  await page.getByText("No team key yet.").waitFor();

  await nav.getByRole("link", { name: "Budgets" }).click();
  await page.getByLabel("Team budget").fill("200");
  await page.getByLabel("Each person's cap").fill("40");
  await page.getByRole("button", { name: "Save" }).click();
  await page.getByRole("status").getByText("Saved").waitFor();

  const totals = (await (
    await page.request.get(new URL("/api/ext/usage/totals", server.url).href)
  ).json()) as { budgets: unknown };

  expect(totals.budgets).toEqual({ team: 200, person: 40 });

  await nav.getByRole("link", { name: "Audit log" }).click();
  await page.getByRole("heading", { name: "Audit log" }).waitFor();
  await page.getByRole("link", { name: "Download CSV" }).waitFor();

  await nav.getByRole("link", { name: "Notifications" }).click();

  const answer = page.getByLabel(
    /^Minutes before a question goes to the starter/,
  );

  expect(await answer.inputValue()).toBe("10");

  await answer.fill("25");
  await page.getByRole("button", { name: "Save" }).click();
  await page.reload();

  expect(await answer.inputValue()).toBe("25");

  await answer.fill("10");
  await page.getByRole("button", { name: "Save" }).click();
  await page.reload();

  expect(await answer.inputValue()).toBe("10");

  await nav.getByRole("link", { name: "Team home" }).click();
  await page.getByRole("heading", { name: "Team home" }).waitFor();
}, 30_000);

test("an admin keeps a plugin out of team work from Team setup", async () => {
  await page.goto(new URL("/#team/setup/plugins", server.url).href);
  await page.getByRole("heading", { name: "Plugins in team work" }).waitFor();

  const ask = page.getByRole("switch", { name: "Ask in team work" });

  expect(await ask.getAttribute("aria-checked")).toBe("true");

  await ask.click();
  await page.reload();

  expect(
    await page
      .getByRole("switch", { name: "Ask in team work" })
      .getAttribute("aria-checked"),
  ).toBe("false");

  await page.getByRole("switch", { name: "Ask in team work" }).click();

  await page
    .getByRole("switch", { name: "Ask in team work", checked: true })
    .waitFor();
});

test("an admin names the team, and the hub and sidebar show it", async () => {
  await page.goto(new URL("/#team/setup/name", server.url).href);
  await page.getByLabel("Team name").fill("Acme platform");
  await page.getByRole("button", { name: "Save" }).click();
  await page.getByRole("status").getByText("Saved").waitFor();

  await page
    .getByRole("navigation", { name: "Team setup" })
    .getByRole("link", { name: "Team home" })
    .click();

  await page
    .getByRole("navigation", { name: "Team" })
    .getByRole("button", { name: "Switch workspace" })
    .filter({ hasText: "Acme platform" })
    .waitFor();

  await switchWorkspace(/Your workspace/);
  await page.locator("#sessions").waitFor();
  await page.getByRole("button", { name: "Switch workspace" }).click();
  await page.getByRole("menuitemradio", { name: /^Acme platform/ }).waitFor();

  await page.request.put(new URL("/api/settings/team", server.url).href, {
    data: { name: null },
  });

  await page.getByRole("menuitemradio", { name: /^Team/ }).waitFor();
});

test("switches between your workspace and the team's with the keyboard", async () => {
  await page.goto(server.url.href);
  await page.locator("#sessions").waitFor();

  await page.keyboard.press("Control+2");
  await page.getByRole("navigation", { name: "Team" }).waitFor();
  expect(new URL(page.url()).hash).toBe("#team");

  await page.keyboard.press("Control+1");
  await page.locator("#sessions").waitFor();
});

test("keeps team talk off team work nobody else sees, such as a Team assistant", async () => {
  await page.goto(server.url.href);

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

  const environment = (await post("/api/environments", {
    name: "own-pods",
    team: true,
  })) as Environment;

  const profile = (await post("/api/profiles", {
    name: "Own",
    team: true,
  })) as Profile;

  const folder = join(root, "own-talk");

  await mkdir(folder, { recursive: true });

  const session = (await post("/api/sessions", {
    team: true,
    environment: environment.id,
    profile: profile.id,
    workspace: { kind: "folder", path: folder },
  })) as Session;

  await fetch(new URL(`/api/sessions/${session.id}`, server.url), {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie: current },
    body: JSON.stringify({ access: { kind: "named", people: [] } }),
  });

  await page.goto(new URL(`/#team/sessions/${session.id}`, server.url).href);

  await page.locator("header").getByText("own-talk", { exact: true }).waitFor();
  await page.locator("#prompt-text").waitFor();

  expect(await page.getByRole("group", { name: "Send to" }).count()).toBe(0);
});

test("offers a fork once the team said more than Pi reads", async () => {
  await page.goto(server.url.href);

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

  const environment = (await post("/api/environments", {
    name: "talk-pods",
    team: true,
  })) as Environment;

  const profile = (await post("/api/profiles", {
    name: "Talk",
    team: true,
  })) as Profile;

  const folder = join(root, "long-talk");

  await mkdir(folder, { recursive: true });

  const session = (await post("/api/sessions", {
    team: true,
    environment: environment.id,
    profile: profile.id,
    workspace: { kind: "folder", path: folder },
  })) as Session;

  await post(`/api/sessions/${session.id}/messages`, {
    to: "team",
    text: "One",
  });

  await page.goto(new URL(`/#${session.id}`, server.url).href);

  await page
    .getByText("Pi also reads the team message since its last turn.")
    .waitFor();

  for (let n = 2; n <= 41; n++) {
    await post(`/api/sessions/${session.id}/messages`, {
      to: "team",
      text: `Message ${String(n)}`,
    });
  }

  const offer = page
    .getByRole("status")
    .filter({ hasText: "Pi reads only the latest 40 of 41 team messages" });

  await offer.waitFor();
  await page.locator("#prompt-text").fill("We settled on 5 retries.");

  // No runner serves these pods, so Pi never starts to take the message.
  await page.getByPlaceholder("Pi is starting…").waitFor();

  expect(await page.getByRole("button", { name: "Send" }).isDisabled()).toBe(
    true,
  );

  await offer.getByRole("button", { name: "Fork" }).click();

  await page.waitForURL(
    (url) =>
      url.hash.startsWith("#team/sessions/") && !url.hash.endsWith(session.id),
  );

  await page.waitForFunction(
    `document.querySelector("#prompt-text")?.value === "We settled on 5 retries."`,
  );

  const forked = (await (
    await fetch(
      new URL(
        `/api/sessions/${new URL(page.url()).hash.split("/").at(-1) ?? ""}`,
        server.url,
      ),
      { headers: { cookie: current } },
    )
  ).json()) as Session;

  expect(forked.ownedBy).toBe("team");
});

test("shows on the hub's Home who limited team work", async () => {
  await page.goto(server.url.href);

  const signedIn = (await page.context().cookies()).find(
    ({ name }) => name === "pipoca-session",
  );

  const current = `${signedIn?.name ?? ""}=${signedIn?.value ?? ""}`;

  const call = async (
    path: string,
    body: unknown,
    method = "POST",
  ): Promise<unknown> =>
    (
      await fetch(new URL(path, server.url), {
        method,
        headers: { "content-type": "application/json", cookie: current },
        body: JSON.stringify(body),
      })
    ).json();

  const environment = (await call("/api/environments", {
    name: "activity-pods",
    team: true,
  })) as Environment;

  const profile = (await call("/api/profiles", {
    name: "Activity",
    team: true,
  })) as Profile;

  const folder = join(root, "quiet-work");

  await mkdir(folder, { recursive: true });

  const session = (await call("/api/sessions", {
    team: true,
    environment: environment.id,
    profile: profile.id,
    workspace: { kind: "folder", path: folder },
  })) as Session;

  await call(
    `/api/sessions/${session.id}`,
    { access: { kind: "view" } },
    "PATCH",
  );

  // Home shows every panel until an admin lays it out.
  await call("/api/settings/hub", { pages: null }, "PUT");
  await page.goto(new URL("/#team", server.url).href);

  await page
    .getByRole("region", { name: "Activity" })
    .getByRole("listitem")
    .filter({ hasText: "made view only" })
    .first()
    .waitFor();
});

test("an admin pastes the key of a team runner's extension provider, and Credentials shows it reaching the runner", async () => {
  await page.goto(server.url.href);

  const signedIn = (await page.context().cookies()).find(
    ({ name }) => name === "pipoca-session",
  );

  const { key, ...environment } = (await (
    await fetch(new URL("/api/environments", server.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `${signedIn?.name ?? ""}=${signedIn?.value ?? ""}`,
      },
      body: JSON.stringify({ name: "core-pods", team: true }),
    })
  ).json()) as Environment & { key: string };

  const agent = async (
    path: string,
    token: string,
    body: unknown,
  ): Promise<unknown> =>
    (
      await fetch(new URL(path, server.url), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [versionHeader]: String(protocolVersion),
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      })
    ).json();

  const joined = (await agent("/runner/join", key, { name: "core-1" })) as {
    token: string;
  };

  await agent("/runner/work", joined.token, {
    running: [],
    folders: [],
    models: [{ provider: "ai-core", id: "claude-on-core" }],
  });

  await page.goto(
    new URL("/#team/setup/plugin/logins/credentials", server.url).href,
  );

  await page
    .getByRole("list", { name: "No team key" })
    .getByText(`On the runners of ${environment.name}.`, { exact: false })
    .waitFor();

  await page.goto(server.url.href);
  await openSettings("Accounts");
  await page.getByRole("list", { name: "Your model logins" }).waitFor();

  // An earlier test's MCP sign-in stays on show until it's closed.
  const finished = page.getByRole("region", { name: /^Connecting/ });
  if (await finished.isVisible()) {
    await finished.getByRole("button", { name: "Close" }).click();
  }

  await page.getByRole("button", { name: "Add provider" }).click();

  const form = page.getByRole("form", { name: "Connect a model provider" });
  await form.getByLabel("Provider").selectOption("ai-core");
  await form.getByRole("combobox", { name: /^For/ }).selectOption("base");
  await form.getByLabel("Key").fill('{"clientid":"team"}');
  await form.getByRole("button", { name: "Connect" }).click();
  await form.waitFor({ state: "detached" });

  await page.goto(
    new URL("/#team/setup/plugin/logins/credentials", server.url).href,
  );

  await page
    .getByRole("list", { name: "Reach the runner" })
    .getByText("ai-core", { exact: true })
    .waitFor();
}, 30_000);

test("drops a plugin's parts from open team work once an admin keeps it out", async () => {
  await page.goto(server.url.href);

  const signedIn = (await page.context().cookies()).find(
    ({ name }) => name === "pipoca-session",
  );

  const current = `${signedIn?.name ?? ""}=${signedIn?.value ?? ""}`;

  const call = async (
    path: string,
    body: unknown,
    method = "POST",
  ): Promise<unknown> =>
    (
      await fetch(new URL(path, server.url), {
        method,
        headers: { "content-type": "application/json", cookie: current },
        body: JSON.stringify(body),
      })
    ).json();

  const environment = (await call("/api/environments", {
    name: "switch-pods",
    team: true,
  })) as Environment;

  const profile = (await call("/api/profiles", {
    name: "Switch",
    team: true,
  })) as Profile;

  const folder = join(root, "switched");

  await mkdir(folder, { recursive: true });

  const session = (await call("/api/sessions", {
    team: true,
    environment: environment.id,
    profile: profile.id,
    workspace: { kind: "folder", path: folder },
  })) as Session;

  await page.goto(new URL(`/#${session.id}`, server.url).href);

  const usageHeader = page.locator('header [data-plugin="usage"]');

  await usageHeader.waitFor({ state: "attached" });
  await call("/api/plugins/usage", { teamWork: false }, "PATCH");
  await usageHeader.waitFor({ state: "detached" });
  await call("/api/plugins/usage", { teamWork: true }, "PATCH");
  await usageHeader.waitFor({ state: "attached" });
});

test("keeps team work inside the team's area, with the server's pages shared from Team setup", async () => {
  await page.goto(server.url.href);

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

  const environment = (await post("/api/environments", {
    name: "team-area-pods",
    team: true,
  })) as Environment;

  const profile = (await post("/api/profiles", {
    name: "Team area work",
    team: true,
  })) as Profile;

  const folder = join(root, "team-area");

  await mkdir(folder, { recursive: true });

  const session = (await post("/api/sessions", {
    team: true,
    environment: environment.id,
    profile: profile.id,
    workspace: { kind: "folder", path: folder },
  })) as Session;

  const team = page.getByRole("navigation", { name: "Team" });

  await page.goto(new URL("/#team/sessions", server.url).href);

  await page
    .getByRole("link", { name: session.title ?? "team-area" })
    .first()
    .click();

  await page.waitForURL(`**/#team/sessions/${session.id}`);
  await team.waitFor();

  await page.goto(new URL(`/#${session.id}`, server.url).href);
  await page.waitForURL(`**/#team/sessions/${session.id}`);
  await team.waitFor();

  await page.goto(new URL("/#team/setup", server.url).href);

  await page
    .getByRole("navigation", { name: "Team setup" })
    .getByRole("link", { name: "Plugins", exact: true })
    .click();

  await page.waitForURL("**/#team/setup/server/plugins");
  await page.getByRole("note").getByText("Server-wide").waitFor();
  await page.getByRole("navigation", { name: "Team setup" }).waitFor();

  await page.goto(new URL("/#settings/plugins", server.url).href);

  await page
    .getByRole("note")
    .getByRole("link", { name: "open it there" })
    .waitFor();
}, 30_000);

// Answers the confirm dialog that the last click opened.
async function confirmIn(name: string): Promise<void> {
  await page
    .getByRole("dialog")
    .getByRole("button", { name, exact: true })
    .click();
}
