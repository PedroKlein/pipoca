import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { serve } from "./serve";
import { firstUser } from "./testdata/sign-in";

let server: ReturnType<typeof serve>;
let pedro: () => Promise<string>;

beforeEach(() => {
  const logs: string[] = [];

  server = serve({
    port: 0,
    database: ":memory:",
    log: (message, fields) => {
      logs.push(`${message} ${JSON.stringify(fields)}`);
    },
  });

  pedro = firstUser(server, logs);
});

afterEach(async () => {
  await server.stop();
});

function pair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");

  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
  };
}

async function handoff(cookie: string, challenge: string): Promise<Response> {
  return fetch(new URL("/api/auth/app", server.url), {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ challenge }),
  });
}

async function linkOf(response: Response): Promise<URL> {
  const { link } = (await response.json()) as { link: string };

  return new URL(link);
}

async function redeem(token: string, verifier?: string): Promise<Response> {
  const url = new URL(`/api/auth/link/${token}`, server.url);
  if (verifier !== undefined) {
    url.searchParams.set("verifier", verifier);
  }

  return fetch(url, { redirect: "manual" });
}

// The desktop app signs in through the person's browser and gets its own
// session from a pipoca:// link (ADR 0055).
test("signs the desktop app in as the person signed in in their browser", async () => {
  const { verifier, challenge } = pair();
  const link = await linkOf(await handoff(await pedro(), challenge));
  const token = link.searchParams.get("link") ?? "";

  const visit = await redeem(token, verifier);
  const cookie = visit.headers.get("set-cookie")?.split(";")[0] ?? "";

  const status = (await (
    await fetch(new URL("/api/auth", server.url), { headers: { cookie } })
  ).json()) as { user: { name: string } | null };

  expect([link.protocol, link.host]).toEqual(["pipoca:", "signed-in"]);
  expect(link.searchParams.get("challenge")).toBe(challenge);
  expect([visit.status, visit.headers.get("location")]).toEqual([303, "/"]);
  expect(status.user?.name).toBe("pedro");
  expect((await redeem(token, verifier)).status).toBe(403);
});

test("refuses the app's link without the verifier only the app has", async () => {
  const cookie = await pedro();

  const tokens = await Promise.all(
    [pair(), pair()].map(async ({ challenge }) =>
      (await linkOf(await handoff(cookie, challenge))).searchParams.get("link"),
    ),
  );

  const [missing, wrong] = await Promise.all([
    redeem(tokens[0] ?? ""),
    redeem(tokens[1] ?? "", pair().verifier),
  ]);

  expect([missing.status, wrong.status]).toEqual([403, 403]);
  expect(wrong.headers.get("set-cookie")).toBeNull();
});

test("hands the app no link for a browser that isn't signed in", async () => {
  await pedro();

  const [signedOut, odd] = await Promise.all([
    handoff("", pair().challenge),
    handoff(await pedro(), "short"),
  ]);

  expect([signedOut.status, odd.status]).toEqual([401, 400]);
});
