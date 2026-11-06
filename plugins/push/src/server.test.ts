import { expect, test } from "bun:test";
import { createPublicKey, verify } from "node:crypto";
import { server as logins } from "@pipoca/logins/server";
import {
  type PluginTest,
  person,
  type TestSession,
  testPlugin,
  until,
} from "@pipoca/testing";
import { server as usage } from "@pipoca/usage/server";
import { server } from "./server";

interface Sent {
  readonly url: string;
  readonly headers: Headers;
  readonly body: Uint8Array<ArrayBuffer>;
}

const people = [
  { id: "owner", name: "Owner" },
  { id: "ana", name: "Ana" },
  { id: "boss", name: "Boss", admin: true },
];

const device = (name: string) => `https://fcm.googleapis.com/fcm/send/${name}`;

// The browsers' push service, which answers 410 for an endpoint that's gone,
// and Anthropic, answering each call with the tokens its body asks for.
function services(): {
  readonly sent: Sent[];
  readonly gone: Set<string>;
  readonly fetch: (request: Request) => Promise<Response>;
} {
  const sent: Sent[] = [];
  const gone = new Set<string>();

  return {
    sent,
    gone,
    fetch: async (request) => {
      if (request.url.startsWith("https://api.anthropic.com/")) {
        const { input } = (await request.json()) as { input: number };

        const events = [
          {
            type: "message_start",
            message: { usage: { input_tokens: input } },
          },
          { type: "message_delta", usage: { output_tokens: 0 } },
        ];

        return new Response(
          events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
          { headers: { "content-type": "text/event-stream" } },
        );
      }

      sent.push({
        url: request.url,
        headers: request.headers,
        body: new Uint8Array(await request.arrayBuffer()),
      });

      return new Response(null, { status: gone.has(request.url) ? 410 : 201 });
    },
  };
}

// A browser's side of a subscription: its keys, to read what it is sent.
async function browser(at = device("device-1")): Promise<{
  readonly subscription: object;
  readonly read: (
    body: Uint8Array<ArrayBuffer> | undefined,
  ) => Promise<unknown>;
}> {
  const keys = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );

  const own = new Uint8Array(
    await crypto.subtle.exportKey("raw", keys.publicKey),
  );

  const auth = crypto.getRandomValues(new Uint8Array(16));

  const derive = async (
    ikm: Uint8Array<ArrayBuffer>,
    salt: Uint8Array<ArrayBuffer>,
    info: string | Uint8Array<ArrayBuffer>,
    length: number,
  ): Promise<Uint8Array<ArrayBuffer>> =>
    new Uint8Array(
      await crypto.subtle.deriveBits(
        {
          name: "HKDF",
          hash: "SHA-256",
          salt,
          info:
            typeof info === "string"
              ? Uint8Array.from(Buffer.from(info))
              : info,
        },
        await crypto.subtle.importKey("raw", ikm, "HKDF", false, [
          "deriveBits",
        ]),
        length * 8,
      ),
    );

  const read = async (body = new Uint8Array()): Promise<unknown> => {
    const salt = body.slice(0, 16);
    const senderKey = body.slice(21, 21 + 65);

    const sender = await crypto.subtle.importKey(
      "raw",
      senderKey,
      { name: "ECDH", namedCurve: "P-256" },
      false,
      [],
    );

    const shared = await crypto.subtle.deriveBits(
      { name: "ECDH", public: sender },
      keys.privateKey,
      256,
    );

    const ikm = await derive(
      new Uint8Array(shared),
      auth,
      Uint8Array.from(
        Buffer.concat([Buffer.from("WebPush: info\0"), own, senderKey]),
      ),
      32,
    );

    const cek = await derive(ikm, salt, "Content-Encoding: aes128gcm\0", 16);
    const nonce = await derive(ikm, salt, "Content-Encoding: nonce\0", 12);

    const plain = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: nonce },
        await crypto.subtle.importKey("raw", cek, "AES-GCM", false, [
          "decrypt",
        ]),
        body.slice(21 + 65),
      ),
    );

    expect(plain.at(-1)).toBe(2);

    return JSON.parse(Buffer.from(plain.slice(0, -1)).toString());
  };

  return {
    subscription: {
      endpoint: at,
      keys: {
        p256dh: Buffer.from(own).toString("base64url"),
        auth: Buffer.from(auth).toString("base64url"),
      },
    },
    read,
  };
}

// Waits until the push service got this many messages, and each delivery
// has handled the service's answer.
async function delivered(sent: readonly Sent[], count: number): Promise<void> {
  await until(
    () => sent.length,
    (length) => length >= count,
  );

  await new Promise((resolve) => setTimeout(resolve, 10));
}

// A turn of Pi's that ends.
async function finish(session: TestSession): Promise<void> {
  await session.report([{ type: "status", status: "running" }]);
  await session.report([{ type: "status", status: "idle" }]);
}

async function subscribe(
  t: PluginTest,
  who: string,
  subscription: object,
): Promise<void> {
  expect(
    (
      await t.as(who).raw("PUT", "subscriptions", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify(subscription),
      })
    ).ok,
  ).toBe(true);
}

test("sends a subscribed browser a notification it can read when its Session finishes", async () => {
  const { sent, fetch } = services();
  await using t = await testPlugin(server, { people, fetch });
  const own = await browser();
  const { key } = await t.as("owner").get<{ key: string }>("key");

  await subscribe(t, "owner", own.subscription);

  const session = await t.session({ owner: person("owner") });

  await session.transcript([
    { type: "session_info", name: "Fix the login page" },
  ]);

  await finish(session);
  await delivered(sent, 1);

  const [message] = sent;

  const [token = "", publicKey] =
    message?.headers
      .get("authorization")
      ?.match(/^vapid t=(.+), k=(.+)$/)
      ?.slice(1) ?? [];

  const [header = "", claims = "", signature = ""] = token.split(".");
  const point = Buffer.from(key, "base64url");

  const signer = createPublicKey({
    key: {
      kty: "EC",
      crv: "P-256",
      x: point.subarray(1, 33).toString("base64url"),
      y: point.subarray(33).toString("base64url"),
    },
    format: "jwk",
  });

  expect(sent.map(({ url }) => url)).toEqual([device("device-1")]);
  expect(publicKey).toBe(key);
  expect(message?.headers.get("content-encoding")).toBe("aes128gcm");

  expect(
    verify(
      "sha256",
      Buffer.from(`${header}.${claims}`),
      { key: signer, dsaEncoding: "ieee-p1363" },
      Buffer.from(signature, "base64url"),
    ),
  ).toBe(true);

  expect(JSON.parse(Buffer.from(claims, "base64url").toString())).toEqual({
    aud: "https://fcm.googleapis.com",
    exp: Math.floor(t.clock.now() / 1000) + 12 * 60 * 60,
    sub: "https://github.com/PedroKlein/pipoca",
  });

  expect(await own.read(message?.body)).toEqual({
    title: "Pi finished",
    body: "Fix the login page",
    session: session.id,
    url: `/#${session.id}`,
  });
});

test("keeps its signing key across a restart", async () => {
  await using t = await testPlugin(server, { people });
  const before = await t.as("owner").get("key");

  await t.restart();

  expect(await t.as("owner").get("key")).toEqual(before);
});

test("tells the browser urgently when Pi needs an answer", async () => {
  const { sent, fetch } = services();
  await using t = await testPlugin(server, { people, fetch });
  const own = await browser();

  await subscribe(t, "owner", own.subscription);

  const session = await t.session({ owner: person("owner") });

  await session.report([
    { type: "status", status: "running" },
    {
      type: "prompt",
      prompt: { id: "q1", kind: "confirm", title: "Go on?", message: "" },
    },
  ]);

  await delivered(sent, 1);

  expect(sent[0]?.headers.get("urgency")).toBe("high");

  expect(await own.read(sent[0]?.body)).toMatchObject({
    title: "Pi needs you",
  });
});

test("sends nothing for another person's Session or one a plugin owns", async () => {
  const { sent, fetch } = services();
  await using t = await testPlugin(server, { people, fetch });
  const own = await browser();

  await subscribe(t, "owner", own.subscription);

  await finish(await t.session({ owner: person("ana") }));
  await finish(await t.session({ owner: person("owner"), key: "thread-1" }));

  const mine = await t.session({ owner: person("owner") });

  await finish(mine);
  await delivered(sent, 1);

  expect(sent.length).toBe(1);
  expect(await own.read(sent[0]?.body)).toMatchObject({ session: mine.id });
});

// A second device that stays subscribed shows when each round was sent.
test("stops sending to a browser that unsubscribed or whose subscription is gone", async () => {
  const { sent, gone, fetch } = services();
  await using t = await testPlugin(server, { people, fetch });
  const first = await browser(device("device-1"));

  await subscribe(t, "owner", first.subscription);
  await subscribe(t, "owner", (await browser(device("device-2"))).subscription);

  const session = await t.session({ owner: person("owner") });

  gone.add(device("device-1"));
  await finish(session);
  await delivered(sent, 2);

  gone.clear();
  await finish(session);
  await delivered(sent, 3);

  await subscribe(t, "owner", first.subscription);

  // Another person can't unsubscribe the owner's browser.
  await t.as("ana").delete("subscriptions", { endpoint: device("device-1") });
  await finish(session);
  await delivered(sent, 5);

  await t.as("owner").delete("subscriptions", { endpoint: device("device-1") });
  await finish(session);
  await delivered(sent, 6);

  expect(
    sent
      .map(({ url }) => url.split("/").at(-1) ?? "")
      .toSorted((a, b) => a.localeCompare(b)),
  ).toEqual([
    "device-1",
    "device-1",
    "device-2",
    "device-2",
    "device-2",
    "device-2",
  ]);
});

test("refuses an endpoint that isn't a browser's push service", async () => {
  await using t = await testPlugin(server, { people });
  const { subscription } = await browser();

  const response = await t.as("owner").raw("PUT", "subscriptions", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...subscription,
      endpoint: "http://169.254.169.254/latest/meta-data",
    }),
  });

  expect(response.status).toBe(400);
});

test("tells the person whose cap team work reached, and every admin, but no one else", async () => {
  const { sent, fetch } = services();

  await using t = await testPlugin(server, {
    people,
    fetch,
    plugins: [logins, usage],
  });

  expect(
    (
      await t.as("boss").kernel("PUT", "/api/plugins/usage/config", {
        value: {
          prices: { "anthropic/claude-sonnet-4-5": { input: 1, output: 0 } },
          budgets: { team: 0, person: 50 },
        },
      })
    ).status,
  ).toBe(200);

  const devices = await Promise.all(
    ["device-1", "device-2", "device-3"].map(async (name) =>
      browser(device(name)),
    ),
  );

  const [owns, anas, boss] = devices;

  await subscribe(t, "owner", owns?.subscription ?? {});
  await subscribe(t, "ana", anas?.subscription ?? {});
  await subscribe(t, "boss", boss?.subscription ?? {});

  expect(
    (
      await t.as("boss").kernel("POST", "/api/ext/logins/save", {
        provider: "anthropic",
        credential: { type: "api_key", key: "sk-team" },
        layer: "base",
      })
    ).status,
  ).toBe(200);

  const work = await t.session({ owner: "team", startedBy: "ana" });

  // Pi's providers load in the background when logins registers.
  const { token = "" } = await until(
    async () =>
      (await (await work.request("proxy", {}, "logins")).json()) as {
        providers: readonly unknown[];
        token?: string;
      },
    ({ providers }) => providers.length > 0,
  );

  const answered = await t
    .as("boss")
    .kernel(
      "POST",
      "/api/ext/logins/proxy/anthropic/v1/messages",
      { model: "claude-sonnet-4-5", stream: true, input: 40_000_000 },
      { "x-api-key": token },
    );

  await answered.text();
  await delivered(sent, 2);

  const bodyTo = (name: string): Uint8Array<ArrayBuffer> | undefined =>
    sent.find(({ url }) => url.endsWith(name))?.body;

  expect(
    sent
      .map(({ url }) => url.split("/").at(-1) ?? "")
      .toSorted((a, b) => a.localeCompare(b)),
  ).toEqual(["device-2", "device-3"]);

  expect(await anas?.read(bodyTo("device-2"))).toEqual({
    title: "Your team work reached 80% of your monthly cap",
    body: "$40.00 of $50.00 this month",
    tag: "usage.budget",
    url: "/",
  });

  expect(await boss?.read(bodyTo("device-3"))).toMatchObject({
    title: "Ana's team work reached 80% of their monthly cap",
  });
});

test("tells the person Pi asks in team work, and the starter once nobody answers in time", async () => {
  const { sent, fetch } = services();

  await using t = await testPlugin(server, {
    people,
    fetch,
    config: { answerMinutes: 5 },
  });

  const [owns, anas] = await Promise.all(
    ["device-1", "device-2"].map(async (name) => browser(device(name))),
  );

  await subscribe(t, "owner", owns?.subscription ?? {});
  await subscribe(t, "ana", anas?.subscription ?? {});

  const ask = async (session: TestSession, id: string) =>
    session.report([
      { type: "status", status: "running" },
      {
        type: "prompt",
        prompt: {
          id,
          kind: "questions",
          title: "Which one?",
          questions: [],
          explain: false,
          for: "Ana",
        },
      },
    ]);

  const answered = await t.session({ owner: "team", startedBy: "owner" });
  const waiting = await t.session({ owner: "team", startedBy: "owner" });

  await ask(answered, "q1");
  await ask(waiting, "q2");
  await delivered(sent, 2);

  await answered.report([{ type: "prompt_end", id: "q1" }]);
  await t.clock.advance("4m");

  expect(sent.length).toBe(2);

  await t.clock.advance("1m");
  await delivered(sent, 3);

  expect(sent.map(({ url }) => url.split("/").at(-1))).toEqual([
    "device-2",
    "device-2",
    "device-1",
  ]);

  expect(await anas?.read(sent[0]?.body)).toMatchObject({
    title: "Pi has a question for you",
  });

  expect(await owns?.read(sent[2]?.body)).toMatchObject({
    title: "Nobody answered Pi's question for Ana",
    session: waiting.id,
  });
});
