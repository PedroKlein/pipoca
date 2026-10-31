import { afterEach, beforeEach, expect, test } from "bun:test";
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
import { serve } from "./serve";
import { readSse } from "./sse";
import { runnerCredentials } from "./testdata/runners";
import { firstUser } from "./testdata/sign-in";

const enterprise = "github.tools.sap";
const goodToken = "ghp_good";

let logs: string[];
let configDir: string;
let server: ReturnType<typeof serve>;
let pedro: () => Promise<string>;
let host: ReturnType<typeof Bun.serve>;

// Command streams the tests opened, closed before their server stops.
let streams: AsyncGenerator[];

// The pull request the host knows, which tests change between polls.
let pull: {
  checks: "pending" | "failure" | "success";
  mergeable: boolean;
  merged: boolean;
  comments: { id: number; login: string; body: string }[];
  mergedWith: string | undefined;
};

const pullUrl = `https://${enterprise}/I572543/dotfiles/pull/7`;

beforeEach(() => {
  logs = [];
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

  server = serve({
    port: 0,
    database: ":memory:",
    configDir,
    sessions: { pollWaitMs: 0 },
    log: (message, fields) => {
      logs.push(`${message} ${JSON.stringify(fields)}`);
    },
  });

  pedro = firstUser(server, logs);
});

afterEach(async () => {
  await Promise.all(streams.map(async (stream) => stream.return(undefined)));

  await server.stop();
  await host.stop();
});

async function api(
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return fetch(new URL(path, server.url), {
    method,
    redirect: "manual",
    headers: {
      cookie: await pedro(),
      ...(body !== undefined && { "content-type": "application/json" }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}

// What a runner gets for a new Session of Pedro's.
async function assignment(): Promise<Assignment | undefined> {
  const token = await runnerToken();

  await api("POST", "/api/sessions", {
    workspace: { kind: "folder", path: "/srv/a" },
  });

  return polled(token);
}

async function runnerToken(): Promise<string> {
  return runnerCredentials(server, pedro).token("laptop", "laptops");
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

  await api("POST", "/api/sessions", {
    workspace: { kind: "folder", path: "/srv/a" },
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
  await api("POST", "/api/plugins/git-hosts/connect", {
    host: enterprise,
    token: goodToken,
  });

  await api("PATCH", "/api/plugins/git-hosts", {
    settings: { pollSeconds: 1 },
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
    await api(
      "GET",
      `/api/plugins/git-hosts/pull-requests?session=${sessionId}`,
    )
  ).json();
}

test("lists only github.com when the config file names no hosts", async () => {
  writeFileSync(join(configDir, "pipoca.json"), "{}");

  const account = await (
    await api("GET", "/api/plugins/git-hosts/account")
  ).json();

  expect(account).toMatchObject({
    hosts: [{ host: "github.com", label: "GitHub", oauth: false }],
    connections: [],
  });
});

test("connects a host with a token and signs the person's Sessions in with it", async () => {
  const connected = await api("POST", "/api/plugins/git-hosts/connect", {
    host: enterprise,
    token: goodToken,
  });

  const page = await connected.text();

  expect(connected.status).toBe(200);
  expect(page).toContain('"login":"pedro-sap"');
  expect(page).not.toContain(goodToken);

  expect((await assignment())?.gitLogins).toEqual([
    { host: enterprise, token: goodToken },
  ]);

  expect(logs.join("\n")).not.toContain(goodToken);
});

test("signs the coordinator of a Project in with the git logins of the person who started it", async () => {
  await api("POST", "/api/plugins/git-hosts/connect", {
    host: enterprise,
    token: goodToken,
  });

  const token = await runnerToken();

  const created = await api("POST", "/api/plugins/projects/projects", {
    name: "Release",
    repositories: [`https://${enterprise}/I572543/pi-aicore-provider.git`],
  });

  expect(created.status).toBe(200);

  expect((await polled(token))?.gitLogins).toEqual([
    { host: enterprise, token: goodToken },
  ]);
});

test("sends no login for a host after the person disconnects it", async () => {
  await api("POST", "/api/plugins/git-hosts/connect", {
    host: enterprise,
    token: goodToken,
  });

  await api(
    "DELETE",
    `/api/plugins/git-hosts/connections/${encodeURIComponent(enterprise)}`,
  );

  expect((await assignment())?.gitLogins).toBeUndefined();
});

test("refuses a token the host doesn't accept, saying so", async () => {
  const refused = await api("POST", "/api/plugins/git-hosts/connect", {
    host: enterprise,
    token: "ghp_wrong",
  });

  expect(refused.status).toBe(400);

  expect(await refused.json()).toEqual({
    error: "bad_request",
    message: `${enterprise} doesn't accept this token`,
  });
});

test("keeps a host's OAuth secret sealed in pipoca.json and out of the page", async () => {
  const added = await api("POST", "/api/plugins/git-hosts/hosts", {
    host: "GitHub.example.com",
    label: "Example",
    clientId: "Iv1.abc",
    clientSecret: "shh",
  });

  expect(added.status).toBe(201);

  expect(await added.json()).toEqual({
    host: "github.example.com",
    label: "Example",
    clientId: "Iv1.abc",
    hasClientSecret: true,
    clientSecretEnv: null,
  });

  const file = readFileSync(join(configDir, "pipoca.json"), "utf8");

  expect(file).toContain('"clientId": "Iv1.abc"');
  expect(file).not.toContain("shh");

  const account = await (
    await api("GET", "/api/plugins/git-hosts/account")
  ).json();

  expect(account).toMatchObject({
    hosts: [
      { host: enterprise, oauth: false },
      { host: "github.example.com", oauth: true },
    ],
  });
});

test("won't save over hosts edited by hand into a list that doesn't fit", async () => {
  await api("GET", "/api/plugins/git-hosts/hosts");

  const edited = JSON.stringify({
    "git-hosts": { hosts: [{ host: enterprise, api: "ftp://nowhere" }] },
  });

  writeFileSync(join(configDir, "pipoca.json"), edited);

  const added = await api("POST", "/api/plugins/git-hosts/hosts", {
    host: "github.example.com",
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
            oauth: { clientId: "Iv1.abc", clientSecretEnv: "SAP_SECRET" },
          },
        ],
      },
    }),
  );

  process.env["SAP_SECRET"] = "shh";

  const started = await api(
    "GET",
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
  await api("POST", "/api/plugins/git-hosts/connect", {
    host: enterprise,
    token: goodToken,
  });

  const found = await (
    await api("GET", "/api/plugins/git-hosts/repositories?q=aicore")
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
  await api("POST", "/api/plugins/git-hosts/connect", {
    host: enterprise,
    token: goodToken,
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
  await api("POST", "/api/plugins/git-hosts/connect", {
    host: enterprise,
    token: goodToken,
  });

  const { answer } = await repositoriesTool({});

  expect(answer).toEqual({
    isError: false,
    text: `Signed in on ${enterprise} (SAP GitHub) as pedro-sap.\n\nGive a query to search their repositories by name.`,
  });
});

test("tells a Session the person hasn't connected the host it asked to search", async () => {
  await api("POST", "/api/plugins/git-hosts/connect", {
    host: enterprise,
    token: goodToken,
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
  await api("POST", "/api/plugins/git-hosts/preferences", {
    autoFix: true,
    reply: true,
  });

  const session = await watching();

  pull.checks = "failure";

  expect((await session.next("notice"))["text"]).toContain(
    "End each reply with a line that reads: via Pipoca",
  );
}, 15_000);

test("keeps a pull request's news on its card when the person turned auto-fix off", async () => {
  await api("POST", "/api/plugins/git-hosts/preferences", {
    autoFix: false,
    reply: false,
  });

  await api("POST", "/api/plugins/git-hosts/connect", {
    host: enterprise,
    token: goodToken,
  });

  await api("PATCH", "/api/plugins/git-hosts", {
    settings: { pollSeconds: 1 },
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

  expect(logs.join("\n")).not.toContain("pull request news sent");
}, 15_000);

test("merges a watched pull request the way its repository allows, and stops watching", async () => {
  const session = await watching();
  const [{ id }] = (await watched(session.id)) as [{ id: string }];

  const merged = await api(
    "POST",
    `/api/plugins/git-hosts/pull-requests/${id}/merge`,
    {},
  );

  expect(merged.status).toBe(200);
  expect(pull.mergedWith).toBe("squash");
  expect(await watched(session.id)).toEqual([]);
}, 15_000);
