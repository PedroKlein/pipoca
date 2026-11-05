import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testServer, type TestServer } from "./testdata/harness";

const clientId = "pipoca-test";

interface Account {
  readonly sub: string;
  readonly email: string;
  readonly email_verified?: boolean;
  groups?: string[];
  readonly [claim: string]: unknown;
}

let server: TestServer;
let provider: ReturnType<typeof fakeProvider>;
let providerId: string;
let configDir: string;

beforeEach(async () => {
  provider = fakeProvider();

  configDir = mkdtempSync(join(tmpdir(), "pipoca-config-"));

  server = testServer({ configDir });
  providerId = await addProvider(provider.issuer);
});

afterEach(async () => {
  await server.close();
  await provider.stop();
});

function providerInput(
  issuer: string,
  more: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    issuer,
    clientId,
    label: "Sign in with IAS",
    accessGroup: "pipoca-users",
    adminGroup: "pipoca-admins",
    ...more,
  };
}

async function addProvider(
  issuer: string,
  more: Record<string, unknown> = {},
): Promise<string> {
  const added = await server.api("/api/ext/oidc/providers", {
    body: providerInput(issuer, more),
  });

  expect(added.status).toBe(201);

  return ((await added.json()) as { id: string }).id;
}

async function configure(more: Record<string, unknown>): Promise<Response> {
  const saved = await server.api(`/api/ext/oidc/providers/${providerId}`, {
    body: providerInput(provider.issuer, more),
  });

  expect(saved.status).toBe(200);

  return saved;
}

async function userOf(cookie: string): Promise<unknown> {
  const status = (await (await server.as(cookie)("/api/auth")).json()) as {
    user: unknown;
  };

  return status.user;
}

function cookieOf(response: Response): string {
  return response.headers.get("set-cookie")?.split(";")[0] ?? "";
}

// Walks a browser through the provider and back. Returns the callback's
// answer and the Cookie header it would send next.
async function signIn(
  account: Account,
  options: { start?: string; cookie?: string; browser?: string } = {},
): Promise<{ readonly response: Response; readonly cookie: string }> {
  const started = await server.as(options.cookie ?? "")(
    options.start ?? `/api/ext/oidc/start/${providerId}`,
    { redirect: "manual" },
  );

  expect(started.status).toBe(302);

  provider.next = account;

  const authorized = await fetch(started.headers.get("location") ?? "", {
    redirect: "manual",
  });

  const browser = options.browser ?? cookieOf(started);

  const response = await fetch(authorized.headers.get("location") ?? "", {
    redirect: "manual",
    headers: { cookie: browser },
  });

  return { response, cookie: cookieOf(response) };
}

const ana: Account = {
  sub: "P000001",
  email: "ana@example.com",
  groups: ["pipoca-users"],
};

test("offers the provider on the sign-in page once it is set up", async () => {
  const status = (await (
    await fetch(new URL("/api/auth", server.url))
  ).json()) as {
    logins: unknown;
  };

  expect(status.logins).toEqual([
    {
      label: "Sign in with IAS",
      path: `/api/ext/oidc/start/${providerId}`,
    },
  ]);
});

test("offers a button for each provider and signs in through any of them", async () => {
  const google = fakeProvider();

  try {
    const googleId = await addProvider(google.issuer, {
      label: "Sign in with Google",
      allowedDomains: ["example.com"],
    });

    const status = (await (
      await fetch(new URL("/api/auth", server.url))
    ).json()) as { logins: { label: string }[] };

    google.next = { ...ana, sub: "google-ana", email_verified: true };

    const started = await fetch(
      new URL(`/api/ext/oidc/start/${googleId}`, server.url),
      { redirect: "manual" },
    );

    const authorized = await fetch(started.headers.get("location") ?? "", {
      redirect: "manual",
    });

    const back = await fetch(authorized.headers.get("location") ?? "", {
      redirect: "manual",
      headers: { cookie: cookieOf(started) },
    });

    expect(status.logins.map(({ label }) => label)).toEqual([
      "Sign in with IAS",
      "Sign in with Google",
    ]);

    expect(started.headers.get("location")).toStartWith(google.issuer);

    expect(await userOf(cookieOf(back))).toMatchObject({
      name: "ana@example.com",
    });
  } finally {
    await google.stop();
  }
});

test("keeps a client secret out of the page, sends it to the provider, and takes it away", async () => {
  const set = await configure({ clientSecret: "s3cret value" });
  const file = readFileSync(join(configDir, "pipoca.json"), "utf8");
  const listed = await server.api("/api/ext/oidc/providers");

  await signIn(ana);
  const kept = await configure({ clientSecret: "" });
  await signIn(ana);
  const removed = await configure({ clientSecret: null });
  await signIn(ana);

  const basic = `Basic ${Buffer.from(`${clientId}:s3cret+value`).toString("base64")}`;

  expect(await set.json()).toMatchObject({ hasClientSecret: true });
  expect(await listed.text()).not.toContain("s3cret");
  expect(file).not.toContain("s3cret");
  expect(await kept.json()).toMatchObject({ hasClientSecret: true });
  expect(await removed.json()).toMatchObject({ hasClientSecret: false });

  expect(provider.tokenRequests).toEqual([
    { authorization: basic, clientId: null, verified: true },
    { authorization: basic, clientId: null, verified: true },
    { authorization: null, clientId, verified: true },
  ]);
});

test("lets only admins see and change providers", async () => {
  const { cookie } = await signIn(ana);

  const statuses = [
    (await server.as(cookie)("/api/ext/oidc/providers")).status,
    (
      await server.as(cookie)("/api/ext/oidc/providers", {
        body: providerInput(provider.issuer),
      })
    ).status,
    (
      await server.as(cookie)(`/api/ext/oidc/providers/${providerId}`, {
        method: "DELETE",
      })
    ).status,
  ];

  expect(statuses).toEqual([403, 403, 403]);
});

test("refuses a provider without an issuer URL or a client ID", async () => {
  const statuses = await Promise.all(
    [{ issuer: "not a url" }, { clientId: "" }].map(
      async (more) =>
        (
          await server.api("/api/ext/oidc/providers", {
            body: providerInput(provider.issuer, more),
          })
        ).status,
    ),
  );

  expect(statuses).toEqual([400, 400]);
});

test("stops offering a provider once it is removed", async () => {
  const removed = await server.api(`/api/ext/oidc/providers/${providerId}`, {
    method: "DELETE",
  });

  const status = (await (
    await fetch(new URL("/api/auth", server.url))
  ).json()) as { logins: unknown[] };

  const start = await fetch(
    new URL(`/api/ext/oidc/start/${providerId}`, server.url),
    { redirect: "manual" },
  );

  expect([removed.status, status.logins, start.status]).toEqual([200, [], 404]);
});

function configFile(): unknown {
  return JSON.parse(readFileSync(join(configDir, "pipoca.json"), "utf8"));
}

function writeConfig(settings: unknown): void {
  writeFileSync(join(configDir, "pipoca.json"), JSON.stringify(settings));
}

// Starts the server again on the same config folder and database.
async function restart(database = ":memory:"): Promise<void> {
  await server.close();

  server = testServer({ database, configDir });
}

test("keeps the providers Settings adds in pipoca.json", () => {
  expect(configFile()).toEqual({
    oidc: {
      providers: [
        {
          id: "ias",
          label: "Sign in with IAS",
          issuer: provider.issuer,
          clientId,
          accessGroup: "pipoca-users",
          adminGroup: "pipoca-admins",
        },
      ],
    },
  });
});

test("signs in through a provider written into the file by hand, with its secret from the environment", async () => {
  process.env["PIPOCA_TEST_OIDC_SECRET"] = "from the env";

  const file = configFile() as { oidc: { providers: unknown[] } };

  writeConfig({
    ...file,
    oidc: {
      providers: [
        ...file.oidc.providers,
        {
          ...providerInput(provider.issuer, { label: "Sign in with SAP" }),
          id: "sap",
          clientSecret: { env: "PIPOCA_TEST_OIDC_SECRET" },
        },
      ],
    },
  });

  const status = (await (
    await fetch(new URL("/api/auth", server.url))
  ).json()) as { logins: unknown };

  const { cookie } = await signIn(ana, {
    start: "/api/ext/oidc/start/sap",
  });

  const listed = await server.api("/api/ext/oidc/providers");

  expect(status.logins).toEqual([
    { label: "Sign in with IAS", path: "/api/ext/oidc/start/ias" },
    { label: "Sign in with SAP", path: "/api/ext/oidc/start/sap" },
  ]);

  expect(await userOf(cookie)).toMatchObject({ name: "ana@example.com" });

  expect(provider.tokenRequests).toEqual([
    {
      authorization: `Basic ${Buffer.from(`${clientId}:from+the+env`).toString("base64")}`,
      clientId: null,
      verified: true,
    },
  ]);

  expect(await listed.json()).toContainEqual(
    expect.objectContaining({
      id: "sap",
      hasClientSecret: true,
      clientSecretEnv: "PIPOCA_TEST_OIDC_SECRET",
    }),
  );

  expect(process.env["PIPOCA_TEST_OIDC_SECRET"]).toBeUndefined();
});

test("fails the plugin, with the reason, when the file's providers don't fit at start", async () => {
  writeConfig({
    oidc: {
      providers: [
        {
          ...providerInput(provider.issuer),
          id: "ias",
          clientSecret: { sealed: "x" },
        },
      ],
    },
  });

  await restart();

  const listed = (await (await server.api("/api/plugins")).json()) as {
    id: string;
    state: string;
    error?: string;
  }[];

  expect(listed.find(({ id }) => id === "oidc")).toMatchObject({
    state: "failed",
    error:
      "oidc.providers[0]: clientSecret isn't sealed with this server's key; save it in Settings or name an environment variable",
  });
});

test("keeps the last providers that fit while the file is broken, and won't overwrite it", async () => {
  writeFileSync(join(configDir, "pipoca.json"), "{ not json");

  const status = (await (
    await fetch(new URL("/api/auth", server.url))
  ).json()) as { logins: unknown[] };

  const added = await server.api("/api/ext/oidc/providers", {
    body: providerInput(provider.issuer, { label: "Sign in with Google" }),
  });

  expect(status.logins).toHaveLength(1);
  expect(added.status).toBe(400);

  expect(readFileSync(join(configDir, "pipoca.json"), "utf8")).toBe(
    "{ not json",
  );

  expect(
    server.logs.some((line) => line.startsWith("config file unreadable")),
  ).toBe(true);
});

test("won't save over providers edited by hand into a list that doesn't fit", async () => {
  writeConfig({
    oidc: {
      providers: [
        {
          ...providerInput(provider.issuer),
          id: "ias",
          clientSecret: { sealed: "x" },
        },
      ],
    },
  });

  const edited = readFileSync(join(configDir, "pipoca.json"), "utf8");

  const added = await server.api("/api/ext/oidc/providers", {
    body: providerInput(provider.issuer, { label: "Sign in with Google" }),
  });

  expect(added.status).toBe(400);

  expect(await added.json()).toEqual({
    error: "bad_request",
    message:
      "fix oidc in pipoca.json first: oidc.providers[0]: clientSecret isn't sealed with this server's key; save it in Settings or name an environment variable",
  });

  expect(readFileSync(join(configDir, "pipoca.json"), "utf8")).toBe(edited);
});

test("makes a user for a member of the access group and signs them in", async () => {
  const { response, cookie } = await signIn(ana);

  expect(response.status).toBe(200);
  expect(response.headers.get("set-cookie")).toMatch(/SameSite=Strict/);
  expect(await response.text()).toContain('content="0;url=/"');

  const again = await signIn(ana);

  const users = await Promise.all(
    [cookie, again.cookie].map(async (each) => {
      const status = (await (await server.as(each)("/api/auth")).json()) as {
        user: unknown;
      };

      return status.user;
    }),
  );

  expect(users[0]).toEqual({
    id: expect.any(String) as string,
    name: "ana@example.com",
    admin: false,
  });

  expect(users[1]).toEqual(users[0]);
});

test("names a user it makes without the spaces around the provider's email", async () => {
  const { cookie } = await signIn({ ...ana, email: " ana@example.com " });

  const status = (await (await server.as(cookie)("/api/auth")).json()) as {
    user: unknown;
  };

  expect(status.user).toMatchObject({ name: "ana@example.com" });
});

test("refuses someone outside the access group", async () => {
  const { response, cookie } = await signIn({ ...ana, groups: ["others"] });

  expect(response.status).toBe(403);
  expect(await response.text()).toContain("Ask its admin to add you");
  expect(cookie).toBe("");
});

test("lets in verified emails and domains for a provider without groups", async () => {
  await configure({
    allowedEmails: ["Bea@Gmail.com"],
    allowedDomains: ["example.org"],
    adminEmails: ["boss@example.net"],
  });

  const google = (email: string, verified = true): Account => ({
    sub: `google-${email}`,
    email,
    email_verified: verified,
  });

  const signedIn: unknown[] = [];

  // One at a time, since the provider signs in whoever is next.
  for (const account of [
    google("bea@gmail.com"),
    google("cid@example.org"),
    google("boss@example.net"),
    google("dan@example.org", false),
    google("eve@gmail.com"),
  ]) {
    signedIn.push(await userOf((await signIn(account)).cookie));
  }

  expect(signedIn).toMatchObject([
    { name: "bea@gmail.com", admin: false },
    { name: "cid@example.org", admin: false },
    { name: "boss@example.net", admin: true },
    null,
    null,
  ]);
});

test("reads the groups from the claim the settings name", async () => {
  await configure({ groupsClaim: "roles" });

  const fromGroups = await signIn(ana);

  const fromRoles = await signIn({
    ...ana,
    groups: [],
    roles: ["pipoca-users"],
  });

  expect([fromGroups.response.status, fromRoles.response.status]).toEqual([
    403, 200,
  ]);
});

test("reads the admin group again on every sign-in", async () => {
  const account = { ...ana, groups: ["pipoca-users", "pipoca-admins"] };
  const first = await signIn(account);

  const save = async (cookie: string): Promise<number> =>
    (await server.as(cookie)("/api/ext/oidc/providers")).status;

  const asAdmin = await save(first.cookie);

  account.groups = ["pipoca-users"];
  const second = await signIn(account);

  expect([asAdmin, await save(second.cookie)]).toEqual([200, 403]);
});

test("keeps the role an admin gave when the provider names no admins", async () => {
  await configure({ adminGroup: "" });
  await signIn(ana);

  const people = (await (await server.api("/api/people")).json()) as {
    id: string;
    name: string;
  }[];

  const id = people.find(({ name }) => name !== "pedro")?.id ?? "";

  const made = await server.api(`/api/people/${id}`, {
    method: "PATCH",
    body: {
      admin: true,
    },
  });

  const again = await signIn(ana);

  expect(made.status).toBe(200);
  expect(await userOf(again.cookie)).toMatchObject({ admin: true });
});

test("lets in someone outside the rules who has an invite, with the invite's role, and keeps them in", async () => {
  const zoe: Account = {
    sub: "P000099",
    email: "Zoe@Example.com",
    email_verified: true,
    groups: ["others"],
  };

  const before = await signIn(zoe);

  const invited = await server.api("/api/invites", {
    body: {
      emails: ["zoe@example.com"],
      admin: true,
    },
  });

  const first = await signIn(zoe);
  const again = await signIn(zoe);

  const left = (await (await server.api("/api/invites")).json()) as unknown[];

  expect([before.response.status, invited.status]).toEqual([403, 201]);
  expect(await userOf(first.cookie)).toMatchObject({ admin: true });
  expect(await userOf(again.cookie)).toMatchObject({ admin: true });
  expect(left).toEqual([]);
});

test("lets in whoever follows an invite link through the provider", async () => {
  const outsider: Account = {
    sub: "P000098",
    email: "out@elsewhere.org",
    groups: [],
  };

  const [link] = (await (
    await server.api("/api/invites", { body: {} })
  ).json()) as { token: string }[];

  const joining = (await (
    await fetch(new URL(`/api/auth/invites/${link?.token ?? ""}`, server.url))
  ).json()) as { logins: { path: string }[] };

  const { cookie } = await signIn(outsider, {
    start: joining.logins[0]?.path ?? "",
  });

  expect(joining.logins[0]?.path).toBe(
    `/api/ext/oidc/start/${providerId}?join=${link?.token ?? ""}`,
  );

  expect(await userOf(cookie)).toMatchObject({ admin: false });
});

test("only admins change plugins or restart the server", async () => {
  const { cookie } = await signIn(ana);

  const statuses = [
    (
      await server.as(cookie)("/api/plugins", {
        body: { url: "file:///nowhere" },
      })
    ).status,
    (
      await server.as(cookie)("/api/plugins/oidc", {
        method: "PATCH",
        body: { settings: {} },
      })
    ).status,
    (await server.as(cookie)("/api/plugins/oidc", { method: "DELETE" })).status,
    (await server.as(cookie)("/api/server/restart", { body: {} })).status,
  ];

  expect(statuses).toEqual([403, 403, 403, 403]);
});

test("only admins change a template's Kubernetes settings", async () => {
  const { cookie } = await signIn(ana);

  const template = (await (
    await server.api("/api/environment-templates", { body: { name: "pods" } })
  ).json()) as { id: string };

  const path = `/api/ext/kubernetes/templates/${template.id}`;
  const patch = { spec: { volumes: [{ name: "key", secret: {} }] } };

  const statuses = [
    (await server.as(cookie)(path)).status,
    (await server.as(cookie)(path, { body: { settings: { podPatch: patch } } }))
      .status,
    (await server.as(cookie)(path, { body: { settings: null } })).status,
    (await server.api(path, { body: { settings: { podPatch: patch } } }))
      .status,
  ];

  expect(statuses).toEqual([200, 403, 403, 200]);
});

test("only admins change model aliases, and anyone changes a Project's goal", async () => {
  const { cookie } = await signIn(ana);

  const environment = (await (
    await server.as(cookie)("/api/environments", { body: { name: "laptop" } })
  ).json()) as { id: string };

  const project = (await (
    await server.as(cookie)("/api/ext/projects/projects", {
      body: {
        name: "Release",
        repositories: ["https://example.com/app.git"],
      },
    })
  ).json()) as { id: string };

  const aliases = `/api/ext/models/environments/${environment.id}`;
  const settings = `/api/ext/projects/projects/${project.id}/settings`;

  const statuses = [
    (await server.as(cookie)(aliases, { body: { aliases: null } })).status,
    (await server.api(aliases, { body: { aliases: null } })).status,
    (await server.as(cookie)(settings, { body: { goal: "Ship it" } })).status,
  ];

  expect(statuses).toEqual([403, 200, 200]);
});

test("refuses a callback in a browser that didn't start the sign-in", async () => {
  const { response, cookie } = await signIn(ana, { browser: "" });

  expect(response.status).toBe(400);
  expect(cookie).toBe("");
});

test("lets a password user link their account and sign in with it", async () => {
  const linked = await signIn(
    { ...ana, email: "pedro@example.com" },
    {
      start: `/api/ext/oidc/link/${providerId}`,
      cookie: await server.signedIn(),
    },
  );

  expect(await linked.response.text()).toContain("url=/#settings/accounts");

  const { cookie } = await signIn({ ...ana, email: "pedro@example.com" });

  const status = (await (await server.as(cookie)("/api/auth")).json()) as {
    user: unknown;
  };

  const account = await server.api("/api/ext/oidc/account");

  expect(status.user).toMatchObject({ name: "pedro", admin: true });

  expect(await account.json()).toEqual({
    admin: true,
    passwordLogin: true,
    lockedIn: null,
    providers: [
      { id: providerId, label: "Sign in with IAS", issuer: provider.issuer },
    ],
    identities: [
      {
        issuer: provider.issuer,
        email: "pedro@example.com",
        linkedAt: expect.any(String) as string,
        created: false,
      },
    ],
  });

  const unlinked = await server.api(
    `/api/ext/oidc/identities/${encodeURIComponent(provider.issuer)}`,
    { method: "DELETE" },
  );

  expect(await unlinked.json()).toMatchObject({ identities: [] });
});

test("sends no client secret when none is set, and proves the code with PKCE", async () => {
  await signIn(ana);

  expect(provider.tokenRequests).toEqual([
    { authorization: null, clientId, verified: true },
  ]);
});

test("fails a sign-in with a page while discovery isn't JSON, and discovers again after", async () => {
  provider.broken = true;

  const failed = await fetch(
    new URL(`/api/ext/oidc/start/${providerId}`, server.url),
    { redirect: "manual" },
  );

  expect(failed.status).toBe(502);
  expect(await failed.text()).toContain("Sign-in failed");

  provider.broken = false;
  const { response } = await signIn(ana);

  expect(response.status).toBe(200);
});

test("fails a sign-in with a page when the token endpoint can't be reached", async () => {
  const started = await fetch(
    new URL(`/api/ext/oidc/start/${providerId}`, server.url),
    { redirect: "manual" },
  );

  const authorized = await fetch(started.headers.get("location") ?? "", {
    redirect: "manual",
  });

  await provider.stop();

  const response = await fetch(authorized.headers.get("location") ?? "", {
    redirect: "manual",
    headers: { cookie: cookieOf(started) },
  });

  expect(response.status).toBe(502);
  expect(await response.text()).toContain("Sign-in failed");
});

test("fails a sign-in with a page when the provider can't be reached", async () => {
  await provider.stop();

  const failed = await fetch(
    new URL(`/api/ext/oidc/start/${providerId}`, server.url),
    { redirect: "manual" },
  );

  expect(failed.status).toBe(502);

  expect(await failed.text()).toContain(
    `couldn&#39;t reach ${new URL(provider.issuer).host}`,
  );
});

// An OpenID provider that signs in whoever next is.
function fakeProvider(): {
  readonly issuer: string;
  next: Account | undefined;
  // Discovery and the token endpoint answer with a web page instead.
  broken: boolean;
  readonly tokenRequests: unknown[];
  readonly stop: () => Promise<void>;
} {
  const codes = new Map<
    string,
    { account: Account; nonce: string; challenge: string }
  >();

  const state = {
    issuer: "",
    next: undefined as Account | undefined,
    broken: false,
    tokenRequests: [] as unknown[],
    stop: async () => {
      await listener.stop(true);
    },
  };

  const listener = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);

      if (state.broken && url.pathname !== "/authorize") {
        return new Response("<h1>Bad gateway</h1>", {
          headers: { "content-type": "text/html" },
        });
      }

      if (url.pathname === "/.well-known/openid-configuration") {
        return Response.json({
          issuer: state.issuer,
          authorization_endpoint: `${state.issuer}/authorize`,
          token_endpoint: `${state.issuer}/token`,
        });
      }

      if (url.pathname === "/authorize") {
        const code = randomUUID();
        const back = new URL(url.searchParams.get("redirect_uri") ?? "");

        codes.set(code, {
          account: state.next ?? ana,
          nonce: url.searchParams.get("nonce") ?? "",
          challenge: url.searchParams.get("code_challenge") ?? "",
        });

        back.searchParams.set("code", code);
        back.searchParams.set("state", url.searchParams.get("state") ?? "");

        return Response.redirect(back.toString(), 302);
      }

      const form = new URLSearchParams(await request.text());
      const issued = codes.get(form.get("code") ?? "");

      const verified =
        createHash("sha256")
          .update(form.get("code_verifier") ?? "")
          .digest("base64url") === issued?.challenge;

      state.tokenRequests.push({
        authorization: request.headers.get("authorization"),
        clientId: form.get("client_id"),
        verified,
      });

      if (!verified) {
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }

      const claims = {
        iss: state.issuer,
        aud: clientId,
        exp: Math.floor(Date.now() / 1000) + 300,
        nonce: issued.nonce,
        ...issued.account,
      };

      return Response.json({
        id_token: `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.`,
      });
    },
  });

  state.issuer = `http://127.0.0.1:${String(listener.port)}`;

  return state;
}

test("tells admins how many people signed in with each provider this week", async () => {
  const listed = async (): Promise<unknown> =>
    (
      (await (await server.api("/api/ext/oidc/providers")).json()) as {
        signedInThisWeek: number;
      }[]
    )[0]?.signedInThisWeek;

  expect(await listed()).toBe(0);

  await signIn(ana);
  await signIn(ana);

  expect(await listed()).toBe(1);
});

test("tests whether the server reaches a provider", async () => {
  const tested = async (id: string): Promise<unknown> =>
    (
      await server.api(`/api/ext/oidc/providers/${id}/test`, {
        method: "POST",
      })
    ).json();

  expect(await tested(providerId)).toEqual({ ok: true, error: null });

  const gone = await addProvider("http://127.0.0.1:1");

  expect(await tested(gone)).toEqual({
    ok: false,
    error: expect.any(String) as string,
  });
});

test("tells admins whether passwords still sign people in", async () => {
  const account = (await (
    await server.api("/api/ext/oidc/account")
  ).json()) as { passwordLogin: boolean };

  expect(account.passwordLogin).toBe(true);
});
