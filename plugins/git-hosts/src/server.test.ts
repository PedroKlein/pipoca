import { expect, test } from "bun:test";
import { createHmac, createVerify, generateKeyPairSync } from "node:crypto";
import {
  person,
  type PluginTest,
  type TestPluginOptions,
  type TestSession,
  testPlugin,
  until,
} from "@pipoca/testing";
import type { gitHosts } from "../plugin";
import { server } from "./server";

const host = "git.example.com";
const api = `https://${host}/api/v3`;
const goodToken = "ghp_good";
const pullUrl = `https://${host}/acme/dotfiles/pull/7`;

const people = [
  { id: "pedro", name: "Pedro", admin: true },
  { id: "ana", name: "Ana" },
];

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

interface Pull {
  checks: "pending" | "failure" | "success";
  mergeable: boolean;
  merged: boolean;
  comments: { id: number; login: string; body: string }[];
  mergedWith: string | undefined;
  // Answers the next read of the pull request with a sign-in page, as an
  // SSO proxy in front of the host does.
  pageOnce: boolean;
  // Holds reads of the checks until it settles, to catch a poll midway.
  held: Promise<void> | undefined;
}

// The host's REST API, which knows one person's token and one App.
function fakeHost(now: () => number) {
  const pull: Pull = {
    checks: "pending",
    mergeable: true,
    merged: false,
    comments: [],
    mergedWith: undefined,
    pageOnce: false,
    held: undefined,
  };

  const asked: string[] = [];

  const repository = (name: string): unknown => ({
    full_name: name,
    clone_url: `https://${host}/${name}.git`,
  });

  const answer = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const authorization = request.headers.get("authorization");

    asked.push(`${request.method} ${url.pathname}`);

    if (url.origin !== `https://${host}`) {
      return Response.json({ message: "Not Found" }, { status: 404 });
    }

    if (url.pathname === "/login/oauth/access_token") {
      const { code } = (await request.json()) as { code?: unknown };

      return Response.json(
        code === "c0de"
          ? { access_token: goodToken }
          : { error: "bad_verification_code" },
      );
    }

    switch (url.pathname) {
      case "/api/v3/app-manifests/m4nifest/conversions":
        return Response.json(
          {
            id: 42,
            slug: "pipoca-bot",
            html_url: `https://${host}/github-apps/pipoca-bot`,
            pem: appKey.privateKey,
            webhook_secret: "hook-secret",
          },
          { status: 201 },
        );
      case "/api/v3/app/installations/7/access_tokens":
        return signedByApp(authorization)
          ? Response.json(
              {
                token: "ghs_installation",
                expires_at: new Date(now() + 3_600_000).toISOString(),
              },
              { status: 201 },
            )
          : Response.json({ message: "Bad JWT" }, { status: 401 });
      case "/api/v3/app/installations":
        return signedByApp(authorization)
          ? Response.json([{ id: 7, account: { login: "acme" } }])
          : Response.json({ message: "Bad JWT" }, { status: 401 });
      case "/api/v3/users/pipoca-bot%5Bbot%5D":
        return Response.json({ id: 99, login: "pipoca-bot[bot]" });
      case "/api/v3/installation/repositories":
        return authorization === "Bearer ghs_installation"
          ? Response.json({ repositories: [repository("acme/aicore-bot")] })
          : Response.json({ message: "Bad credentials" }, { status: 401 });
    }

    if (authorization !== `Bearer ${goodToken}`) {
      return Response.json({ message: "Bad credentials" }, { status: 401 });
    }

    const repo = "/api/v3/repos/acme/dotfiles";

    switch (url.pathname) {
      case `${repo}/pulls/7`:
        if (pull.pageOnce) {
          pull.pageOnce = false;

          return new Response("<html>Sign in</html>", {
            headers: { "content-type": "text/html" },
          });
        }

        return Response.json({
          html_url: pullUrl,
          title: "Tidy the dotfiles",
          state: pull.merged ? "closed" : "open",
          merged: pull.merged,
          mergeable: pull.mergeable,
          head: { sha: "abc1234def" },
        });
      case `${repo}/commits/abc1234def/check-runs`:
        await pull.held;

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
        return Response.json({ login: "pedro-gh" });
      case "/api/v3/user/repos":
        return Response.json([
          repository("acme/aicore-provider"),
          repository("acme/dotfiles"),
          ...Array.from({ length: 30 }, (_, at) =>
            repository(`acme/tool-${String(at)}`),
          ),
        ]);
      case "/api/v3/search/repositories":
        return Response.json({
          items: [
            repository("acme/aicore-provider"),
            repository("ai-core/aicore-sdk"),
          ],
        });
      default:
        return Response.json({ message: "Not Found" }, { status: 404 });
    }
  };

  return { pull, asked, answer };
}

type Config = NonNullable<TestPluginOptions<typeof gitHosts>["config"]>;

const listed: Config = {
  hosts: [{ host, label: "Example Git", api }],
};

async function start(config: Config | null = listed) {
  let clock = (): number => 0;
  const fake = fakeHost(() => clock());

  const t = await testPlugin(server, {
    people,
    ...(config !== null && { config }),
    fetch: fake.answer,
  });

  clock = t.clock.now;

  return { t, fake, [Symbol.asyncDispose]: t.close };
}

async function connected(t: PluginTest, who = "pedro"): Promise<void> {
  await t.as(who).post("connect", { host, token: goodToken });
}

// Pedro's Session watching the pull request, after its first poll.
async function watching(t: PluginTest): Promise<TestSession> {
  await connected(t);
  const session = await t.session({ owner: person("pedro") });

  expect(
    await t.tool("git_hosts_watch", { url: pullUrl }, { session }),
  ).toEqual({
    text: `Watching ${pullUrl}. Its news will come here.`,
    isError: false,
  });

  await t.clock.advance(0);

  return session;
}

async function watched(t: PluginTest, session: TestSession): Promise<unknown> {
  return t.as("pedro").get("pull-requests", { session: session.id });
}

function notices(session: TestSession): readonly string[] {
  return session
    .delivered()
    .flatMap(({ text, notice }) => (notice === undefined ? [] : [text]));
}

// Starts the manifest flow for the Pipoca bot App, as Settings does.
async function startApp(t: PluginTest): Promise<{
  readonly state: string;
  readonly manifest: Record<string, unknown>;
  readonly cookie: string;
}> {
  const started = await t
    .as("pedro")
    .raw(
      `technical-users/new-app?host=${host}&name=Pipoca%20bot&organization=acme`,
      { method: "GET" },
    );

  const form = await started.text();
  const action = /action="([^"]+)"/.exec(form)?.[1] ?? "";
  const target = new URL(action.replaceAll("&#38;", "&"));

  const manifest = JSON.parse(
    (/name="manifest" value="([^"]+)"/.exec(form)?.[1] ?? "").replace(
      /&#(\d+);/g,
      (_, code: string) => String.fromCharCode(Number(code)),
    ),
  ) as Record<string, unknown>;

  expect(target.origin + target.pathname).toBe(
    `https://${host}/organizations/acme/settings/apps/new`,
  );

  return {
    state: target.searchParams.get("state") ?? "",
    manifest,
    cookie: (started.headers.get("set-cookie") ?? "").split(";")[0] ?? "",
  };
}

// Creates the Pipoca bot App, installed on acme, and mints its token.
async function createApp(t: PluginTest): Promise<void> {
  const { state, cookie } = await startApp(t);

  const created = await t
    .public()
    .raw(`app-created?code=m4nifest&state=${state}`, {
      method: "GET",
      headers: { cookie },
    });

  expect(created.status).toBe(200);
  await t.clock.advance(0);
}

test("lists only github.com when the config file names no hosts", async () => {
  await using run = await start(null);
  const { t } = run;

  expect(await t.as("ana").get("account")).toEqual({
    admin: false,
    hosts: [{ host: "github.com", label: "GitHub", oauth: false }],
    connections: [],
  });
});

test("connects a host with a token and signs the person's Sessions in with it", async () => {
  await using run = await start();
  const { t } = run;

  const answered = await t.as("pedro").raw("connect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ host, token: goodToken }),
  });

  const page = await answered.text();

  expect(answered.status).toBe(200);
  expect(page).toContain('"login":"pedro-gh"');
  expect(page).not.toContain(goodToken);

  const session = await t.session({ owner: person("pedro") });

  expect(session.gitLogins()).toEqual([{ host, token: goodToken }]);
  expect(JSON.stringify(t.log)).not.toContain(goodToken);

  const others = await t.session({ owner: person("ana") });

  expect(others.gitLogins()).toEqual([]);
});

test("tells admins how many people connected on each host", async () => {
  await using run = await start();
  const { t } = run;

  await connected(t);

  expect(
    (
      await t.as("pedro").get<{ host: string; connected: number }[]>("hosts")
    ).map((each) => [each.host, each.connected]),
  ).toEqual([[host, 1]]);

  expect((await t.as("ana").raw("hosts", { method: "GET" })).status).toBe(403);
});

test("sends no login for a host after the person disconnects it", async () => {
  await using run = await start();
  const { t } = run;

  await connected(t);
  await t.as("pedro").delete(`connections/${host}`);

  expect((await t.session({ owner: person("pedro") })).gitLogins()).toEqual([]);
});

test("refuses a token the host doesn't accept, saying so", async () => {
  await using run = await start();
  const { t } = run;

  const refused = await t.as("pedro").raw("connect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ host, token: "ghp_wrong" }),
  });

  expect(refused.status).toBe(400);

  expect(await refused.json()).toEqual({
    error: "bad_request",
    message: `${host} doesn't accept this token`,
  });
});

// The Settings list shows GitHub, the default, beside the host an admin
// adds, each once, though both have tokens only.
test("lists a host an admin adds once, beside the default github.com", async () => {
  await using run = await start(null);
  const { t } = run;

  await t.as("pedro").post("hosts", { host: "git.example.com" });

  const again = await t.as("pedro").raw("hosts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ host: "git.example.com" }),
  });

  expect(again.status).toBe(400);

  expect(await t.as("pedro").get("hosts")).toEqual([
    expect.objectContaining({ host: "github.com", hasClientSecret: false }),
    expect.objectContaining({
      host: "git.example.com",
      hasClientSecret: false,
    }),
  ]);
});

test("keeps a host's OAuth secret sealed in pipoca.json and out of the page", async () => {
  await using run = await start();
  const { t } = run;

  expect(
    await t.as("pedro").post("hosts", {
      host: "GitHub.example.org",
      label: "Example",
      clientId: "Iv1.abc",
      clientSecret: "shh",
    }),
  ).toEqual({
    host: "github.example.org",
    label: "Example",
    clientId: "Iv1.abc",
    hasClientSecret: true,
    connected: 0,
  });

  const stored = JSON.stringify(await t.config());

  expect(stored).toContain('"clientId":"Iv1.abc"');
  expect(stored).not.toContain("shh");

  // A change that leaves the secret out keeps it.
  await t.as("pedro").post("hosts/github.example.org", {
    label: "Renamed",
    clientId: "Iv1.abc",
  });

  expect(JSON.stringify(await t.config())).toBe(
    stored.replace('"label":"Example"', '"label":"Renamed"'),
  );

  expect(await t.as("ana").get("account")).toMatchObject({
    hosts: [
      { host, oauth: false },
      { host: "github.example.org", oauth: true },
    ],
  });
});

test("leaves out a host edited by hand that doesn't fit, and keeps it in the file", async () => {
  await using run = await start({
    hosts: [
      { host, api },
      { host: "broken.example.org", api: "ftp://nowhere" },
    ],
  });
  const { t } = run;

  expect(
    (await t.as("pedro").get<{ host: string }[]>("hosts")).map(
      (each) => each.host,
    ),
  ).toEqual([host]);

  await t.as("pedro").post("hosts", { host: "new.example.org" });

  expect((await t.config()) as { hosts: { host: string }[] }).toMatchObject({
    hosts: [
      { host },
      { host: "broken.example.org", api: "ftp://nowhere" },
      { host: "new.example.org" },
    ],
  });

  expect(t.log.map(({ message }) => message)).toContain("config item skipped");
});

test("connects an account through the host's OAuth app, only in the browser that started it", async () => {
  process.env["EXAMPLE_SECRET"] = "shh";

  await using run = await start({
    hosts: [
      {
        host,
        api,
        oauth: { clientId: "Iv1.abc", clientSecret: { env: "EXAMPLE_SECRET" } },
      },
    ] as never,
  });
  const { t } = run;

  const sent = await t.as("pedro").raw(`sign-in/${host}`, { method: "GET" });
  const location = new URL(sent.headers.get("location") ?? "");
  const state = location.searchParams.get("state") ?? "";
  const cookie = (sent.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

  expect(sent.status).toBe(302);

  expect(location.origin + location.pathname).toBe(
    `https://${host}/login/oauth/authorize`,
  );

  expect(location.searchParams.get("client_id")).toBe("Iv1.abc");

  expect(location.searchParams.get("redirect_uri")).toEndWith(
    "/api/ext/git-hosts/callback",
  );

  expect(sent.headers.get("set-cookie")).toContain("HttpOnly");
  expect(sent.headers.get("set-cookie")).toContain("SameSite=Lax");
  expect(process.env["EXAMPLE_SECRET"]).toBeUndefined();

  const elsewhere = await t
    .public()
    .raw(`callback?state=${state}&code=c0de`, { method: "GET" });

  expect(elsewhere.status).toBe(400);
  expect(await t.as("pedro").get("account")).toMatchObject({ connections: [] });

  const back = await t.public().raw(`callback?state=${state}&code=c0de`, {
    method: "GET",
    headers: { cookie },
  });

  expect(back.status).toBe(200);
  expect(await back.text()).toContain("#settings/accounts");

  expect(await t.as("pedro").get("account")).toMatchObject({
    connections: [{ host, login: "pedro-gh" }],
  });

  const again = await t.public().raw(`callback?state=${state}&code=c0de`, {
    method: "GET",
    headers: { cookie },
  });

  expect(again.status).toBe(400);
});

test("finds the repositories of each connected host for what the person typed", async () => {
  await using run = await start();
  const { t } = run;

  await connected(t);

  expect(await t.as("pedro").get("repositories", { q: "aicore" })).toEqual([
    {
      url: `https://${host}/acme/aicore-provider.git`,
      name: "acme/aicore-provider",
      group: "Example Git",
    },
    {
      url: `https://${host}/ai-core/aicore-sdk.git`,
      name: "ai-core/aicore-sdk",
      group: "Example Git",
    },
  ]);
});

test("gives a Session the person's accounts and real repository URLs instead of a guess", async () => {
  await using run = await start();
  const { t } = run;

  await connected(t);
  const session = await t.session({ owner: person("pedro") });

  expect(
    await t.tool("git_hosts_repositories", { query: "aicore" }, { session }),
  ).toEqual({
    isError: false,
    text: [
      `Signed in on ${host} (Example Git) as pedro-gh.`,
      [
        'Repositories whose name holds "aicore":',
        `- ${host} acme/aicore-provider https://${host}/acme/aicore-provider.git`,
        `- ${host} ai-core/aicore-sdk https://${host}/ai-core/aicore-sdk.git`,
      ].join("\n"),
    ].join("\n\n"),
  });
});

test("names at most ten repositories, and asks for a longer query beyond that", async () => {
  await using run = await start();
  const { t } = run;

  await connected(t);
  const session = await t.session({ owner: person("pedro") });

  const { text } = await t.tool(
    "git_hosts_repositories",
    { query: "tool" },
    { session },
  );

  expect(text.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(
    10,
  );

  expect(text).toEndWith("and 22 more; give a longer query to narrow it.");
});

test("names only the person's accounts when a Session searches for nothing", async () => {
  await using run = await start();
  const { t, fake } = run;

  await connected(t);
  const session = await t.session({ owner: person("pedro") });
  const asked = fake.asked.length;

  expect(await t.tool("git_hosts_repositories", {}, { session })).toEqual({
    isError: false,
    text: `Signed in on ${host} (Example Git) as pedro-gh.\n\nGive a query to search their repositories by name.`,
  });

  expect(fake.asked).toHaveLength(asked);
});

test("tells a Session where the person connects a git host when they have none, or not the one it asked for", async () => {
  await using run = await start();
  const { t } = run;

  const session = await t.session({ owner: person("pedro") });

  expect(await t.tool("git_hosts_repositories", {}, { session })).toEqual({
    isError: false,
    text: "The user hasn't connected a git host. They can connect one in Pipoca's Settings, under Git hosts.",
  });

  await connected(t);

  expect(
    await t.tool(
      "git_hosts_repositories",
      { query: "aicore", host: "github.com" },
      { session },
    ),
  ).toEqual({
    isError: false,
    text: "The user hasn't connected github.com. They can connect it in Pipoca's Settings, under Git hosts.",
  });
});

test("offers its tools to a person's Sessions, never to team work", async () => {
  await using run = await start();
  const { t } = run;

  const team = await t.session({ owner: "team", startedBy: "pedro" });

  expect(
    t.tool("git_hosts_repositories", {}, { session: team }),
  ).rejects.toThrow("isn't offered");

  expect(
    t.tool("git_hosts_watch", { url: pullUrl }, { session: team }),
  ).rejects.toThrow("isn't offered");
});

test("tells the Session watching a pull request that its checks failed, with the rules first", async () => {
  await using run = await start();
  const { t, fake } = run;

  const session = await watching(t);

  fake.pull.checks = "failure";
  await t.clock.advance("60s");

  const [news] = notices(session);

  expect(news).toStartWith(
    `News on ${pullUrl}:\n- Checks failed on abc1234: test (https://ci.example/test)\n\nYou are watching this pull request.`,
  );

  expect(news).toContain(
    "Never comment, review or reply on GitHub as the user.",
  );

  expect(await watched(t, session)).toMatchObject([
    {
      url: pullUrl,
      title: "Tidy the dotfiles",
      state: "open",
      checks: { passed: 0, failed: 1, pending: 0 },
      autoFix: true,
    },
  ]);

  expect(t.topics).toContain("git-hosts.pull-requests");
});

test("passes on new review comments and conflicts without repeating the rules", async () => {
  await using run = await start();
  const { t, fake } = run;

  const session = await watching(t);

  fake.pull.checks = "failure";
  await t.clock.advance("60s");

  fake.pull.comments = [
    { id: 1, login: "reviewer", body: "Rename this alias" },
  ];

  fake.pull.mergeable = false;
  await t.clock.advance("60s");

  expect(notices(session).at(-1)).toBe(
    [
      `News on ${pullUrl}:`,
      `- reviewer commented on zshrc: Rename this alias (${pullUrl}#discussion_r1)`,
      "- It has a merge conflict with its base branch. Merge the base branch in, resolve it, and push.",
    ].join("\n"),
  );
});

test("polls as often as the config says", async () => {
  await using run = await start({ ...listed, pollSeconds: 600 });
  const { t, fake } = run;

  const session = await watching(t);

  fake.pull.checks = "failure";
  await t.clock.advance("60s");

  expect(notices(session)).toEqual([]);

  await t.clock.advance("540s");

  expect(notices(session)).toHaveLength(1);
});

test("lets the Session reply on GitHub only when the person chose so", async () => {
  await using run = await start();
  const { t, fake } = run;

  await t.as("pedro").post("preferences", { autoFix: true, reply: true });
  const session = await watching(t);

  fake.pull.checks = "failure";
  await t.clock.advance("60s");

  expect(notices(session)[0]).toContain(
    "End each reply with a line that reads: via Pipoca",
  );
});

test("keeps a pull request's news on its card when the person turned auto-fix off", async () => {
  await using run = await start();
  const { t, fake } = run;

  await t.as("pedro").post("preferences", { autoFix: false, reply: false });
  await connected(t);
  const session = await t.session({ owner: person("pedro") });

  expect(
    (await t.tool("git_hosts_watch", { url: pullUrl }, { session })).text,
  ).toContain("Auto-fix is off for it");

  fake.pull.checks = "failure";
  await t.clock.advance("60s");

  expect(await watched(t, session)).toMatchObject([
    { checks: { failed: 1 }, autoFix: false },
  ]);

  expect(notices(session)).toEqual([]);
});

test("tells a Session that was offline its pull request's news once it is back", async () => {
  await using run = await start();
  const { t, fake } = run;

  const session = await watching(t);
  await session.online(false);

  fake.pull.checks = "failure";
  await t.clock.advance("60s");

  expect(session.queued()).toHaveLength(1);

  await session.online(true);

  expect(notices(session)[0]).toStartWith(`News on ${pullUrl}:`);
});

test("watches the pull requests the Session part reports, and keeps polling them after a restart", async () => {
  await using run = await start();
  const { t, fake } = run;

  await connected(t);
  const session = await t.session({ owner: person("pedro") });

  expect(
    await session.api.post("pull-requests", { url: pullUrl }),
  ).toMatchObject({ url: pullUrl, state: "open" });

  await t.clock.advance(0);
  await t.restart();

  fake.pull.checks = "failure";
  await t.clock.advance("60s");

  expect(notices(session)).toHaveLength(1);
});

test("stops watching for a Session that was archived", async () => {
  await using run = await start();
  const { t } = run;

  const session = await watching(t);
  await session.archive();
  await t.clock.advance("60s");

  expect(await watched(t, session)).toEqual([]);
});

test("lists the team's watched pull requests on the team half, and a person's own on theirs", async () => {
  await using run = await start();
  const { t } = run;

  await watching(t);
  const team = await t.session({ owner: "team", startedBy: "pedro" });
  const teamUrl = `https://${host}/acme/site/pull/8`;

  t.store.run(
    "insert into git_hosts_watches (id, session_id, user_id, url, host, repository, number, auto_fix) values (?, ?, ?, ?, ?, ?, ?, 0)",
    "w-team",
    team.id,
    "pedro",
    teamUrl,
    host,
    "acme/site",
    8,
  );

  expect(await t.as("ana").get("team/watched")).toEqual([
    expect.objectContaining({
      url: teamUrl,
      title: "acme/site#8",
      repository: "acme/site",
      state: "open",
    }) as unknown,
  ]);

  expect(await t.as("pedro").get("watched")).toEqual([
    expect.objectContaining({
      url: pullUrl,
      title: "Tidy the dotfiles",
      repository: "acme/dotfiles",
      checks: { passed: 0, failed: 0, pending: 1 },
    }) as unknown,
  ]);

  expect(await t.as("ana").get("watched")).toEqual([]);
});

test("merges a watched pull request the way its repository allows, and stops watching", async () => {
  await using run = await start();
  const { t, fake } = run;

  const session = await watching(t);
  const [{ id }] = (await watched(t, session)) as [{ id: string }];

  expect(await t.as("pedro").post(`pull-requests/${id}/merge`)).toEqual({
    merged: pullUrl,
  });

  expect(fake.pull.mergedWith).toBe("squash");
  expect(await watched(t, session)).toEqual([]);

  expect(
    (await t.as("ana").raw(`pull-requests/${id}/merge`, { method: "POST" }))
      .status,
  ).toBe(404);
});

test("creates a GitHub App from a manifest as a technical user, with its key sealed", async () => {
  await using run = await start();
  const { t } = run;

  const { state, manifest, cookie } = await startApp(t);

  expect(manifest).toMatchObject({ name: "Pipoca bot", public: false });

  expect(String(manifest["redirect_url"])).toEndWith(
    "/api/ext/git-hosts/app-created",
  );

  const callback = `app-created?code=m4nifest&state=${state}`;

  expect((await t.public().raw(callback, { method: "GET" })).status).toBe(400);

  expect(
    (await t.public().raw(callback, { method: "GET", headers: { cookie } }))
      .status,
  ).toBe(200);

  expect(await t.as("pedro").get("technical-users")).toEqual([
    {
      name: "pipoca-bot",
      host,
      kind: "app",
      login: "pipoca-bot[bot]",
      team: false,
      installUrl: `https://${host}/github-apps/pipoca-bot/installations/new`,
      installedOn: ["acme"],
      error: null,
    },
  ]);

  const stored = JSON.stringify(await t.config());

  expect(stored).toContain('"pipoca-bot"');
  expect(stored).not.toContain("PRIVATE KEY");
  expect(stored).not.toContain("hook-secret");
});

test("adds a machine user by a token its host accepts, and removes it", async () => {
  await using run = await start();
  const { t } = run;

  const add = async (token: string): Promise<Response> =>
    t.as("pedro").raw("technical-users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "ci-bot", host, token }),
    });

  expect((await add("ghp_bad")).status).toBe(400);

  const created = await add(goodToken);

  expect(created.status).toBe(201);
  expect(await created.json()).toEqual({ name: "ci-bot", login: "pedro-gh" });
  expect((await add(goodToken)).status).toBe(400);
  expect(JSON.stringify(await t.config())).not.toContain(goodToken);

  expect(await t.as("pedro").delete("technical-users/ci-bot")).toEqual({
    removed: "ci-bot",
  });

  expect(await t.as("pedro").get("technical-users")).toEqual([]);
});

test("signs a Session acting as a GitHub App in as it, and commits as its bot", async () => {
  await using run = await start();
  const { t } = run;

  await connected(t);
  await createApp(t);

  const acting = await t.session({
    owner: person("pedro"),
    actsAs: { plugin: "git-hosts", name: "pipoca-bot" },
    workspace: {
      kind: "clone",
      repository: `https://${host}/acme/dotfiles.git`,
    },
  });

  expect(acting.gitLogins()).toEqual([{ host, token: "ghs_installation" }]);

  expect(await acting.api.get("identity")).toEqual({
    name: "pipoca-bot[bot]",
    email: `99+pipoca-bot[bot]@users.noreply.${host}`,
  });
});

test("gives no git login to a Session acting as a technical user its person may not use", async () => {
  await using run = await start();
  const { t } = run;

  await connected(t, "ana");
  await createApp(t);

  const acting = await t.session({
    owner: person("ana"),
    actsAs: { plugin: "git-hosts", name: "pipoca-bot" },
  });

  expect(acting.gitLogins()).toEqual([]);

  const unknown = await t.session({
    owner: person("ana"),
    actsAs: { plugin: "git-hosts", name: "someone-elses-bot" },
  });

  expect(unknown.gitLogins()).toEqual([]);
});

test("has a person's Sessions commit as the name and email they chose", async () => {
  await using run = await start();
  const { t } = run;

  const session = await t.session({ owner: person("pedro") });

  expect(await session.api.get("identity")).toBeNull();

  expect(
    (
      await t.as("pedro").raw("commit-as", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Pedro Klein", email: "" }),
      })
    ).status,
  ).toBe(400);

  const chosen = { name: "Pedro Klein", email: "pedro@example.com" };
  await t.as("pedro").post("commit-as", chosen);

  expect(await t.as("pedro").get("commit-as")).toEqual(chosen);
  expect(await session.api.get("identity")).toEqual(chosen);
});

test("turns a GitHub App's signed webhooks into events for the people who may use it", async () => {
  await using run = await start();
  const { t } = run;

  await createApp(t);

  const { technicalUsers } = (await t.config()) as {
    technicalUsers: { app: { hook: string } }[];
  };

  const hook = technicalUsers[0]?.app.hook ?? "";

  const deliver = async (secret: string, to = hook): Promise<number> => {
    const body = JSON.stringify({
      action: "labeled",
      label: { name: "pipoca" },
      repository: { full_name: "acme/dotfiles" },
      sender: { login: "pedro-gh" },
      issue: {
        number: 7,
        title: "zshrc is slow",
        body: "It takes 2 s to start.",
        html_url: `https://${host}/acme/dotfiles/issues/7`,
        user: { login: "pedro-gh" },
        author_association: "OWNER",
        labels: [{ name: "pipoca" }],
      },
    });

    const answered = await t.public().raw(`hooks/${to}`, {
      method: "POST",
      headers: {
        "x-github-event": "issues",
        "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
      },
      body,
    });

    return answered.status;
  };

  expect(await deliver("not-the-secret")).toBe(401);
  expect(await deliver("hook-secret", "elsewhere")).toBe(401);
  expect(t.emitted("git-hosts.issue")).toEqual([]);

  expect(await deliver("hook-secret")).toBe(202);

  expect(t.emitted("git-hosts.issue")).toEqual([
    {
      fields: {
        host,
        repository: "acme/dotfiles",
        action: "labeled",
        sender: "pedro-gh",
        technicalUser: "pipoca-bot",
        author: "pedro-gh",
        member: true,
        number: 7,
        title: "zshrc is slow",
        body: "It takes 2 s to start.",
        url: `https://${host}/acme/dotfiles/issues/7`,
        labels: ["pipoca"],
        label: "pipoca",
      },
      to: [person("pedro")],
    },
  ]);
});

test("signs team work in as the technical user an admin chose for the team on each host", async () => {
  await using run = await start();
  const { t } = run;

  await connected(t);

  for (const name of ["ci-bot", "docs-bot"]) {
    await t
      .as("pedro")
      .post("technical-users", { name, host, token: goodToken });
  }

  const choose = async (name: string, team: boolean): Promise<number> =>
    (
      await t.as("pedro").raw(`technical-users/${name}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ team }),
      })
    ).status;

  expect(await choose("no-bot", true)).toBe(404);
  expect(await choose("ci-bot", true)).toBe(200);
  expect(await choose("docs-bot", true)).toBe(200);

  expect(
    (
      await t
        .as("pedro")
        .get<{ name: string; team: boolean }[]>("technical-users")
    ).map(({ name, team }) => [name, team]),
  ).toEqual([
    ["ci-bot", false],
    ["docs-bot", true],
  ]);

  // Choosing keeps the token's sealed ref as it was.
  expect(JSON.stringify(await t.config())).not.toContain(goodToken);

  const team = await t.session({ owner: "team", startedBy: "pedro" });

  expect(team.gitLogins()).toEqual([{ host, token: goodToken }]);

  await choose("docs-bot", false);

  expect(
    (await t.session({ owner: "team", startedBy: "pedro" })).gitLogins(),
  ).toEqual([]);
});

test("team work reaches only what the team's GitHub App is installed on", async () => {
  await using run = await start();
  const { t } = run;

  await connected(t);
  await createApp(t);

  const search = async (team: boolean): Promise<readonly string[]> =>
    (
      await t
        .as("pedro")
        .get<{ name: string }[]>(team ? "team/repositories" : "repositories", {
          q: "",
        })
    ).map(({ name }) => name);

  expect(await search(true)).toEqual([]);

  await t.as("pedro").patch("technical-users/pipoca-bot", { team: true });

  expect(await search(true)).toEqual(["acme/aicore-bot"]);
  expect(await search(false)).toContain("acme/dotfiles");

  // A folder names no account, and the base Profile's packages still need
  // the App's token to install.
  expect(
    (await t.session({ owner: "team", startedBy: "pedro" })).gitLogins(),
  ).toEqual([{ host, token: "ghs_installation" }]);
});

test("a pull request whose host answers with a page instead of JSON doesn't stop the others' news", async () => {
  await using run = await start();
  const { t, fake } = run;

  const first = await watching(t);
  const second = await t.session({ owner: person("pedro") });
  await t.tool("git_hosts_watch", { url: pullUrl }, { session: second });
  await t.clock.advance(0);

  fake.pull.checks = "failure";
  fake.pull.pageOnce = true;
  await t.clock.advance("60s");

  expect(
    [first, second]
      .map((session) => notices(session).length)
      .sort((a, b) => a - b),
  ).toEqual([0, 1]);

  await t.clock.advance("60s");

  expect([first, second].map((session) => notices(session).length)).toEqual([
    1, 1,
  ]);
});

test("a merge pressed during a poll tells the Session it merged once", async () => {
  await using run = await start();
  const { t, fake } = run;

  const session = await watching(t);
  const [{ id }] = (await watched(t, session)) as [{ id: string }];

  const checks = (): number =>
    fake.asked.filter((each) => each.endsWith("/check-runs")).length;

  let release = (): void => undefined;

  fake.pull.held = new Promise((resolve) => {
    release = resolve;
  });

  fake.pull.merged = true;
  const before = checks();
  const polling = t.clock.advance("60s");
  await until(() => checks() === before + 1);

  const merging = t.as("pedro").post(`pull-requests/${id}/merge`);
  await until(() => fake.pull.mergedWith !== undefined);

  // The merge's own poll reads the checks too only while the first one
  // still goes.
  await until(() => checks() === before + 2, Boolean, 300).catch(
    () => undefined,
  );

  release();
  await Promise.all([polling, merging]);

  expect(
    notices(session).filter((text) => text.includes("It merged.")),
  ).toHaveLength(1);
});
