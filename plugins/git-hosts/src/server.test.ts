import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHmac, createVerify, generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { server as askServer } from "@pipoca/ask/server";
import {
  definePlugin,
  defineServer,
  type PluginActions,
  type PluginDestinations,
  type Questions,
  type Session,
  type Sessions,
} from "@pipoca/plugins";
import {
  person,
  type PluginTest,
  type TestPluginOptions,
  type TestSession,
  testPlugin,
  until,
} from "@pipoca/testing";
import { gitHosts } from "../plugin";
import { server } from "./server";
import type { Account } from "./model";

const host = "git.example.com";
const api = `https://${host}/api/v3`;
const goodToken = "ghp_good";
const botToken = "ghp_team_bot";
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

type Item = Record<string, unknown>;

// acme/aicore-bot, which the App is installed on, as polling reads it. Each
// list answers 304 to the ETag it last gave.
function polledRepository() {
  const repo = {
    issues: [] as Item[],
    pulls: new Map<number, Item>(),
    reviews: new Map<number, Item[]>(),
    comments: [] as Item[],
    reviewComments: [] as Item[],
    branches: { main: "aaa" } as Record<string, string>,
    compares: new Map<string, Item[]>(),
    tags: [] as string[],
    releases: [] as Item[],
    deployments: [] as Item[],
    checkRuns: new Map<string, Item[]>(),
    // Each read, with what it answered.
    answered: [] as string[],
  };

  const since = (items: Item[], url: URL): Item[] => {
    const from = Date.parse(url.searchParams.get("since") ?? "");

    return items.filter(
      (item) => Date.parse(String(item["updated_at"])) >= from,
    );
  };

  const bodyOf = (url: URL): unknown => {
    const path = url.pathname.slice("/api/v3/repos/acme/aicore-bot".length);
    const number = Number(/\/(\d+)/.exec(path)?.[1]);

    switch (path) {
      case "/issues":
        return since(repo.issues, url);
      case "/issues/comments":
        return since(repo.comments, url);
      case "/pulls/comments":
        return since(repo.reviewComments, url);
      case "/branches":
        return Object.entries(repo.branches).map(([name, sha]) => ({
          name,
          commit: { sha },
        }));
      case "/tags":
        return repo.tags.map((name) => ({ name }));
      case "/releases":
        return repo.releases;
      case "/deployments":
        return repo.deployments;
      case `/pulls/${String(number)}`:
        return repo.pulls.get(number);
      case `/pulls/${String(number)}/reviews`:
        return repo.reviews.get(number) ?? [];
    }

    const compared = /^\/compare\/(.+)$/.exec(path)?.[1];

    if (compared !== undefined) {
      return { files: repo.compares.get(compared) ?? [], commits: [] };
    }

    const sha = /^\/commits\/(\w+)\/check-runs$/.exec(path)?.[1];

    return sha === undefined
      ? undefined
      : { check_runs: repo.checkRuns.get(sha) ?? [] };
  };

  const answer = (request: Request): Response => {
    const url = new URL(request.url);
    const body = bodyOf(url);

    if (body === undefined) {
      return Response.json({ message: "Not Found" }, { status: 404 });
    }

    const etag = `"${String(Bun.hash(JSON.stringify(body)))}"`;
    const same = request.headers.get("if-none-match") === etag;

    repo.answered.push(`${same ? "304" : "200"} ${url.pathname}`);

    return same
      ? new Response(null, { status: 304 })
      : Response.json(body, { headers: { etag } });
  };

  return { repo, answer };
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

  const polled = polledRepository();
  const asked: string[] = [];
  // Comments posted on issues and pull requests, with the token each came
  // with.
  const commented: { path: string; token: string; body: string }[] = [];
  // Pull requests opened, with the token each came with.
  const written: { path: string; token: string; body: unknown }[] = [];
  // The token each read of the pull request came with.
  const readWith: string[] = [];

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
                token: (await request.text()).includes('"permissions"')
                  ? "ghs_reading"
                  : "ghs_installation",
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
          ? Response.json({
              repositories: [
                {
                  ...(repository("acme/aicore-bot") as Item),
                  default_branch: "main",
                },
              ],
            })
          : Response.json({ message: "Bad credentials" }, { status: 401 });
    }

    if (
      request.method === "POST" &&
      /^\/api\/v3\/repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/.test(
        url.pathname,
      )
    ) {
      const { body } = (await request.json()) as { body: string };

      commented.push({
        path: url.pathname,
        token: (authorization ?? "").replace("Bearer ", ""),
        body,
      });

      return Response.json(
        {
          id: commented.length,
          html_url: `https://${host}/acme/dotfiles/issues/7#issuecomment-${String(commented.length)}`,
        },
        { status: 201 },
      );
    }

    if (
      authorization === "Bearer ghs_installation" &&
      url.pathname.startsWith("/api/v3/repos/acme/aicore-bot/")
    ) {
      return polled.answer(request);
    }

    if (
      authorization !== `Bearer ${goodToken}` &&
      authorization !== `Bearer ${botToken}`
    ) {
      return Response.json({ message: "Bad credentials" }, { status: 401 });
    }

    const repo = "/api/v3/repos/acme/dotfiles";

    if (
      request.method === "POST" ||
      request.method === "PATCH" ||
      (request.method === "PUT" && url.pathname.startsWith(`${repo}/contents/`))
    ) {
      written.push({
        path: `${request.method} ${url.pathname}`,
        token: authorization.replace("Bearer ", ""),
        body: await request.json(),
      });

      if (url.pathname === `${repo}/pulls`) {
        return Response.json({ html_url: pullUrl }, { status: 201 });
      }

      if (url.pathname.startsWith(`${repo}/contents/`)) {
        return Response.json(
          {
            content: { html_url: `https://${host}/acme/dotfiles/blob/main/x` },
          },
          { status: 201 },
        );
      }
    }

    switch (url.pathname) {
      case `${repo}/pulls`:
        return Response.json([]);
      case `${repo}/pulls/7`:
        readWith.push(authorization.replace("Bearer ", ""));

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
        return Response.json(
          authorization === `Bearer ${botToken}`
            ? { login: "team-bot", name: null, email: "bot@example.com" }
            : { login: "pedro-gh", name: "Pedro Klein", email: null },
        );
      // The bot's token has no user:email scope.
      case "/api/v3/user/emails":
        return authorization === `Bearer ${botToken}`
          ? Response.json({ message: "Not Found" }, { status: 404 })
          : Response.json([
              { email: "old@example.com", verified: false, primary: false },
              { email: "pedro@work.example", verified: true, primary: false },
              { email: "pedro@example.com", verified: true, primary: true },
            ]);
      case "/api/v3/user/repos":
        return Response.json([
          {
            ...(repository("acme/aicore-provider") as Item),
            pushed_at: "2026-11-12T10:00:00Z",
            language: "TypeScript",
          },
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
      case "/api/v3/repos/acme/aicore-provider":
        return Response.json({ default_branch: "main" });
      case "/api/v3/repos/acme/aicore-provider/branches":
        return Response.json([
          { name: "feature/thinking" },
          { name: "main" },
          { name: "release" },
        ]);
      default:
        return Response.json({ message: "Not Found" }, { status: 404 });
    }
  };

  return {
    pull,
    asked,
    readWith,
    commented,
    written,
    answer,
    repo: polled.repo,
  };
}

type Config = NonNullable<TestPluginOptions<typeof gitHosts>["config"]>;

const listed: Config = {
  hosts: [{ host, label: "Example Git", api }],
};

async function start(
  config: Config | null = listed,
  plugins: TestPluginOptions["plugins"] = [],
) {
  let clock = (): number => 0;
  const fake = fakeHost(() => clock());

  const t = await testPlugin(server, {
    people,
    ...(config !== null && { config }),
    fetch: fake.answer,
    plugins,
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
async function startApp(
  t: PluginTest,
  extra = "",
): Promise<{
  readonly state: string;
  readonly manifest: Record<string, unknown>;
  readonly cookie: string;
}> {
  const started = await t
    .as("pedro")
    .raw(
      `technical-users/new-app?host=${host}&name=Pipoca%20bot&organization=acme${extra}`,
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

test("lists no host when the config file names none", async () => {
  await using run = await start(null);
  const { t } = run;

  expect(await t.as("ana").get("account")).toEqual({
    admin: false,
    hosts: [],
    connections: [],
  });

  expect(await t.as("pedro").get("hosts")).toEqual([]);

  const refused = await t.as("ana").raw("connect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ host: "github.com", token: goodToken }),
  });

  expect(refused.status).toBe(400);
  expect((await t.session({ owner: person("ana") })).gitLogins()).toEqual([]);
});

test("lets an admin add a host with its OAuth app from Settings, whose sign-in asks for the person's emails", async () => {
  await using run = await start(null);
  const { t } = run;

  await t.as("pedro").post("hosts", {
    host: "GitHub.com",
    label: "GitHub",
    clientId: "Iv1.abc",
    clientSecret: "shh",
  });

  expect(await t.as("ana").get("account")).toMatchObject({
    hosts: [{ host: "github.com", label: "GitHub", oauth: true }],
  });

  const sent = await t.as("ana").raw("sign-in/github.com", { method: "GET" });
  const location = new URL(sent.headers.get("location") ?? "");

  expect(location.origin + location.pathname).toBe(
    "https://github.com/login/oauth/authorize",
  );

  expect(location.searchParams.get("scope")).toBe("repo read:org user:email");
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

test("lists each host an admin adds once", async () => {
  await using run = await start(null);
  const { t } = run;

  await t.as("pedro").post("hosts", { host: "github.com" });
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
    reach: { private: false, through: [] },
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

test("finds the repositories of each connected host for what the person typed, with when they were pushed", async () => {
  await using run = await start();
  const { t } = run;

  await connected(t);

  expect(await t.as("pedro").get("repositories", { q: "aicore" })).toEqual([
    {
      url: `https://${host}/acme/aicore-provider.git`,
      name: "acme/aicore-provider",
      group: "Example Git",
      host,
      pushedAt: "2026-11-12T10:00:00Z",
      language: "TypeScript",
    },
    {
      url: `https://${host}/ai-core/aicore-sdk.git`,
      name: "ai-core/aicore-sdk",
      group: "Example Git",
      host,
    },
  ]);
});

test("lists a repository's branches, its default first, for where a Session starts from", async () => {
  await using run = await start();
  const { t } = run;

  const branches = async (url: string): Promise<unknown> =>
    t.as("pedro").get("branches", { url });

  expect(await branches(`https://${host}/acme/aicore-provider.git`)).toEqual(
    [],
  );

  await connected(t);

  for (const url of [
    `https://${host}/acme/aicore-provider.git`,
    `git@${host}:acme/aicore-provider.git`,
  ]) {
    expect(await branches(url)).toEqual([
      "main",
      "feature/thinking",
      "release",
    ]);
  }

  expect(await branches(`https://${host}/acme/missing.git`)).toEqual([]);
  expect(await branches("https://elsewhere.example/acme/app.git")).toEqual([]);
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

test("tells a team Session that no bot reaches a host, never searching as its starter", async () => {
  await using run = await start();
  const { t, fake } = run;

  await connected(t);
  const team = await t.session({ owner: "team", startedBy: "pedro" });
  const asked = fake.asked.length;

  expect(
    await t.tool(
      "git_hosts_repositories",
      { query: "aicore" },
      { session: team },
    ),
  ).toEqual({
    isError: false,
    text: "No bot signs team work in to a git host, so it reaches no repository. An admin picks one in Settings, under Git hosts, in Bots.",
  });

  expect(fake.asked).toHaveLength(asked);

  for (const name of ["git_hosts_watch", "git_hosts_unwatch"]) {
    expect(
      (await t.tool(name, { url: pullUrl }, { session: team })).isError,
    ).toBe(true);
  }
});

// A machine user marked for team work, beside Pedro's own account.
async function teamBot(t: PluginTest): Promise<void> {
  await connected(t);

  await t
    .as("pedro")
    .post("technical-users", { name: "team-bot", host, token: botToken });

  await t.as("pedro").patch("technical-users/team-bot", { team: true });
}

test("polls a team Session's pull request as the team's bot, never with its starter's token", async () => {
  await using run = await start();
  const { t, fake } = run;

  await teamBot(t);
  await t.as("pedro").post("preferences", { autoFix: false, reply: true });
  const team = await t.session({ owner: "team", startedBy: "pedro" });

  expect(
    await t.tool("git_hosts_watch", { url: pullUrl }, { session: team }),
  ).toEqual({
    text: `Watching ${pullUrl}. Its news will come here.`,
    isError: false,
  });

  await t.clock.advance(0);
  fake.pull.checks = "failure";
  await t.clock.advance("60s");

  const [news] = notices(team);

  expect(news).toStartWith(`News on ${pullUrl}:\n- Checks failed`);

  expect(news).toContain(
    "Never comment, review or reply on GitHub as the user.",
  );

  const [{ id }] = (await watched(t, team)) as [{ id: string }];

  expect(await t.as("pedro").post(`pull-requests/${id}/merge`)).toEqual({
    merged: pullUrl,
  });

  expect(fake.readWith.length).toBeGreaterThan(1);
  expect(new Set(fake.readWith)).toEqual(new Set([botToken]));
});

test("refuses a team Session's watch on a host with no team bot, and never falls back to its starter", async () => {
  await using run = await start();
  const { t, fake } = run;

  await connected(t);
  const team = await t.session({ owner: "team", startedBy: "pedro" });

  const refused = await t.tool(
    "git_hosts_watch",
    { url: pullUrl },
    { session: team },
  );

  expect(refused.isError).toBe(true);

  expect(refused.text).toContain(
    `No team bot is marked for ${host}. An admin can mark a GitHub App or technical user for team work in Settings > Git hosts.`,
  );

  await teamBot(t);
  await t.tool("git_hosts_watch", { url: pullUrl }, { session: team });
  await t.as("pedro").patch("technical-users/team-bot", { team: false });
  await t.clock.advance("60s");

  expect(await watched(t, team)).toMatchObject([
    { error: expect.stringContaining("No team bot is marked") as unknown },
  ]);

  expect(fake.readWith).not.toContain(goodToken);
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

test("watches a pull request for a team Session no one started, as the team's bot", async () => {
  await using run = await start();
  const { t, fake } = run;

  await teamBot(t);
  const team = await t.session({ owner: "team" });

  expect(
    (await t.tool("git_hosts_watch", { url: pullUrl }, { session: team }))
      .isError,
  ).toBe(false);

  await t.clock.advance(0);
  fake.pull.checks = "failure";
  await t.clock.advance("60s");

  expect(notices(team)[0]).toStartWith(`News on ${pullUrl}:`);
  expect(new Set(fake.readWith)).toEqual(new Set([botToken]));

  expect(
    t.store.all(
      "select user_id from git_hosts_watches where session_id = ?",
      team.id,
    ),
  ).toEqual([{ user_id: null }]);
});

test("lets whoever steers a team Session use its pull request's controls, and merges as the bot", async () => {
  await using run = await start();
  const { t, fake } = run;

  await teamBot(t);
  const open = await t.session({ owner: "team", startedBy: "pedro" });

  const viewOnly = await t.session({
    owner: "team",
    startedBy: "pedro",
    access: { kind: "view" },
  });

  for (const session of [open, viewOnly]) {
    await t.tool("git_hosts_watch", { url: pullUrl }, { session });
  }

  await t.clock.advance(0);

  const shown = async (who: string, session: TestSession) =>
    t.as(who).get<{ id: string }[]>("pull-requests", { session: session.id });

  expect(await shown("ana", viewOnly)).toEqual([]);
  const [{ id: hidden }] = (await shown("pedro", viewOnly)) as [{ id: string }];

  expect(
    (await t.as("ana").raw(`pull-requests/${hidden}/merge`, { method: "POST" }))
      .status,
  ).toBe(404);

  const [{ id }] = (await shown("ana", open)) as [{ id: string }];

  expect(
    await t.as("ana").post(`pull-requests/${id}/auto-fix`, { on: false }),
  ).toMatchObject({ autoFix: false });

  expect(await t.as("ana").post(`pull-requests/${id}/merge`)).toEqual({
    merged: pullUrl,
  });

  expect(new Set(fake.readWith)).toEqual(new Set([botToken]));

  expect(
    t.log.find(({ message }) => message === "pull request merged")?.fields,
  ).toMatchObject({ url: pullUrl, owner: "team", by: "person:ana" });
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
    null,
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

test("creates a public App when other accounts may install it", async () => {
  await using run = await start();

  expect((await startApp(run.t, "&public=true")).manifest).toMatchObject({
    public: true,
  });

  expect((await startApp(run.t)).manifest).toMatchObject({ public: false });
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

  expect(await t.as("pedro").get("commit-as")).toEqual({
    default: chosen,
    hosts: [],
  });

  expect(await session.api.get("identity")).toEqual(chosen);
});

test("commits with the name and email chosen for the repository's host, and the default elsewhere", async () => {
  await using run = await start();
  const { t } = run;

  const fallback = { name: "Pedro", email: "pedro@example.com" };
  const work = { name: "Pedro Klein", email: "pedro@work.example" };

  await t.as("pedro").post("commit-as", fallback);
  await t.as("pedro").post("commit-as", { host: "Git.Example.com", ...work });

  expect(await t.as("pedro").get("commit-as")).toEqual({
    default: fallback,
    hosts: [{ host, ...work }],
  });

  const session = await t.session({ owner: person("pedro") });

  expect(await session.api.get("identity", { host })).toEqual(work);

  expect(await session.api.get("identity", { host: "github.com" })).toEqual(
    fallback,
  );

  expect(await session.api.get("identity")).toEqual(fallback);

  await t.as("pedro").post("commit-as", { name: "", email: "" });

  expect(await session.api.get("identity", { host })).toEqual(work);
  expect(await session.api.get("identity", { host: "github.com" })).toBeNull();

  const ana = await t.session({ owner: person("ana") });

  expect(await ana.api.get("identity", { host })).toBeNull();
});

test("lists the verified emails of the person's account on a host, the primary first", async () => {
  await using run = await start();
  const { t } = run;

  expect((await t.as("pedro").raw(`emails/${host}`)).status).toBe(404);

  await connected(t);

  expect(await t.as("pedro").get(`emails/${host}`)).toEqual({
    name: "Pedro Klein",
    emails: ["pedro@example.com", "pedro@work.example"],
  });

  await t.as("ana").post("connect", { host, token: botToken });

  expect(await t.as("ana").get(`emails/${host}`)).toEqual({
    name: null,
    emails: ["bot@example.com"],
  });
});

test("keeps the name and email a person chose before hosts had their own as their default", async () => {
  // The plugin as it was before its first migration, then as it is now.
  const before = { ...gitHosts, migrations: [] as readonly string[] };
  const fake = fakeHost(() => 0);

  await using t = await testPlugin(
    {
      plugin: before,
      register: (context) => {
        server.register(context);
      },
    },
    { people, config: listed, fetch: fake.answer },
  );

  t.store.run(
    "insert into git_hosts_commit_as (user_id, name, email) values (?, ?, ?)",
    "pedro",
    "Pedro Klein",
    "pedro@example.com",
  );

  before.migrations = gitHosts.migrations;
  await t.restart();

  const chosen = { name: "Pedro Klein", email: "pedro@example.com" };

  expect(await t.as("pedro").get("commit-as")).toEqual({
    default: chosen,
    hosts: [],
  });

  const session = await t.session({ owner: person("pedro") });

  expect(await session.api.get("identity", { host })).toEqual(chosen);
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
        "x-github-delivery": crypto.randomUUID(),
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

test("finds a team Session only the repositories the team's bot reaches", async () => {
  await using run = await start();
  const { t } = run;

  await connected(t);
  await createApp(t);
  await t.as("pedro").patch("technical-users/pipoca-bot", { team: true });

  const team = await t.session({ owner: "team", startedBy: "pedro" });

  const { text } = await t.tool(
    "git_hosts_repositories",
    { query: "aicore" },
    { session: team },
  );

  expect(text).toContain(`acme/aicore-bot https://${host}/acme/aicore-bot.git`);
  expect(text).not.toContain("acme/aicore-provider");
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

test("the server's code hosts step is done once a host is listed, or the admin goes on with none", async () => {
  await using run = await start(null);
  const { t } = run;

  expect(await t.as("pedro").get("setup")).toMatchObject({
    lockedIn: null,
    noHosts: false,
    server: false,
  });

  expect(
    await t.as("pedro").put("setup/server", { noHosts: true }),
  ).toMatchObject({ noHosts: true, server: true });

  const refused = await t.as("ana").raw("setup/server", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ noHosts: true }),
  });

  expect(refused.status).toBe(403);

  await t.as("pedro").put("setup/server", { noHosts: false });
  expect(await t.as("pedro").get("setup")).toMatchObject({ server: false });

  await t.as("pedro").post("hosts", { host });
  expect(await t.as("pedro").get("setup")).toMatchObject({ server: true });
});

test("a person's code step isn't done on a server with no host until they go on without one", async () => {
  await using run = await start(null);
  const { t } = run;

  expect(await t.as("ana").get("setup")).toMatchObject({
    withoutHosts: false,
    person: false,
  });

  expect(
    await t.as("ana").put("setup/person", { withoutHosts: true }),
  ).toMatchObject({ withoutHosts: true, person: true });

  // Each person answers for themselves.
  expect(await t.as("pedro").get("setup")).toMatchObject({ person: false });

  // A host added after they answered brings the step back.
  await t.as("pedro").post("hosts", { host, label: "Example Git" });

  expect(await t.as("ana").get("setup")).toMatchObject({
    withoutHosts: false,
    person: false,
  });
});

test("a person's code step is done once they sign in to a listed host", async () => {
  await using run = await start();
  const { t } = run;

  expect(await t.as("pedro").get("setup")).toMatchObject({ person: false });

  await connected(t);
  expect(await t.as("pedro").get("setup")).toMatchObject({ person: true });

  await t.as("pedro").delete(`connections/${host}`);
  expect(await t.as("pedro").get("setup")).toMatchObject({ person: false });
});

test("sends a sign-in started in setup back to the setup step", async () => {
  await using run = await start(null);
  const { t } = run;

  await t
    .as("pedro")
    .post("hosts", { host, clientId: "Iv1.abc", clientSecret: "shh" });

  const sent = await t
    .as("pedro")
    .raw(`sign-in/${host}?then=setup`, { method: "GET" });

  const state =
    new URL(sent.headers.get("location") ?? "").searchParams.get("state") ?? "";

  const cookie = (sent.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

  const back = await t.public().raw(`callback?state=${state}&code=c0de`, {
    method: "GET",
    headers: { cookie },
  });

  expect(await back.text()).toContain("/#get-started/git-hosts");
});

test("makes a GitHub App created in server setup the host's team bot, and comes back to the step", async () => {
  await using run = await start();
  const { t } = run;

  const started = await t
    .as("pedro")
    .raw(
      `technical-users/new-app?host=${host}&name=Pipoca%20bot&then=server-setup`,
      { method: "GET" },
    );

  const action = /action="([^"]+)"/.exec(await started.text())?.[1] ?? "";

  const state =
    new URL(action.replaceAll("&#38;", "&")).searchParams.get("state") ?? "";

  const cookie = (started.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

  const created = await t
    .public()
    .raw(`app-created?code=m4nifest&state=${state}`, {
      method: "GET",
      headers: { cookie },
    });

  expect(await created.text()).toContain("/#get-started/server:git-hosts");

  expect(await t.as("pedro").get("technical-users")).toMatchObject([
    { name: "pipoca-bot", kind: "app", team: true },
  ]);
});

const polledNames = [
  "issue",
  "comment",
  "pull_request",
  "review",
  "check",
  "push",
  "release",
  "tag",
  "deployment",
] as const;

// How many of each event the App published, by name.
function published(t: PluginTest): Record<string, number> {
  return Object.fromEntries(
    polledNames.map((name) => [name, t.emitted(`git-hosts.${name}`).length]),
  );
}

function fieldsOf(t: PluginTest, name: string): unknown[] {
  return t.emitted(`git-hosts.${name}`).map(({ fields }) => fields);
}

async function hookOf(t: PluginTest): Promise<string> {
  const { technicalUsers } = (await t.config()) as {
    technicalUsers: { app: { hook: string } }[];
  };

  return technicalUsers[0]?.app.hook ?? "";
}

async function deliverHook(
  t: PluginTest,
  kind: string,
  payload: Record<string, unknown>,
): Promise<number> {
  const body = JSON.stringify({
    repository: { full_name: "acme/aicore-bot" },
    sender: { login: "pedro-gh" },
    ...payload,
  });

  const answered = await t.public().raw(`hooks/${await hookOf(t)}`, {
    method: "POST",
    headers: {
      "x-github-event": kind,
      "x-github-delivery": crypto.randomUUID(),
      "x-hub-signature-256": `sha256=${createHmac("sha256", "hook-secret").update(body).digest("hex")}`,
    },
    body,
  });

  return answered.status;
}

const app = {
  host,
  repository: "acme/aicore-bot",
  technicalUser: "pipoca-bot",
};

test("adds a push's changed paths, once each, and publishes tags, releases and deployments from an App's webhooks", async () => {
  await using run = await start();
  const { t } = run;

  await createApp(t);

  const pushed = await deliverHook(t, "push", {
    ref: "refs/heads/main",
    after: "bbb",
    commits: [
      { added: ["docs/new.md"], modified: ["src/a.ts"], removed: [] },
      { added: [], modified: ["src/a.ts", "README.md"], removed: ["old.txt"] },
    ],
  });

  expect(pushed).toBe(202);

  await deliverHook(t, "push", { ref: "refs/tags/v1.2.0", after: "bbb" });
  await deliverHook(t, "create", { ref: "v1.2.0", ref_type: "tag" });
  await deliverHook(t, "create", { ref: "topic", ref_type: "branch" });

  await deliverHook(t, "release", {
    action: "published",
    release: {
      id: 9,
      tag_name: "v1.2.0",
      name: "1.2.0",
      body: "Faster start.",
      html_url: `https://${host}/acme/aicore-bot/releases/tag/v1.2.0`,
      prerelease: false,
      author: { login: "pedro-gh" },
    },
  });

  await deliverHook(t, "deployment", {
    action: "created",
    deployment: {
      id: 21,
      environment: "production",
      ref: "main",
      sha: "bbb",
      description: "Ship it",
    },
  });

  const sent = { ...app, sender: "pedro-gh" };

  expect(fieldsOf(t, "push")).toEqual([
    {
      ...sent,
      action: "",
      branch: "main",
      sha: "bbb",
      paths: ["README.md", "docs/new.md", "old.txt", "src/a.ts"],
    },
  ]);

  expect(fieldsOf(t, "tag")).toEqual([
    { ...sent, action: "created", tag: "v1.2.0" },
  ]);

  expect(fieldsOf(t, "release")).toEqual([
    {
      ...sent,
      action: "published",
      tag: "v1.2.0",
      title: "1.2.0",
      body: "Faster start.",
      url: `https://${host}/acme/aicore-bot/releases/tag/v1.2.0`,
      prerelease: false,
      author: "pedro-gh",
    },
  ]);

  expect(t.emitted("git-hosts.deployment")).toEqual([
    {
      fields: {
        ...sent,
        action: "created",
        id: 21,
        environment: "production",
        ref: "main",
        sha: "bbb",
        description: "Ship it",
      },
      to: [person("pedro")],
    },
  ]);
});

test("polls an App the host can't send webhooks to and publishes each event once, asking again with ETags", async () => {
  await using run = await start();
  const { t, fake } = run;
  const { repo } = fake;

  await createApp(t);
  await t.clock.advance("60s");

  // The first poll only notes where things are.
  expect(fake.asked).toContain("GET /api/v3/repos/acme/aicore-bot/branches");

  expect(Object.values(published(t))).toEqual(polledNames.map(() => 0));

  const at = new Date(t.clock.now()).toISOString();
  const issueUrl = `https://${host}/acme/aicore-bot/issues/3`;
  const member = { user: { login: "ana-gh" }, author_association: "MEMBER" };

  repo.issues.push(
    {
      ...member,
      number: 3,
      title: "Start is slow",
      body: "2 s",
      html_url: issueUrl,
      labels: [{ name: "pipoca" }],
      created_at: at,
      updated_at: at,
      closed_at: null,
    },
    {
      number: 4,
      pull_request: {},
      created_at: "2020-01-01T00:00:00Z",
      updated_at: at,
      closed_at: at,
    },
  );

  repo.pulls.set(4, {
    ...member,
    number: 4,
    title: "Lazy load",
    body: "",
    html_url: `https://${host}/acme/aicore-bot/pull/4`,
    head: { ref: "lazy" },
    base: { ref: "main" },
    merged: true,
    labels: [],
    created_at: "2020-01-01T00:00:00Z",
    updated_at: at,
    closed_at: at,
  });

  repo.reviews.set(4, [
    {
      ...member,
      id: 70,
      state: "APPROVED",
      body: "",
      html_url: `https://${host}/acme/aicore-bot/pull/4#review-70`,
      submitted_at: at,
    },
  ]);

  repo.comments.push({
    ...member,
    id: 11,
    body: "/pipoca look at this",
    html_url: `${issueUrl}#issuecomment-11`,
    issue_url: `${api}/repos/acme/aicore-bot/issues/3`,
    created_at: at,
    updated_at: at,
  });

  repo.branches["main"] = "bbb";

  repo.compares.set("aaa...bbb", [
    { filename: "docs/start.md", status: "modified" },
    {
      filename: "src/load.ts",
      status: "renamed",
      previous_filename: "src/boot.ts",
    },
  ]);

  repo.checkRuns.set("bbb", [
    {
      id: 5,
      name: "test",
      status: "completed",
      conclusion: "failure",
      head_sha: "bbb",
      html_url: "https://ci.example/5",
      pull_requests: [],
    },
  ]);

  repo.tags.push("v1.2.0");

  repo.releases.push({
    id: 9,
    tag_name: "v1.2.0",
    name: "1.2.0",
    body: "",
    html_url: `https://${host}/acme/aicore-bot/releases/tag/v1.2.0`,
    draft: false,
    prerelease: false,
    author: { login: "ana-gh" },
  });

  repo.deployments.push({
    id: 21,
    environment: "production",
    ref: "main",
    sha: "bbb",
    description: "",
    creator: { login: "ana-gh" },
  });

  await t.clock.advance("60s");

  expect(published(t)).toEqual({
    issue: 1,
    comment: 1,
    pull_request: 1,
    review: 1,
    check: 1,
    push: 1,
    release: 1,
    tag: 1,
    deployment: 1,
  });

  expect(fieldsOf(t, "issue")).toEqual([
    {
      ...app,
      action: "opened",
      sender: "ana-gh",
      author: "ana-gh",
      member: true,
      number: 3,
      title: "Start is slow",
      body: "2 s",
      url: issueUrl,
      labels: ["pipoca"],
      label: "",
    },
  ]);

  expect(fieldsOf(t, "pull_request")).toMatchObject([
    { action: "closed", number: 4, merged: true, branch: "lazy" },
  ]);

  expect(fieldsOf(t, "review")).toMatchObject([
    { action: "submitted", number: 4, state: "approved" },
  ]);

  expect(fieldsOf(t, "comment")).toMatchObject([
    { action: "created", number: 3, pullRequest: false, command: "/pipoca" },
  ]);

  expect(fieldsOf(t, "push")).toMatchObject([
    {
      branch: "main",
      sha: "bbb",
      paths: ["docs/start.md", "src/boot.ts", "src/load.ts"],
    },
  ]);

  expect(fieldsOf(t, "check")).toMatchObject([
    { action: "completed", conclusion: "failure", branch: "main", sha: "bbb" },
  ]);

  expect(fieldsOf(t, "tag")).toMatchObject([
    { action: "created", tag: "v1.2.0" },
  ]);

  expect(fieldsOf(t, "release")).toMatchObject([{ action: "published" }]);

  expect(fieldsOf(t, "deployment")).toMatchObject([
    { id: 21, sender: "ana-gh" },
  ]);

  // Nothing new: every list answers 304, and nothing is published again.
  repo.answered.length = 0;
  await t.clock.advance("60s");

  expect(published(t)).toMatchObject({ issue: 1, comment: 1, push: 1 });
  expect(repo.answered.length).toBeGreaterThanOrEqual(7);
  expect(repo.answered.filter((each) => !each.startsWith("304"))).toEqual([]);
});

test("publishes an event an App's webhook and its poll both tell only once", async () => {
  await using run = await start();
  const { t, fake } = run;

  await createApp(t);
  await t.clock.advance("60s");

  const at = new Date(t.clock.now()).toISOString();

  const issue = {
    number: 3,
    title: "Start is slow",
    body: "",
    html_url: `https://${host}/acme/aicore-bot/issues/3`,
    user: { login: "ana-gh" },
    author_association: "MEMBER",
    labels: [],
    created_at: at,
    updated_at: at,
    closed_at: null,
  };

  // The host delivers it again, as it does when an answer is slow.
  for (const _ of [1, 2]) {
    expect(await deliverHook(t, "issues", { action: "opened", issue })).toBe(
      202,
    );
  }

  expect(
    await deliverHook(t, "push", {
      ref: "refs/heads/main",
      after: "bbb",
      commits: [],
    }),
  ).toBe(202);

  fake.repo.issues.push(issue);
  fake.repo.branches["main"] = "bbb";
  await t.clock.advance("60s");

  expect(fieldsOf(t, "issue")).toMatchObject([{ action: "opened", number: 3 }]);
  expect(fieldsOf(t, "push")).toMatchObject([{ branch: "main", sha: "bbb" }]);
});

// A plugin that starts work from git-hosts' events, as routines do, so its
// Sessions' questions wait past the turn.
const starter = definePlugin({
  id: "starter",
  title: "Starter",
  description: "Starts work whose questions wait.",
});

let waits: Questions | undefined;

const starterServer = defineServer(starter, ({ questions }) => {
  waits = questions;
});

// The Session asks, as the Ask plugin's Session part does for ask_user.
async function asks(
  session: TestSession,
  question: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  const asked = await session.api.raw(
    `/runner/sessions/${session.id}/ext/ask/questions`,
    {
      method: "POST",
      body: JSON.stringify({
        questions: [{ label: "Q1", context: null, ...question }],
        defaults: {},
      }),
    },
  );

  return asked.json();
}

// The Session asks Pedro's question about issue 7 of acme/dotfiles.
async function askOnIssue(session: TestSession): Promise<void> {
  waits?.wait(session.id, {
    origin: {
      event: "git-hosts.issue",
      fields: { host, repository: "acme/dotfiles", number: 7 },
    },
    owner: "pedro",
  });

  expect(
    await asks(session, {
      id: "ship",
      prompt: "Ship it?",
      type: "single",
      options: [
        {
          value: "approve",
          label: "Approve",
          description: null,
          recommended: false,
        },
        {
          value: "reject",
          label: "Reject",
          description: null,
          recommended: false,
        },
      ],
    }),
  ).toMatchObject({ wait: "message" });
}

// A comment on issue 7 of acme/dotfiles, as the App's webhook tells it.
async function commentOnIssue(
  t: PluginTest,
  login: string,
  association: string,
  body: string,
  url = `https://${host}/acme/dotfiles/issues/7#issuecomment-${String(Math.random())}`,
): Promise<void> {
  const { technicalUsers } = (await t.config()) as {
    technicalUsers: { app: { hook: string } }[];
  };

  const payload = JSON.stringify({
    action: "created",
    repository: { full_name: "acme/dotfiles" },
    sender: { login },
    issue: { number: 7 },
    comment: {
      id: Math.floor(Math.random() * 1e9),
      body,
      user: { login },
      author_association: association,
      html_url: url,
    },
  });

  const answered = await t
    .public()
    .raw(`hooks/${technicalUsers[0]?.app.hook ?? ""}`, {
      method: "POST",
      headers: {
        "x-github-event": "issue_comment",
        "x-github-delivery": crypto.randomUUID(),
        "x-hub-signature-256": `sha256=${createHmac("sha256", "hook-secret").update(payload).digest("hex")}`,
      },
      body: payload,
    });

  expect(answered.status).toBe(202);
}

const authors = (t: PluginTest): readonly unknown[] =>
  t
    .emitted("git-hosts.comment")
    .map(({ fields }) => (fields as { author: string }).author);

test("posts a run's question on the issue its work came from as the App it acts as, and a member's comment there answers it", async () => {
  await using run = await start(listed, [askServer, starterServer]);
  const { t, fake } = run;

  await createApp(t);

  const session = await t.session({
    owner: person("pedro"),
    actsAs: { plugin: "git-hosts", name: "pipoca-bot" },
  });

  await askOnIssue(session);
  await until(() => fake.commented.length);

  expect(fake.commented).toMatchObject([
    {
      path: "/api/v3/repos/acme/dotfiles/issues/7/comments",
      token: "ghs_installation",
      body: expect.stringMatching(
        /^Pi is waiting for an answer\.\n\n\*\*Ship it\?\*\*\n- Approve\n- Reject\n\nIt waits until .+\n\nReply with a comment here to answer\.$/,
      ) as unknown,
    },
  ]);

  await commentOnIssue(
    t,
    "pipoca-bot[bot]",
    "NONE",
    fake.commented[0]?.body ?? "",
    `https://${host}/acme/dotfiles/issues/7#issuecomment-1`,
  );

  await commentOnIssue(t, "stranger", "NONE", "approve");

  expect(authors(t)).toEqual(["pipoca-bot[bot]", "stranger"]);

  await commentOnIssue(t, "ana-gh", "MEMBER", "reject, not yet");

  expect(authors(t)).toEqual(["pipoca-bot[bot]", "stranger"]);

  const told = await until(
    () => session.delivered(),
    (all) => all.length > 0,
  );

  expect(told.at(-1)?.text).toEndWith("from ana-gh:\n\nreject, not yet");
});

test("posts the question of a run acting as its person only once they chose to reply as themselves, and they answer it anywhere", async () => {
  await using run = await start(listed, [askServer, starterServer]);
  const { t, fake } = run;

  await createApp(t);
  await connected(t);

  const first = await t.session({ owner: person("pedro") });
  await askOnIssue(first);

  await until(
    () => t.log,
    (log) => log.some(({ message }) => message === "question stays in Pipoca"),
  );

  expect(fake.commented).toEqual([]);

  await t.as("pedro").post("preferences", { autoFix: true, reply: true });

  const second = await t.session({ owner: person("pedro") });
  await askOnIssue(second);
  await until(() => fake.commented.length);

  expect(fake.commented).toMatchObject([
    {
      token: goodToken,
      body: expect.stringMatching(/\n\nvia Pipoca$/) as unknown,
    },
  ]);

  await commentOnIssue(t, "pedro-gh", "NONE", "approve");

  const told = await until(
    () => second.delivered(),
    (all) => all.length > 0,
  );

  expect(told.at(-1)?.text).toEndWith("from pedro-gh:\n\napprove");
  expect(authors(t)).toEqual([]);
});

test("a Session that proposes reads with the App's read-only token, and gets other tokens only to make its workspace", async () => {
  await using run = await start();
  const { t } = run;

  await connected(t);
  await createApp(t);

  const acting = await t.session({
    owner: person("pedro"),
    actsAs: { plugin: "git-hosts", name: "pipoca-bot" },
    proposes: true,
    workspace: {
      kind: "clone",
      repository: `https://${host}/acme/dotfiles.git`,
    },
  });

  expect(acting.gitLogins()).toEqual([{ host, token: "ghs_reading" }]);

  const own = await t.session({ owner: person("pedro"), proposes: true });

  expect(own.gitLogins()).toEqual([
    { host, token: goodToken, cloneOnly: true },
  ]);
});

// Applies other plugins' actions, as the routines plugin does.
let applying: PluginActions | undefined;
let delivering: PluginDestinations | undefined;
let sessionsSeen: Sessions | undefined;

const applier = defineServer(
  definePlugin({ id: "applier", title: "Applier", description: "Applies." }),
  (context) => {
    applying = context.actions;
    delivering = context.destinations;
    sessionsSeen = context.sessions;
  },
);

function sessionNamed(id: string): Session {
  const found = sessionsSeen?.get(id);

  if (found === undefined) {
    throw new Error(`no Session ${id}`);
  }

  return found;
}

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
  }).trim();
}

test("applies a run's pull request: pushes its branch's commits as the run's identity, opens the pull request and watches it", async () => {
  await using run = await start(listed, [applier]);
  const { t, fake } = run;

  await connected(t);

  // The host's repository, which the server's git reaches in place of the
  // host's address.
  const root = mkdtempSync(join(tmpdir(), "git-hosts-push-"));
  const remote = join(root, "acme", "dotfiles.git");

  mkdirSync(remote, { recursive: true });
  git(remote, "init", "--quiet", "--bare", "--initial-branch=main");

  const work = join(root, "work");

  execFileSync("git", ["clone", "--quiet", remote, work]);

  const commit = (message: string): void => {
    git(
      work,
      "-c",
      "user.name=A",
      "-c",
      "user.email=a@b",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      message,
    );
  };

  commit("start");
  git(work, "push", "--quiet", "origin", "HEAD:main");

  const base = git(work, "rev-parse", "HEAD");

  const session = await t.session({
    owner: person("pedro"),
    proposes: true,
    workspace: {
      kind: "clone",
      repository: `https://${host}/acme/dotfiles.git`,
    },
  });

  const { workspace } = sessionNamed(session.id);
  const branch = "branch" in workspace ? workspace.branch : "";

  git(work, "checkout", "--quiet", "-b", branch);
  commit("Fix the dotfiles");

  git(
    work,
    "bundle",
    "create",
    "--quiet",
    join(root, "b"),
    `refs/heads/${branch}`,
    `^${base}`,
  );

  const saved = {
    count: process.env["GIT_CONFIG_COUNT"],
    key: process.env["GIT_CONFIG_KEY_0"],
    value: process.env["GIT_CONFIG_VALUE_0"],
  };

  Object.assign(process.env, {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `url.file://${root}/.insteadOf`,
    GIT_CONFIG_VALUE_0: `https://${host}/`,
  });

  try {
    const applied = await applying?.apply(
      "git-hosts.pullRequest",
      { title: "Fix the dotfiles", body: "Fixes #3." },
      {
        session: sessionNamed(session.id),
        commits: readFileSync(join(root, "b")),
      },
    );

    expect(applied).toEqual({ text: `Opened ${pullUrl}`, url: pullUrl });
  } finally {
    Object.assign(process.env, {
      GIT_CONFIG_COUNT: saved.count ?? "",
      GIT_CONFIG_KEY_0: saved.key ?? "",
      GIT_CONFIG_VALUE_0: saved.value ?? "",
    });
  }

  expect(git(remote, "log", "--format=%s", branch)).toBe(
    "Fix the dotfiles\nstart",
  );

  expect(fake.written).toEqual([
    {
      path: "POST /api/v3/repos/acme/dotfiles/pulls",
      token: goodToken,
      body: {
        title: "Fix the dotfiles",
        body: "Fixes #3.",
        head: branch,
        base: "main",
        draft: false,
      },
    },
  ]);

  expect(await watched(t, session)).toMatchObject([{ url: pullUrl }]);
});

test("applies a run's comment with the token of the person it acts for, and refuses an action without a login", async () => {
  await using run = await start(listed, [applier]);
  const { t, fake } = run;

  const session = sessionNamed(
    (await t.session({ owner: person("pedro"), proposes: true })).id,
  );

  const comment = async () =>
    applying?.apply(
      "git-hosts.comment",
      { repository: "acme/dotfiles", number: 3, body: "Looking into it." },
      { session },
    );

  expect(await comment().catch((error: unknown) => String(error))).toBe(
    `Error: the run has no login on ${host} to write with`,
  );

  await connected(t);

  expect(await comment()).toEqual({
    text: "Commented on #3",
    url: `https://${host}/acme/dotfiles/issues/7#issuecomment-1`,
  });

  expect(fake.commented).toEqual([
    {
      path: "/api/v3/repos/acme/dotfiles/issues/3/comments",
      token: goodToken,
      body: "Looking into it.",
    },
  ]);

  expect(applying?.declared().map(({ type }) => type)).toEqual([
    "git-hosts.pullRequest",
    "git-hosts.comment",
    "git-hosts.labels",
    "git-hosts.closeIssue",
    "git-hosts.requestReview",
  ]);
});

test("comments a routine run's result on the issue its event is about, and writes it to a file", async () => {
  await using run = await start(listed, [applier]);
  const { t, fake } = run;

  const session = sessionNamed(
    (await t.session({ owner: person("pedro"), proposes: true })).id,
  );

  await connected(t);

  const delivery = {
    session,
    routine: "Triage",
    outcome: "done",
    summary: "Labelled it.",
    events: [
      {
        type: "git-hosts.issue",
        fields: { host, repository: "acme/dotfiles", number: 3 },
      },
    ],
    text: "Triage: Done. Labelled it.",
  } as const;

  expect(await delivering?.deliver("git-hosts.comment", {}, delivery)).toEqual({
    text: "Commented on #3",
    url: `https://${host}/acme/dotfiles/issues/7#issuecomment-1`,
  });

  expect(fake.commented).toEqual([
    {
      path: "/api/v3/repos/acme/dotfiles/issues/3/comments",
      token: goodToken,
      body: "Triage: Done. Labelled it.",
    },
  ]);

  expect(
    await delivering?.deliver(
      "git-hosts.file",
      { repository: `https://${host}/acme/dotfiles`, path: "notes/triage.md" },
      delivery,
    ),
  ).toEqual({
    text: "Wrote notes/triage.md in acme/dotfiles",
    url: `https://${host}/acme/dotfiles/blob/main/x`,
  });

  expect(fake.written).toEqual([
    {
      path: "PUT /api/v3/repos/acme/dotfiles/contents/notes/triage.md",
      token: goodToken,
      body: {
        message: "Triage: update notes/triage.md",
        content: Buffer.from("Triage: Done. Labelled it.\n").toString("base64"),
      },
    },
  ]);

  expect(
    await delivering
      ?.deliver("git-hosts.comment", {}, { ...delivery, events: [] })
      .catch((error: unknown) => String(error)),
  ).toBe("Error: the run's event names no issue or pull request to comment on");

  expect(delivering?.declared().map(({ type }) => type)).toEqual([
    "git-hosts.comment",
    "git-hosts.file",
  ]);
});

test("a private host's token can't be checked until an Environment of the person's reaches it", async () => {
  await using t = await testPlugin(server, {
    people,
    config: listed,
    kernelConfig: {
      privateHosts: { hosts: [{ host, ca: null, teamWatch: false }] },
    },
  });

  const account = await t.as("pedro").get<Account>("account");

  expect(account.hosts).toEqual([
    expect.objectContaining({
      host,
      reach: { private: true, through: [] },
    }),
  ]);

  const refused = await t
    .as("pedro")
    .post("connect", { host, token: goodToken })
    .catch((error: unknown) => error);

  expect(String(refused)).toContain(
    `${host} is a private host and no Environment of yours reaches it.`,
  );
});
