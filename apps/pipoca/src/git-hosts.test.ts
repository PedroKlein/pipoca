import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHmac, createVerify, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Assignment,
  protocolVersion,
  type ToolSpec,
  versionHeader,
  type Work,
  type WorkPoll,
} from "@pipoca/protocol";
import { readSse } from "@pipoca/protocol";
import { testServer, type TestServer } from "./testdata/harness";
import { until } from "@pipoca/plugins/testing";
import { runnerCredentials } from "./testdata/runners";

const enterprise = "github.tools.sap";
const goodToken = "ghp_good";

let configDir: string;
let server: TestServer;
let host: ReturnType<typeof Bun.serve>;

// Command streams the tests opened, closed before their server stops.
let streams: AsyncGenerator[];

// The pull request the host knows, which tests change between polls.
// How many installation tokens the host gave out.
let minted: number;

let pull: {
  checks: "pending" | "failure" | "success";
  mergeable: boolean;
  merged: boolean;
  comments: { id: number; login: string; body: string }[];
  mergedWith: string | undefined;
};

const pullUrl = `https://${enterprise}/I572543/dotfiles/pull/7`;

// The key the host hands out for the App it creates from a manifest.
const appKey = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
});

// Whether a JWT is the App's, signed with its key.
function signedByApp(authorization: string | null): boolean {
  const [header, payload, signature] = (authorization ?? "")
    .replace(/^Bearer /, "")
    .split(".");

  if (
    header === undefined ||
    payload === undefined ||
    signature === undefined
  ) {
    return false;
  }

  const { iss } = JSON.parse(Buffer.from(payload, "base64url").toString()) as {
    iss?: unknown;
  };

  return (
    iss === "42" &&
    createVerify("RSA-SHA256")
      .update(`${header}.${payload}`)
      .verify(appKey.publicKey, Buffer.from(signature, "base64url"))
  );
}

beforeEach(() => {
  minted = 0;
  streams = [];

  pull = {
    checks: "pending",
    mergeable: true,
    merged: false,
    comments: [],
    mergedWith: undefined,
  };

  // The host's REST API, which knows one token.
  host = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);

      if (
        url.pathname === "/api/v3/app-manifests/m4nifest/conversions" &&
        request.method === "POST"
      ) {
        return Response.json(
          {
            id: 42,
            slug: "pipoca-bot",
            html_url: `https://${enterprise}/github-apps/pipoca-bot`,
            pem: appKey.privateKey,
            webhook_secret: "hook-secret",
          },
          { status: 201 },
        );
      }

      if (url.pathname === "/api/v3/app/installations/7/access_tokens") {
        minted += 1;

        return signedByApp(request.headers.get("authorization"))
          ? Response.json(
              {
                token: "ghs_installation",
                expires_at: new Date(Date.now() + 3_600_000).toISOString(),
              },
              { status: 201 },
            )
          : Response.json({ message: "Bad JWT" }, { status: 401 });
      }

      if (url.pathname === "/api/v3/users/pipoca-bot%5Bbot%5D") {
        return Response.json({ id: 99, login: "pipoca-bot[bot]" });
      }

      if (url.pathname === "/api/v3/app/installations") {
        return signedByApp(request.headers.get("authorization"))
          ? Response.json([{ id: 7, account: { login: "I572543" } }])
          : Response.json({ message: "Bad JWT" }, { status: 401 });
      }

      if (
        url.pathname === "/api/v3/installation/repositories" &&
        request.headers.get("authorization") === "Bearer ghs_installation"
      ) {
        return Response.json({
          repositories: [
            {
              full_name: "I572543/pi-aicore-provider",
              clone_url: `https://${enterprise}/I572543/pi-aicore-provider.git`,
            },
          ],
        });
      }

      if (request.headers.get("authorization") !== `Bearer ${goodToken}`) {
        return Response.json({ message: "Bad credentials" }, { status: 401 });
      }

      const repository = (name: string): unknown => ({
        full_name: name,
        clone_url: `https://${enterprise}/${name}.git`,
      });

      const repo = "/api/v3/repos/I572543/dotfiles";

      switch (url.pathname) {
        case `${repo}/pulls/7`:
          return Response.json({
            html_url: pullUrl,
            title: "Tidy the dotfiles",
            state: pull.merged ? "closed" : "open",
            merged: pull.merged,
            mergeable: pull.mergeable,
            head: { sha: "abc1234def" },
          });
        case `${repo}/commits/abc1234def/check-runs`:
          return Response.json({
            check_runs: [
              {
                name: "test",
                status: pull.checks === "pending" ? "in_progress" : "completed",
                conclusion: pull.checks === "pending" ? null : pull.checks,
                html_url: "https://ci.example/test",
              },
            ],
          });
        case `${repo}/commits/abc1234def/status`:
          return Response.json({ statuses: [] });
        case `${repo}/pulls/7/reviews`:
          return Response.json([]);
        case `${repo}/pulls/7/comments`:
          return Response.json(
            pull.comments.map(({ id, login, body }) => ({
              id,
              user: { login },
              body,
              path: "zshrc",
              html_url: `${pullUrl}#discussion_r${String(id)}`,
            })),
          );
        case repo:
          return Response.json({ allow_squash_merge: true });
        case `${repo}/pulls/7/merge`:
          pull.mergedWith = String(
            ((await request.json()) as { merge_method?: unknown }).merge_method,
          );

          pull.merged = true;

          return Response.json({ merged: true });
        case "/api/v3/user":
          return Response.json({ login: "pedro-sap" });
        case "/api/v3/user/repos":
          return Response.json([
            repository("I572543/pi-aicore-provider"),
            repository("I572543/dotfiles"),
          ]);
        case "/api/v3/search/repositories":
          return Response.json({
            items: [
              repository("I572543/pi-aicore-provider"),
              repository("ai-core/aicore-sdk"),
            ],
          });
        default:
          return Response.json({ message: "Not Found" }, { status: 404 });
      }
    },
  });

  configDir = mkdtempSync(join(tmpdir(), "pipoca-config-"));

  writeFileSync(
    join(configDir, "pipoca.json"),
    JSON.stringify({
      "git-hosts": {
        hosts: [
          {
            host: enterprise,
            label: "SAP GitHub",
            api: `http://127.0.0.1:${String(host.port)}/api/v3`,
          },
        ],
      },
    }),
  );

  server = testServer({
    configDir,
    runners: { pollWaitMs: 0 },
  });
});

afterEach(async () => {
  await Promise.all(streams.map(async (stream) => stream.return(undefined)));

  await server.close();
  await host.stop();
});

// What a runner gets for a new Session of Pedro's.
async function assignment(): Promise<Assignment | undefined> {
  const token = await runnerToken();

  await server.api("/api/sessions", {
    body: {
      workspace: { kind: "folder", path: "/srv/a" },
    },
  });

  return polled(token);
}

async function runnerToken(): Promise<string> {
  return runnerCredentials(server, server.signedIn).token("laptop", "laptops");
}

// What the runner gets for the first Session it can start.
async function polled(token: string): Promise<Assignment | undefined> {
  const poll: WorkPoll = { running: [], folders: ["/srv/a"], models: [] };

  const work = (await (
    await fetch(new URL("/agent/work", server.url), {
      method: "POST",
      headers: {
        [versionHeader]: String(protocolVersion),
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(poll),
    })
  ).json()) as Work;

  return work.start[0];
}

// A new Session of Pedro's, as its runner sees it.
async function pedroSession(): Promise<{
  readonly id: string;
  readonly tools: () => Promise<readonly string[]>;
  readonly call: (name: string, input: unknown) => Promise<unknown>;
  readonly next: (type: string) => Promise<Record<string, unknown>>;
}> {
  const token = await runnerToken();

  await server.api("/api/sessions", {
    body: {
      workspace: { kind: "folder", path: "/srv/a" },
    },
  });

  const { sessionId, generation } = (await polled(token)) ?? {
    sessionId: "",
    generation: 0,
  };

  const agent = async (path: string, body?: unknown): Promise<Response> =>
    fetch(new URL(`/agent/sessions/${sessionId}/${path}`, server.url), {
      method: body === undefined ? "GET" : "POST",
      headers: {
        [versionHeader]: String(protocolVersion),
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });

  const commands = readSse(
    await agent(`commands?generation=${String(generation)}`),
    10_000,
  );

  streams.push(commands);

  const next = async (type: string): Promise<Record<string, unknown>> => {
    for (;;) {
      const read: IteratorResult<unknown> = await commands.next();

      if (read.done === true) {
        throw new Error(`no ${type} command`);
      }

      const command = read.value as Record<string, unknown>;

      if (command["type"] === type) {
        return command;
      }
    }
  };

  let calls = 0;

  return {
    id: sessionId,
    tools: async () =>
      (
        (await (
          await agent(`tools?generation=${String(generation)}`)
        ).json()) as ToolSpec[]
      ).map(({ name }) => name),
    call: async (name, input) => {
      calls += 1;

      await agent("tool-calls", {
        generation,
        id: `call-${String(calls)}`,
        name,
        input,
      });

      return (await next("tool_result"))["result"];
    },
    next,
  };
}

// What a new Session of Pedro's sees of the repositories tool, and what it
// answers to the query.
async function repositoriesTool(
  input: Readonly<Record<string, string>>,
): Promise<{ offered: boolean; answer: unknown }> {
  const session = await pedroSession();

  return {
    offered: (await session.tools()).includes("git_hosts_repositories"),
    answer: await session.call("git_hosts_repositories", input),
  };
}

// Pedro's Session watching the pull request, polled every second.
async function watching(): Promise<Awaited<ReturnType<typeof pedroSession>>> {
  await server.api("/api/plugins/git-hosts/connect", {
    body: {
      host: enterprise,
      token: goodToken,
    },
  });

  await server.api("/api/plugins/git-hosts", {
    method: "PATCH",
    body: {
      settings: { pollSeconds: 1 },
    },
  });

  const session = await pedroSession();

  expect(await session.call("git_hosts_watch", { url: pullUrl })).toEqual({
    isError: false,
    text: `Watching ${pullUrl}. Its news will come here.`,
  });

  return session;
}

async function watched(sessionId: string): Promise<unknown> {
  return (
    await server.api(
      `/api/plugins/git-hosts/pull-requests?session=${sessionId}`,
    )
  ).json();
}

test("lists only github.com when the config file names no hosts", async () => {
  writeFileSync(join(configDir, "pipoca.json"), "{}");

  const account = await (
    await server.api("/api/plugins/git-hosts/account")
  ).json();

  expect(account).toMatchObject({
    hosts: [{ host: "github.com", label: "GitHub", oauth: false }],
    connections: [],
  });
});

test("connects a host with a token and signs the person's Sessions in with it", async () => {
  const connected = await server.api("/api/plugins/git-hosts/connect", {
    body: {
      host: enterprise,
      token: goodToken,
    },
  });

  const page = await connected.text();

  expect(connected.status).toBe(200);
  expect(page).toContain('"login":"pedro-sap"');
  expect(page).not.toContain(goodToken);

  expect((await assignment())?.gitLogins).toEqual([
    { host: enterprise, token: goodToken },
  ]);

  expect(server.logs.join("\n")).not.toContain(goodToken);
});

test("tells admins how many people connected on each host", async () => {
  await server.api("/api/plugins/git-hosts/connect", {
    body: {
      host: enterprise,
      token: goodToken,
    },
  });

  const hosts = (await (
    await server.api("/api/plugins/git-hosts/hosts")
  ).json()) as { host: string; connected: number }[];

  expect(hosts.map((each) => [each.host, each.connected])).toEqual([
    [enterprise, 1],
  ]);
});

test("signs the coordinator of a Project in with the git logins of the person who started it", async () => {
  await server.api("/api/plugins/git-hosts/connect", {
    body: {
      host: enterprise,
      token: goodToken,
    },
  });

  const token = await runnerToken();

  const created = await server.api("/api/plugins/projects/projects", {
    body: {
      name: "Release",
      repositories: [`https://${enterprise}/I572543/pi-aicore-provider.git`],
    },
  });

  expect(created.status).toBe(200);

  expect((await polled(token))?.gitLogins).toEqual([
    { host: enterprise, token: goodToken },
  ]);
});

test("sends no login for a host after the person disconnects it", async () => {
  await server.api("/api/plugins/git-hosts/connect", {
    body: {
      host: enterprise,
      token: goodToken,
    },
  });

  await server.api(
    `/api/plugins/git-hosts/connections/${encodeURIComponent(enterprise)}`,
    { method: "DELETE" },
  );

  expect((await assignment())?.gitLogins).toBeUndefined();
});

test("refuses a token the host doesn't accept, saying so", async () => {
  const refused = await server.api("/api/plugins/git-hosts/connect", {
    body: {
      host: enterprise,
      token: "ghp_wrong",
    },
  });

  expect(refused.status).toBe(400);

  expect(await refused.json()).toEqual({
    error: "bad_request",
    message: `${enterprise} doesn't accept this token`,
  });
});

test("keeps a host's OAuth secret sealed in pipoca.json and out of the page", async () => {
  const added = await server.api("/api/plugins/git-hosts/hosts", {
    body: {
      host: "GitHub.example.com",
      label: "Example",
      clientId: "Iv1.abc",
      clientSecret: "shh",
    },
  });

  expect(added.status).toBe(201);

  expect(await added.json()).toEqual({
    host: "github.example.com",
    label: "Example",
    clientId: "Iv1.abc",
    hasClientSecret: true,
    clientSecretEnv: null,
    connected: 0,
  });

  const file = readFileSync(join(configDir, "pipoca.json"), "utf8");

  expect(file).toContain('"clientId": "Iv1.abc"');
  expect(file).not.toContain("shh");

  const account = await (
    await server.api("/api/plugins/git-hosts/account")
  ).json();

  expect(account).toMatchObject({
    hosts: [
      { host: enterprise, oauth: false },
      { host: "github.example.com", oauth: true },
    ],
  });
});

test("won't save over hosts edited by hand into a list that doesn't fit", async () => {
  await server.api("/api/plugins/git-hosts/hosts");

  const edited = JSON.stringify({
    "git-hosts": { hosts: [{ host: enterprise, api: "ftp://nowhere" }] },
  });

  writeFileSync(join(configDir, "pipoca.json"), edited);

  const added = await server.api("/api/plugins/git-hosts/hosts", {
    body: {
      host: "github.example.com",
    },
  });

  expect(added.status).toBe(400);

  expect(await added.json()).toEqual({
    error: "bad_request",
    message:
      "fix git-hosts in pipoca.json first: git-hosts.hosts[0]: api must be an http or https URL",
  });

  expect(readFileSync(join(configDir, "pipoca.json"), "utf8")).toBe(edited);
});

test("sends a sign-in to the host's authorize page, and refuses a callback in another browser", async () => {
  writeFileSync(
    join(configDir, "pipoca.json"),
    JSON.stringify({
      "git-hosts": {
        hosts: [
          {
            host: enterprise,
            oauth: {
              clientId: "Iv1.abc",
              clientSecret: { env: "SAP_SECRET" },
            },
          },
        ],
      },
    }),
  );

  process.env["SAP_SECRET"] = "shh";

  const started = await server.api(
    `/api/plugins/git-hosts/sign-in/${enterprise}`,
  );

  const location = new URL(started.headers.get("location") ?? "");
  const state = location.searchParams.get("state") ?? "";

  expect(started.status).toBe(302);

  expect(location.origin + location.pathname).toBe(
    `https://${enterprise}/login/oauth/authorize`,
  );

  expect(location.searchParams.get("client_id")).toBe("Iv1.abc");

  expect(location.searchParams.get("redirect_uri")).toBe(
    new URL("/api/plugins/git-hosts/callback", server.url).href,
  );

  expect(process.env["SAP_SECRET"]).toBeUndefined();

  const elsewhere = await fetch(
    new URL(
      `/api/plugins/git-hosts/callback?state=${state}&code=c0de`,
      server.url,
    ),
  );

  expect(elsewhere.status).toBe(400);
});

test("finds the repositories of each connected host for what the person typed", async () => {
  await server.api("/api/plugins/git-hosts/connect", {
    body: {
      host: enterprise,
      token: goodToken,
    },
  });

  const found = await (
    await server.api("/api/plugins/git-hosts/repositories?q=aicore")
  ).json();

  expect(found).toEqual([
    {
      url: `https://${enterprise}/I572543/pi-aicore-provider.git`,
      name: "I572543/pi-aicore-provider",
      group: "SAP GitHub",
    },
    {
      url: `https://${enterprise}/ai-core/aicore-sdk.git`,
      name: "ai-core/aicore-sdk",
      group: "SAP GitHub",
    },
  ]);
});

test("gives a Session the person's accounts and real repository URLs instead of a guess", async () => {
  await server.api("/api/plugins/git-hosts/connect", {
    body: {
      host: enterprise,
      token: goodToken,
    },
  });

  const { offered, answer } = await repositoriesTool({ query: "aicore" });

  expect(offered).toBe(true);

  expect(answer).toEqual({
    isError: false,
    text: [
      `Signed in on ${enterprise} (SAP GitHub) as pedro-sap.`,
      [
        'Repositories whose name holds "aicore":',
        `- ${enterprise} I572543/pi-aicore-provider https://${enterprise}/I572543/pi-aicore-provider.git`,
        `- ${enterprise} ai-core/aicore-sdk https://${enterprise}/ai-core/aicore-sdk.git`,
      ].join("\n"),
    ].join("\n\n"),
  });
});

test("tells a Session where the person connects a git host when they have none", async () => {
  const { answer } = await repositoriesTool({});

  expect(answer).toEqual({
    isError: false,
    text: "The user hasn't connected a git host. They can connect one in Pipoca's Settings, under Git hosts.",
  });
});

test("names only the person's accounts when a Session searches for nothing", async () => {
  await server.api("/api/plugins/git-hosts/connect", {
    body: {
      host: enterprise,
      token: goodToken,
    },
  });

  const { answer } = await repositoriesTool({});

  expect(answer).toEqual({
    isError: false,
    text: `Signed in on ${enterprise} (SAP GitHub) as pedro-sap.\n\nGive a query to search their repositories by name.`,
  });
});

test("tells a Session the person hasn't connected the host it asked to search", async () => {
  await server.api("/api/plugins/git-hosts/connect", {
    body: {
      host: enterprise,
      token: goodToken,
    },
  });

  const { answer } = await repositoriesTool({
    query: "aicore",
    host: "github.com",
  });

  expect(answer).toEqual({
    isError: false,
    text: "The user hasn't connected github.com. They can connect it in Pipoca's Settings, under Git hosts.",
  });
});

test("tells the Session watching a pull request that its checks failed, with the rules first", async () => {
  const session = await watching();

  pull.checks = "failure";

  const notice = await session.next("notice");

  expect(notice["text"]).toStartWith(
    `News on ${pullUrl}:\n- Checks failed on abc1234: test (https://ci.example/test)\n\nYou are watching this pull request.`,
  );

  expect(notice["text"]).toContain(
    "Never comment, review or reply on GitHub as the user.",
  );

  expect(await watched(session.id)).toMatchObject([
    {
      url: pullUrl,
      title: "Tidy the dotfiles",
      state: "open",
      checks: { passed: 0, failed: 1, pending: 0 },
      autoFix: true,
    },
  ]);
}, 15_000);

test("passes on new review comments and conflicts without repeating the rules", async () => {
  const session = await watching();

  pull.checks = "failure";
  await session.next("notice");

  pull.comments = [{ id: 1, login: "reviewer", body: "Rename this alias" }];
  pull.mergeable = false;

  const notice = await session.next("notice");

  expect(notice["text"]).toBe(
    [
      `News on ${pullUrl}:`,
      `- reviewer commented on zshrc: Rename this alias (${pullUrl}#discussion_r1)`,
      "- It has a merge conflict with its base branch. Merge the base branch in, resolve it, and push.",
    ].join("\n"),
  );
}, 15_000);

test("lets the Session reply on GitHub only when the person chose so", async () => {
  await server.api("/api/plugins/git-hosts/preferences", {
    body: {
      autoFix: true,
      reply: true,
    },
  });

  const session = await watching();

  pull.checks = "failure";

  expect((await session.next("notice"))["text"]).toContain(
    "End each reply with a line that reads: via Pipoca",
  );
}, 15_000);

test("keeps a pull request's news on its card when the person turned auto-fix off", async () => {
  await server.api("/api/plugins/git-hosts/preferences", {
    body: {
      autoFix: false,
      reply: false,
    },
  });

  await server.api("/api/plugins/git-hosts/connect", {
    body: {
      host: enterprise,
      token: goodToken,
    },
  });

  await server.api("/api/plugins/git-hosts", {
    method: "PATCH",
    body: {
      settings: { pollSeconds: 1 },
    },
  });

  const session = await pedroSession();

  expect(await session.call("git_hosts_watch", { url: pullUrl })).toMatchObject(
    { isError: false },
  );

  pull.checks = "failure";

  await Bun.sleep(2500);

  expect(await watched(session.id)).toMatchObject([
    { checks: { failed: 1 }, autoFix: false },
  ]);

  expect(server.logs.join("\n")).not.toContain("pull request news sent");
}, 15_000);

test("merges a watched pull request the way its repository allows, and stops watching", async () => {
  const session = await watching();
  const [{ id }] = (await watched(session.id)) as [{ id: string }];

  const merged = await server.api(
    `/api/plugins/git-hosts/pull-requests/${id}/merge`,
    { body: {} },
  );

  expect(merged.status).toBe(200);
  expect(pull.mergedWith).toBe("squash");
  expect(await watched(session.id)).toEqual([]);
}, 15_000);

// Starts the manifest flow for the Pipoca bot App, as Settings does.
async function startApp(): Promise<{
  readonly state: string;
  readonly manifest: Record<string, unknown>;
  readonly browser: string;
}> {
  const started = await server.api(
    `/api/plugins/git-hosts/technical-users/new-app?host=${enterprise}&name=Pipoca%20bot&organization=I572543`,
  );

  const form = await started.text();
  const action = /action="([^"]+)"/.exec(form)?.[1] ?? "";
  const target = new URL(action.replaceAll("&#38;", "&"));
  const state = target.searchParams.get("state") ?? "";

  const manifest = JSON.parse(
    (/name="manifest" value="([^"]+)"/.exec(form)?.[1] ?? "").replace(
      /&#(\d+);/g,
      (_, code: string) => String.fromCharCode(Number(code)),
    ),
  ) as Record<string, unknown>;

  expect(target.origin + target.pathname).toBe(
    `https://${enterprise}/organizations/I572543/settings/apps/new`,
  );

  const browser = (started.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

  return { state, manifest, browser };
}

// Creates the Pipoca bot App and installs it on I572543.
async function createApp(): Promise<void> {
  const { state, browser } = await startApp();

  await server.as(browser)(
    `/api/plugins/git-hosts/app-created?code=m4nifest&state=${state}`,
  );
}

test("creates a GitHub App from a manifest as a technical user, with its key sealed", async () => {
  const { state, manifest, browser } = await startApp();
  const callback = `/api/plugins/git-hosts/app-created?code=m4nifest&state=${state}`;

  expect(manifest).toMatchObject({
    name: "Pipoca bot",
    redirect_url: new URL("/api/plugins/git-hosts/app-created", server.url)
      .href,
    public: false,
  });

  expect((await fetch(new URL(callback, server.url))).status).toBe(400);

  const created = await server.as(browser)(callback);

  expect(created.status).toBe(200);

  expect(
    await (await server.api("/api/plugins/git-hosts/technical-users")).json(),
  ).toEqual([
    {
      name: "pipoca-bot",
      host: enterprise,
      kind: "app",
      login: "pipoca-bot[bot]",
      team: false,
      installUrl: `https://${enterprise}/github-apps/pipoca-bot/installations/new`,
      installedOn: ["I572543"],
      error: null,
    },
  ]);

  const file = readFileSync(join(configDir, "pipoca.json"), "utf8");

  expect(file).toContain('"pipoca-bot"');
  expect(file).not.toContain("PRIVATE KEY");
  expect(file).not.toContain("hook-secret");
});

test("adds a machine user by a token its host accepts, and removes it", async () => {
  const add = async (token: string): Promise<Response> =>
    server.api("/api/plugins/git-hosts/technical-users", {
      body: {
        name: "ci-bot",
        host: enterprise,
        token,
      },
    });

  expect((await add("ghp_bad")).status).toBe(400);

  expect(await (await add(goodToken)).json()).toEqual({
    name: "ci-bot",
    login: "pedro-sap",
  });

  expect((await add(goodToken)).status).toBe(400);

  expect(readFileSync(join(configDir, "pipoca.json"), "utf8")).not.toContain(
    goodToken,
  );

  expect(
    (
      await server.api("/api/plugins/git-hosts/technical-users/ci-bot", {
        method: "DELETE",
      })
    ).status,
  ).toBe(200);

  expect(
    await (await server.api("/api/plugins/git-hosts/technical-users")).json(),
  ).toEqual([]);
});

test("signs a routine's run in as the GitHub App it acts as, and commits as its bot", async () => {
  await server.api("/api/plugins/git-hosts/connect", {
    body: {
      host: enterprise,
      token: goodToken,
    },
  });

  const token = await runnerToken();

  await createApp();

  // The App's installation token is minted in the background.
  await until(() => minted > 0);

  expect(
    (
      await server.api("/api/plugins/routines/routines/tidy", {
        method: "PUT",
        body: {
          title: "Tidy the dotfiles",
          triggers: [{ webhook: true }],
          run: {
            prompt: "Tidy them.",
            workspace: {
              kind: "clone",
              repository: `https://${enterprise}/I572543/dotfiles.git`,
            },
            as: "pipoca-bot",
          },
        },
      })
    ).status,
  ).toBe(200);

  await server.api("/api/plugins/routines/routines/tidy/run", {
    method: "POST",
  });

  const started = await polled(token);

  expect(started?.gitLogins).toEqual([
    { host: enterprise, token: "ghs_installation" },
  ]);

  const identity = await fetch(
    new URL(
      `/agent/sessions/${started?.sessionId ?? ""}/plugins/git-hosts/identity?generation=${String(started?.generation ?? 0)}`,
      server.url,
    ),
    {
      headers: {
        [versionHeader]: String(protocolVersion),
        authorization: `Bearer ${token}`,
      },
    },
  );

  expect(await identity.json()).toEqual({
    name: "pipoca-bot[bot]",
    email: `99+pipoca-bot[bot]@users.noreply.${enterprise}`,
  });
});

test("has a person's Sessions commit as the name and email they chose", async () => {
  const token = await runnerToken();

  await server.api("/api/sessions", {
    body: {
      workspace: { kind: "folder", path: "/srv/a" },
    },
  });

  const started = await polled(token);

  const identity = async (): Promise<unknown> =>
    (
      await fetch(
        new URL(
          `/agent/sessions/${started?.sessionId ?? ""}/plugins/git-hosts/identity?generation=${String(started?.generation ?? 0)}`,
          server.url,
        ),
        {
          headers: {
            [versionHeader]: String(protocolVersion),
            authorization: `Bearer ${token}`,
          },
        },
      )
    ).json();

  expect(await identity()).toBeNull();

  const half = await server.api("/api/plugins/git-hosts/commit-as", {
    body: {
      name: "Pedro Klein",
      email: "",
    },
  });

  expect(half.status).toBe(400);

  const chosen = { name: "Pedro Klein", email: "pedro@example.com" };
  await server.api("/api/plugins/git-hosts/commit-as", { body: chosen });

  expect(
    await (await server.api("/api/plugins/git-hosts/commit-as")).json(),
  ).toEqual(chosen);

  expect(await identity()).toEqual(chosen);
});

test("gives no git login to a Session acting as a technical user its person may not use", async () => {
  await server.api("/api/plugins/git-hosts/connect", {
    body: {
      host: enterprise,
      token: goodToken,
    },
  });

  writeFileSync(
    join(configDir, "pipoca.json"),
    JSON.stringify({
      "git-hosts": {
        ...(
          JSON.parse(readFileSync(join(configDir, "pipoca.json"), "utf8")) as {
            "git-hosts": object;
          }
        )["git-hosts"],
        technicalUsers: [],
      },
    }),
  );

  const token = await runnerToken();

  await server.api("/api/plugins/routines/routines/tidy", {
    method: "PUT",
    body: {
      title: "Tidy the dotfiles",
      triggers: [{ webhook: true }],
      run: {
        prompt: "Tidy them.",
        workspace: { kind: "folder", path: "/srv/a" },
        as: "someone-elses-bot",
      },
    },
  });

  await server.api("/api/plugins/routines/routines/tidy/run", {
    method: "POST",
  });

  const started = await polled(token);

  expect(started?.sessionId).toBeString();
  expect(started?.gitLogins).toBeUndefined();
});

test("turns a GitHub App's signed webhooks into events for the routines of the people who may use it", async () => {
  await createApp();

  const { technicalUsers } = (
    JSON.parse(readFileSync(join(configDir, "pipoca.json"), "utf8")) as {
      "git-hosts": { technicalUsers: { app: { hook: string } }[] };
    }
  )["git-hosts"];

  const hook = technicalUsers[0]?.app.hook ?? "";

  await server.api("/api/plugins/routines/routines/fix-issues", {
    method: "PUT",
    body: {
      title: "Fix labelled issues",
      triggers: [
        { event: "git-hosts.issue", filter: { label: "pipoca", member: true } },
      ],
      run: {
        prompt: "Fix the issue.",
        workspace: { kind: "folder", path: "/srv/a" },
        as: "pipoca-bot",
      },
      key: ["repository", "number"],
    },
  });

  const deliver = async (
    association: string,
    secret = "hook-secret",
  ): Promise<number> => {
    const body = JSON.stringify({
      action: "labeled",
      label: { name: "pipoca" },
      repository: { full_name: "I572543/dotfiles" },
      sender: { login: "pedro-sap" },
      issue: {
        number: 7,
        title: "zshrc is slow",
        body: "It takes 2 s to start.",
        html_url: `https://${enterprise}/I572543/dotfiles/issues/7`,
        user: { login: "pedro-sap" },
        author_association: association,
        labels: [{ name: "pipoca" }],
      },
    });

    return (
      await fetch(new URL(`/api/plugins/git-hosts/hooks/${hook}`, server.url), {
        method: "POST",
        headers: {
          "x-github-event": "issues",
          "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
        },
        body,
      })
    ).status;
  };

  const heard = (): readonly string[] =>
    server.logs.filter((line) => line.startsWith("routine heard an event"));

  expect(await deliver("OWNER", "not-the-secret")).toBe(401);
  expect(await deliver("NONE")).toBe(202);
  expect(heard()).toEqual([]);

  expect(await deliver("OWNER")).toBe(202);
  expect(heard()).toHaveLength(1);
  expect(heard()[0]).toContain('"key":"I572543/dotfiles/7"');

  const declared = (await (
    await server.api("/api/plugins/routines/events")
  ).json()) as { type: string }[];

  expect(declared.map(({ type }) => type)).toContain("git-hosts.issue");
});

test("signs team work in as the technical user an admin chose for the team on each host", async () => {
  await server.api("/api/plugins/git-hosts/connect", {
    body: {
      host: enterprise,
      token: goodToken,
    },
  });

  for (const name of ["ci-bot", "docs-bot"]) {
    await server.api("/api/plugins/git-hosts/technical-users", {
      body: {
        name,
        host: enterprise,
        token: goodToken,
      },
    });
  }

  const choose = async (name: string, team: boolean): Promise<Response> =>
    server.api(`/api/plugins/git-hosts/technical-users/${name}`, {
      method: "PATCH",
      body: { team },
    });

  expect((await choose("no-bot", true)).status).toBe(404);
  expect((await choose("ci-bot", true)).status).toBe(200);
  expect((await choose("docs-bot", true)).status).toBe(200);

  const listed = (await (
    await server.api("/api/plugins/git-hosts/technical-users")
  ).json()) as { name: string; team: boolean }[];

  expect(listed.map(({ name, team }) => [name, team])).toEqual([
    ["ci-bot", false],
    ["docs-bot", true],
  ]);

  const { environment, key } = (await (
    await server.api("/api/environments", {
      body: { name: "pods", team: true },
    })
  ).json()) as { environment: { id: string }; key: string };

  const profile = (await (
    await server.api("/api/profiles", {
      body: { name: "Team work", team: true },
    })
  ).json()) as { id: string };

  const { token } = (await (
    await fetch(new URL("/agent/join", server.url), {
      method: "POST",
      headers: {
        [versionHeader]: String(protocolVersion),
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "pod-1" }),
    })
  ).json()) as { token: string };

  const start = async (): Promise<Assignment | undefined> => {
    await server.api("/api/sessions", {
      body: {
        team: true,
        environment: environment.id,
        profile: profile.id,
        workspace: { kind: "folder", path: "/srv/a" },
      },
    });

    return polled(token);
  };

  expect((await start())?.gitLogins).toEqual([
    { host: enterprise, token: goodToken },
  ]);

  await choose("docs-bot", false);

  expect((await start())?.gitLogins).toBeUndefined();
});

test("team work reaches only what the team's GitHub App is installed on", async () => {
  await server.api("/api/plugins/git-hosts/connect", {
    body: {
      host: enterprise,
      token: goodToken,
    },
  });

  await createApp();

  await until(() => minted > 0);

  const search = async (team: boolean): Promise<readonly string[]> =>
    (
      (await (
        await server.api(
          `/api/plugins/git-hosts/repositories?q=${team ? "&team" : ""}`,
        )
      ).json()) as { name: string }[]
    ).map(({ name }) => name);

  expect(await search(true)).toEqual([]);

  await server.api("/api/plugins/git-hosts/technical-users/pipoca-bot", {
    method: "PATCH",
    body: {
      team: true,
    },
  });

  expect(await search(true)).toEqual(["I572543/pi-aicore-provider"]);
  expect(await search(false)).toContain("I572543/dotfiles");

  const { environment, key } = (await (
    await server.api("/api/environments", {
      body: { name: "pods", team: true },
    })
  ).json()) as { environment: { id: string }; key: string };

  const profile = (await (
    await server.api("/api/profiles", {
      body: { name: "Team work", team: true },
    })
  ).json()) as { id: string };

  const { token } = (await (
    await fetch(new URL("/agent/join", server.url), {
      method: "POST",
      headers: {
        [versionHeader]: String(protocolVersion),
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "pod-1" }),
    })
  ).json()) as { token: string };

  // A folder names no account, and the base Profile's packages still need
  // the App's token to install.
  await server.api("/api/sessions", {
    body: {
      team: true,
      environment: environment.id,
      profile: profile.id,
      workspace: { kind: "folder", path: "/srv/a" },
    },
  });

  expect((await polled(token))?.gitLogins).toEqual([
    { host: enterprise, token: "ghs_installation" },
  ]);
});
