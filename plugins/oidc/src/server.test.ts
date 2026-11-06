import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
  type PluginTest,
  type TestPluginOptions,
  testPlugin,
} from "@pipoca/testing";
import type { oidc } from "../plugin";
import { server } from "./server";

const issuer = "https://idp.example.com";
const clientId = "pipoca-test";

const people = [{ id: "pedro", name: "pedro", admin: true }];

interface Account {
  readonly sub: string;
  readonly email: string;
  readonly email_verified?: boolean;
  readonly groups?: readonly string[];
  readonly [claim: string]: unknown;
}

const ana: Account = {
  sub: "P000001",
  email: "ana@example.com",
  groups: ["pipoca-users"],
};

const ias = {
  id: "ias",
  label: "Sign in with IAS",
  issuer,
  clientId,
  accessGroup: "pipoca-users",
  adminGroup: "pipoca-admins",
};

// An OpenID provider that signs in whoever the test sends to it.
function fakeProvider() {
  const codes = new Map<
    string,
    { account: Account; nonce: string; challenge: string }
  >();

  const state = {
    // Discovery and the token endpoint answer with a web page instead.
    broken: false,
    down: false,
    tokenRequests: [] as unknown[],
    now: Date.now,
  };

  // The provider's sign-in page, which sends the browser back with a code.
  const authorize = (location: string, account: Account): string => {
    const url = new URL(location);
    const back = new URL(url.searchParams.get("redirect_uri") ?? "");
    const code = randomUUID();

    codes.set(code, {
      account,
      nonce: url.searchParams.get("nonce") ?? "",
      challenge: url.searchParams.get("code_challenge") ?? "",
    });

    back.searchParams.set("code", code);
    back.searchParams.set("state", url.searchParams.get("state") ?? "");

    return back.href;
  };

  const fetch = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);

    if (state.down || url.origin !== issuer) {
      throw new Error("connection refused");
    }

    if (state.broken) {
      return new Response("<h1>Bad gateway</h1>", {
        headers: { "content-type": "text/html" },
      });
    }

    if (url.pathname === "/.well-known/openid-configuration") {
      return Response.json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
      });
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
      redirectUri: new URL(form.get("redirect_uri") ?? "").pathname,
      verified,
    });

    if (!verified) {
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }

    const claims = {
      iss: issuer,
      aud: clientId,
      exp: Math.floor(state.now() / 1000) + 300,
      nonce: issued.nonce,
      ...issued.account,
    };

    return Response.json({
      id_token: `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.`,
    });
  };

  return Object.assign(state, { authorize, fetch });
}

type Provider = ReturnType<typeof fakeProvider>;

type OidcTest = PluginTest & { readonly provider: Provider };

async function started(
  o: TestPluginOptions<typeof oidc> = {},
): Promise<OidcTest> {
  const provider = fakeProvider();

  const t = await testPlugin(server, {
    people,
    config: { providers: [ias] },
    fetch: provider.fetch,
    ...o,
  });

  provider.now = t.clock.now;

  return Object.assign(t, { provider });
}

function cookieOf(response: Response): string {
  return response.headers.get("set-cookie")?.split(";")[0] ?? "";
}

// Walks a browser through the provider and back. Returns the callback's answer and the Cookie
// header the browser sends next.
async function signIn(
  t: OidcTest,
  account: Account,
  o: {
    readonly start?: () => Promise<Response>;
    readonly browser?: string;
  } = {},
): Promise<{ readonly response: Response; readonly cookie: string }> {
  const leaving = await (o.start?.() ??
    t.public().raw("start/ias", { method: "GET" }));

  expect(leaving.status).toBe(302);

  const back = new URL(
    t.provider.authorize(leaving.headers.get("location") ?? "", account),
  );

  const response = await t.public().raw(`${back.pathname}${back.search}`, {
    method: "GET",
    headers: {
      cookie: o.browser ?? cookieOf(leaving),
    },
  });

  return { response, cookie: cookieOf(response) };
}

async function userOf(t: PluginTest, cookie: string): Promise<unknown> {
  const status = (await (
    await t.public().raw("/api/auth", { method: "GET", headers: { cookie } })
  ).json()) as { user: unknown };

  return status.user;
}

async function logins(
  t: PluginTest,
): Promise<readonly { label: string; path: string }[]> {
  const status = (await (
    await t.public().raw("/api/auth", { method: "GET" })
  ).json()) as {
    logins: { label: string; path: string }[];
  };

  return status.logins;
}

function providerInput(
  more: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  const { id: _id, ...input } = ias;

  return { ...input, ...more };
}

test("offers a button on the sign-in page for each provider in the config", async () => {
  await using t = await started({
    config: {
      providers: [ias, { ...ias, id: "google", label: "Sign in with Google" }],
    },
  });

  expect(await logins(t)).toEqual([
    { label: "Sign in with IAS", path: "/api/ext/oidc/start/ias" },
    { label: "Sign in with Google", path: "/api/ext/oidc/start/google" },
  ]);
});

test("makes a user for a member of the access group and signs them in", async () => {
  await using t = await started();

  const { response, cookie } = await signIn(t, ana);
  const again = await signIn(t, ana);

  expect(response.status).toBe(200);
  expect(response.headers.get("set-cookie")).toMatch(/SameSite=Strict/);
  expect(await response.text()).toContain('content="0;url=/"');

  expect(await userOf(t, cookie)).toEqual({
    id: expect.any(String) as string,
    name: "ana@example.com",
    admin: false,
  });

  expect(await userOf(t, again.cookie)).toEqual(await userOf(t, cookie));

  expect(t.provider.tokenRequests).toEqual([
    {
      authorization: null,
      clientId,
      redirectUri: "/api/ext/oidc/callback",
      verified: true,
    },
    expect.anything(),
  ]);
});

test("names a user it makes without the spaces around the provider's email", async () => {
  await using t = await started();

  const { cookie } = await signIn(t, {
    ...ana,
    email: " ana@example.com ",
  });

  expect(await userOf(t, cookie)).toMatchObject({ name: "ana@example.com" });
});

test("refuses someone outside the access group", async () => {
  await using t = await started();

  const { response, cookie } = await signIn(t, {
    ...ana,
    groups: ["others"],
  });

  expect(response.status).toBe(403);
  expect(await response.text()).toContain("Ask its admin to add you");
  expect(cookie).toBe("");
});

test("makes a member of the admin group an admin, and reads the groups again on every sign-in", async () => {
  await using t = await started();

  const groups = ["pipoca-users", "pipoca-admins"];
  const first = await signIn(t, { ...ana, groups });

  const providersAs = async (cookie: string): Promise<number> =>
    (await t.public().raw("providers", { method: "GET", headers: { cookie } }))
      .status;

  const user = await userOf(t, first.cookie);
  const asAdmin = await providersAs(first.cookie);
  const second = await signIn(t, { ...ana, groups: groups.slice(0, 1) });

  expect(user).toMatchObject({ admin: true });
  expect([asAdmin, await providersAs(second.cookie)]).toEqual([200, 403]);
});

test("keeps the role an admin gave when the provider names no admins", async () => {
  await using t = await started({
    config: { providers: [{ ...ias, adminGroup: "" }] },
  });

  await signIn(t, ana);

  const listed = (await (
    await t.as("pedro").raw("/api/people", { method: "GET" })
  ).json()) as { id: string; name: string }[];

  const id = listed.find(({ name }) => name === "ana@example.com")?.id ?? "";

  const made = await t
    .as("pedro")
    .raw(`/api/people/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ admin: true }),
    });

  const again = await signIn(t, ana);

  expect(made.status).toBe(200);
  expect(await userOf(t, again.cookie)).toMatchObject({ admin: true });
});

test("reads the groups from the claim the provider config names", async () => {
  await using t = await started({
    config: { providers: [{ ...ias, groupsClaim: "roles" }] },
  });

  const fromGroups = await signIn(t, ana);

  const fromRoles = await signIn(t, {
    ...ana,
    groups: [],
    roles: ["pipoca-users"],
  });

  expect([fromGroups.response.status, fromRoles.response.status]).toEqual([
    403, 200,
  ]);
});

test("lets in verified emails and domains for a provider without groups", async () => {
  await using t = await started({
    config: {
      providers: [
        {
          ...ias,
          accessGroup: "",
          adminGroup: "",
          allowedEmails: ["Bea@Gmail.com"],
          allowedDomains: ["example.org"],
          adminEmails: ["boss@example.net"],
        },
      ],
    },
  });

  const google = (email: string, verified = true): Account => ({
    sub: `google-${email}`,
    email,
    email_verified: verified,
  });

  const signedIn: unknown[] = [];

  for (const account of [
    google("bea@gmail.com"),
    google("cid@example.org"),
    google("boss@example.net"),
    google("dan@example.org", false),
    google("eve@gmail.com"),
  ]) {
    signedIn.push(await userOf(t, (await signIn(t, account)).cookie));
  }

  expect(signedIn).toMatchObject([
    { name: "bea@gmail.com", admin: false },
    { name: "cid@example.org", admin: false },
    { name: "boss@example.net", admin: true },
    null,
    null,
  ]);
});

test("lets in someone outside the rules who has an invite, with the invite's role, and keeps them in", async () => {
  await using t = await started();

  const zoe: Account = {
    sub: "P000099",
    email: "Zoe@Example.com",
    email_verified: true,
    groups: ["others"],
  };

  const before = await signIn(t, zoe);

  const invited = await t.as("pedro").raw("/api/invites", {
    method: "POST",
    body: JSON.stringify({
      emails: ["zoe@example.com"],
      admin: true,
    }),
  });

  const first = await signIn(t, zoe);
  const again = await signIn(t, zoe);
  const left = await (
    await t.as("pedro").raw("/api/invites", { method: "GET" })
  ).json();

  expect([before.response.status, invited.status]).toEqual([403, 201]);
  expect(await userOf(t, first.cookie)).toMatchObject({ admin: true });
  expect(await userOf(t, again.cookie)).toMatchObject({ admin: true });
  expect(left).toEqual([]);
});

test("lets in whoever follows an invite link through the provider", async () => {
  await using t = await started();

  const [link] = (await (
    await t
      .as("pedro")
      .raw("/api/invites", { method: "POST", body: JSON.stringify({}) })
  ).json()) as { token: string }[];

  const token = link?.token ?? "";

  const joining = (await (
    await t.public().raw(`/api/auth/invites/${token}`, { method: "GET" })
  ).json()) as { logins: { path: string }[] };

  const path = joining.logins[0]?.path ?? "";

  const { cookie } = await signIn(
    t,
    { sub: "P000098", email: "out@elsewhere.org", groups: [] },
    { start: async () => t.public().raw(path, { method: "GET" }) },
  );

  expect(path).toBe(`/api/ext/oidc/start/ias?join=${token}`);
  expect(await userOf(t, cookie)).toMatchObject({ admin: false });
});

test("refuses a callback in a browser that didn't start the sign-in", async () => {
  await using t = await started();

  const { response, cookie } = await signIn(t, ana, { browser: "" });

  expect(response.status).toBe(400);
  expect(cookie).toBe("");
});

test("lets a password user link their account, sign in with it, and unlink it", async () => {
  await using t = await started();

  const pedro = { ...ana, email: "pedro@example.com" };

  const linked = await signIn(t, pedro, {
    start: async () => t.as("pedro").raw("link/ias", { method: "GET" }),
  });

  const { cookie } = await signIn(t, pedro);
  const account = await t.as("pedro").get("account");

  expect(await linked.response.text()).toContain("url=/#settings/accounts");
  expect(await userOf(t, cookie)).toMatchObject({ name: "pedro", admin: true });

  expect(account).toEqual({
    admin: true,
    passwordLogin: true,
    lockedIn: null,
    providers: [{ id: "ias", label: "Sign in with IAS", issuer }],
    identities: [
      {
        issuer,
        email: "pedro@example.com",
        linkedAt: expect.any(String) as string,
        created: false,
      },
    ],
  });

  expect(
    await t.as("pedro").delete(`identities/${encodeURIComponent(issuer)}`),
  ).toMatchObject({ identities: [] });
});

test("keeps a client secret out of the page and the file, sends it to the provider, and takes it away", async () => {
  await using t = await started();

  const configure = async (clientSecret: string | null): Promise<unknown> =>
    t.as("pedro").post("providers/ias", providerInput({ clientSecret }));

  const set = await configure("s3cret value");
  const listed = await t.as("pedro").raw("providers", { method: "GET" });
  const file = JSON.stringify(await t.config());

  await signIn(t, ana);
  const kept = await configure("");
  await signIn(t, ana);
  const removed = await configure(null);
  await signIn(t, ana);

  const basic = `Basic ${Buffer.from(`${clientId}:s3cret+value`).toString("base64")}`;

  expect(set).toMatchObject({ hasClientSecret: true });
  expect(await listed.text()).not.toContain("s3cret");
  expect(file).not.toContain("s3cret");
  expect(kept).toMatchObject({ hasClientSecret: true });
  expect(removed).toMatchObject({ hasClientSecret: false });

  expect(t.provider.tokenRequests).toMatchObject([
    { authorization: basic, clientId: null, verified: true },
    { authorization: basic, clientId: null, verified: true },
    { authorization: null, clientId, verified: true },
  ]);
});

test("signs in with a client secret the config names by environment variable, and keeps naming it after a save", async () => {
  process.env["PIPOCA_TEST_OIDC_SECRET"] = "from the env";

  await using t = await started({
    config: {
      providers: [{ ...ias, clientSecret: { env: "PIPOCA_TEST_OIDC_SECRET" } }],
    },
  });

  const { cookie } = await signIn(t, ana);

  await t.as("pedro").post("providers/ias", providerInput({ label: "IAS" }));

  expect(await userOf(t, cookie)).toMatchObject({ name: "ana@example.com" });
  expect(process.env["PIPOCA_TEST_OIDC_SECRET"]).toBeUndefined();

  expect(t.provider.tokenRequests).toMatchObject([
    {
      authorization: `Basic ${Buffer.from(`${clientId}:from+the+env`).toString("base64")}`,
      clientId: null,
    },
  ]);

  expect(await t.config()).toMatchObject({
    providers: [
      { label: "IAS", clientSecret: { env: "PIPOCA_TEST_OIDC_SECRET" } },
    ],
  });
});

test("keeps the providers Settings adds in the config, without what is empty or default", async () => {
  await using t = await started({ config: { providers: [] } });

  const added = await t
    .as("pedro")
    .raw("providers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(providerInput({ groupsClaim: "groups" })),
    });

  expect(added.status).toBe(201);
  expect(await t.config()).toEqual({ providers: [ias] });
  expect(t.topics).toContain("oidc.providers");
});

test("refuses a provider without an issuer URL or a client ID", async () => {
  await using t = await started();

  const statuses = await Promise.all(
    [{ issuer: "not a url" }, { clientId: "" }].map(
      async (more) =>
        (
          await t
            .as("pedro")
            .raw("providers", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(providerInput(more)),
            })
        ).status,
    ),
  );

  expect(statuses).toEqual([400, 400]);
});

test("lets only admins see and change providers", async () => {
  await using t = await started();

  const { cookie } = await signIn(t, ana);

  const statuses = await Promise.all(
    (
      [
        ["GET", "providers"],
        ["POST", "providers"],
        ["DELETE", "providers/ias"],
      ] as const
    ).map(
      async ([method, path]) =>
        (
          await t.public().raw(path, {
            method,
            headers: { cookie, "content-type": "application/json" },
            ...(method === "POST" && { body: JSON.stringify(providerInput()) }),
          })
        ).status,
    ),
  );

  expect(statuses).toEqual([403, 403, 403]);
});

test("stops offering a provider once it is removed", async () => {
  await using t = await started();

  const removed = await t.as("pedro").delete("providers/ias");
  const start = await t.public().raw("start/ias", { method: "GET" });

  expect([removed, await logins(t), start.status]).toEqual([
    { removed: "ias" },
    [],
    404,
  ]);
});

test("reads providers edited into the file by hand", async () => {
  await using t = await started();

  await t.editConfig({ providers: [{ ...ias, label: "Sign in with SAP" }] });

  expect(await logins(t)).toEqual([
    { label: "Sign in with SAP", path: "/api/ext/oidc/start/ias" },
  ]);
});

test("leaves out a provider whose secret doesn't open, says why, and keeps it in the file when another is saved", async () => {
  const bad = { ...ias, id: "bad", clientSecret: { sealed: "x" } };
  await using t = await started({ config: { providers: [ias, bad] } });

  const before = await logins(t);

  await t.as("pedro").post("providers", providerInput({ label: "Google" }));

  expect(before.map(({ label }) => label)).toEqual(["Sign in with IAS"]);

  expect(
    t.log.filter(({ message }) => message === "config item skipped"),
  ).toContainEqual({
    message: "config item skipped",
    fields: expect.objectContaining({ path: "providers", item: "bad" }),
  });

  expect(await t.config()).toMatchObject({
    providers: [{ id: "ias" }, bad, { id: "google" }],
  });
});

test("tells admins how many people signed in with each provider this week", async () => {
  await using t = await started();

  const counted = async (): Promise<unknown> =>
    (
      await t
        .as("pedro")
        .get<readonly { signedInThisWeek: number }[]>("providers")
    )[0]?.signedInThisWeek;

  const none = await counted();

  await signIn(t, ana);
  await signIn(t, ana);
  const one = await counted();

  await t.clock.advance("8d");

  expect([none, one, await counted()]).toEqual([0, 1, 0]);
});

test("tests whether the server reaches a provider", async () => {
  await using t = await started({
    config: {
      providers: [
        ias,
        { ...ias, id: "gone", issuer: "https://gone.example.com" },
      ],
    },
  });

  expect(await t.as("pedro").post("providers/ias/test")).toEqual({
    ok: true,
    error: null,
  });

  expect(await t.as("pedro").post("providers/gone/test")).toEqual({
    ok: false,
    error: "couldn't reach gone.example.com: connection refused",
  });
});

test("sends no client secret when none is set, and proves the code with PKCE", async () => {
  await using t = await started();

  await signIn(t, ana);

  expect(t.provider.tokenRequests).toMatchObject([
    { authorization: null, clientId, verified: true },
  ]);
});

test("fails a sign-in with a page while discovery isn't JSON, and discovers again after", async () => {
  await using t = await started();

  t.provider.broken = true;
  const failed = await t.public().raw("start/ias", { method: "GET" });

  t.provider.broken = false;
  const { response } = await signIn(t, ana);

  expect(failed.status).toBe(502);
  expect(await failed.text()).toContain("Sign-in failed");
  expect(response.status).toBe(200);
});

test("fails a sign-in with a page when the token endpoint can't be reached", async () => {
  await using t = await started();

  const leaving = await t.public().raw("start/ias", { method: "GET" });

  const back = new URL(
    t.provider.authorize(leaving.headers.get("location") ?? "", ana),
  );

  t.provider.down = true;

  const response = await t
    .public()
    .raw(`callback${back.search}`, {
      method: "GET",
      headers: { cookie: cookieOf(leaving) },
    });

  expect(response.status).toBe(502);
  expect(await response.text()).toContain("Sign-in failed");
});

test("fails a sign-in with a page when the provider can't be reached", async () => {
  await using t = await started();

  t.provider.down = true;
  const failed = await t.public().raw("start/ias", { method: "GET" });

  expect(failed.status).toBe(502);
  expect(await failed.text()).toContain("couldn&#39;t reach idp.example.com");
});

test("tells people whether passwords still sign them in", async () => {
  await using t = await started();

  expect(await t.as("pedro").get("account")).toMatchObject({
    passwordLogin: true,
  });
});
