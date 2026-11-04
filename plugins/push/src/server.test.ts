import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { createPublicKey, verify } from "node:crypto";
import { eventBus, type PluginRoute } from "@pipoca/plugins";
import {
  fakeContext,
  fakeSession,
  fakeUser,
  served,
} from "@pipoca/plugins/testing";
import type { Session } from "@pipoca/protocol";
import { push } from "./server";

interface Sent {
  readonly url: string;
  readonly headers: Headers;
  readonly body: Uint8Array;
}

let sent: Sent[];
let gone: Set<string>;
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;

beforeEach(() => {
  sent = [];
  gone = new Set();

  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = input instanceof Request ? input.url : input.toString();

    sent.push({
      url,
      headers: new Headers(init?.headers),
      body: new Uint8Array(init?.body as Uint8Array),
    });

    return Promise.resolve(
      new Response(null, { status: gone.has(url) ? 410 : 201 }),
    );
  }) as typeof fetch);
});

afterEach(() => {
  fetchSpy.mockRestore();
});

const endpoint = "https://fcm.googleapis.com/fcm/send/device-1";

// A browser's side of a subscription: its keys, to read what it is sent.
async function browser(at = endpoint): Promise<{
  readonly subscription: object;
  readonly read: (body: Uint8Array) => Promise<unknown>;
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

  const read = async (body: Uint8Array): Promise<unknown> => {
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

    const derive = async (
      ikm: Uint8Array<ArrayBuffer>,
      saltBytes: Uint8Array<ArrayBuffer>,
      info: string | Uint8Array<ArrayBuffer>,
      length: number,
    ): Promise<Uint8Array<ArrayBuffer>> =>
      new Uint8Array(
        await crypto.subtle.deriveBits(
          {
            name: "HKDF",
            hash: "SHA-256",
            salt: saltBytes,
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

type Bus = ReturnType<typeof eventBus>;

function registered(): { readonly route: PluginRoute; readonly events: Bus } {
  const routes: PluginRoute[] = [];

  const events = eventBus((_type, error) => {
    throw error;
  });

  const context = fakeContext({
    events: { ...events, declared: () => [] },
    auth: {
      ...fakeContext().auth,
      users: () => [
        { id: "owner", name: "Owner", admin: false },
        { id: "ana", name: "Ana", admin: false },
        { id: "boss", name: "Boss", admin: true },
      ],
    },
    routes: {
      handle: (route) => {
        routes.push(route);
      },
    },
  });

  push.register(context);
  const [route] = routes;
  if (route === undefined) {
    throw new Error("push registered no route");
  }

  return { route: served(route), events };
}

async function call(
  route: PluginRoute,
  method: string,
  path: string,
  body?: unknown,
  user = "owner",
): Promise<Response> {
  return route(
    new Request(`http://pipoca.test/api/plugins/push/${path}`, {
      method,
      ...(body !== undefined && { body: JSON.stringify(body) }),
    }),
    path,
    fakeUser({ id: user }),
  );
}

// Waits until the push service got this many messages. Each delivery
// handles the service's answer before the next timer runs.
async function delivered(count: number): Promise<void> {
  while (sent.length < count) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  await new Promise((resolve) => setTimeout(resolve, 0));
}

function finish(events: Bus, session: Session): void {
  events.publish({
    type: "SessionStateChanged",
    session: { ...session, status: "idle" },
    previous: "running",
  });
}

test("sends a subscribed browser a notification it can read when its Session finishes", async () => {
  const { route, events } = registered();
  const device = await browser();

  const { key } = (await (await call(route, "GET", "key")).json()) as {
    key: string;
  };

  await call(route, "PUT", "subscriptions", device.subscription);

  finish(
    events,
    fakeSession({ startedBy: "owner", title: "Fix the login page" }),
  );

  await delivered(1);

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

  expect(sent.map(({ url }) => url)).toEqual([endpoint]);
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

  expect(JSON.parse(Buffer.from(claims, "base64url").toString())).toMatchObject(
    { aud: "https://fcm.googleapis.com" },
  );

  expect(await device.read(message?.body ?? new Uint8Array())).toEqual({
    title: "Pi finished",
    body: "Fix the login page",
    session: "session-1",
    url: "/#session-1",
  });
});

test("tells the browser urgently when Pi needs an answer", async () => {
  const { route, events } = registered();
  const device = await browser();

  await call(route, "PUT", "subscriptions", device.subscription);

  events.publish({
    type: "SessionWaiting",
    session: fakeSession({
      startedBy: "owner",
      status: "running",
      waiting: true,
    }),
  });

  await delivered(1);

  expect(sent[0]?.headers.get("urgency")).toBe("high");

  expect(await device.read(sent[0]?.body ?? new Uint8Array())).toMatchObject({
    title: "Pi needs you",
  });
});

test("sends nothing for another person's Session or one a plugin owns", async () => {
  const { route, events } = registered();
  const device = await browser();

  await call(route, "PUT", "subscriptions", device.subscription);
  finish(events, fakeSession({ startedBy: "someone-else" }));

  finish(
    events,
    fakeSession({
      startedBy: "owner",
      owner: { plugin: "projects", key: "project-1" },
    }),
  );

  finish(events, fakeSession({ startedBy: "owner", title: "mine" }));
  await delivered(1);

  expect(sent.length).toBe(1);

  expect(await device.read(sent[0]?.body ?? new Uint8Array())).toMatchObject({
    body: "mine",
  });
});

// A second device that stays subscribed shows when each round was sent.
test("stops sending to a browser that unsubscribed or whose subscription is gone", async () => {
  const { route, events } = registered();
  const device = await browser();
  const other = "https://fcm.googleapis.com/fcm/send/device-2";

  await call(route, "PUT", "subscriptions", device.subscription);

  await call(
    route,
    "PUT",
    "subscriptions",
    (await browser(other)).subscription,
  );

  gone.add(endpoint);
  finish(events, fakeSession({ startedBy: "owner" }));
  await delivered(2);

  gone.clear();
  finish(events, fakeSession({ startedBy: "owner" }));
  await delivered(3);

  await call(route, "PUT", "subscriptions", device.subscription);
  await call(route, "DELETE", "subscriptions", { endpoint });
  finish(events, fakeSession({ startedBy: "owner" }));
  await delivered(4);

  expect(sent.map(({ url }) => url).sort()).toEqual(
    [endpoint, other, other, other].sort(),
  );
});

test("refuses an endpoint that isn't a browser's push service", async () => {
  const { route } = registered();
  const { subscription } = await browser();

  const response = await call(route, "PUT", "subscriptions", {
    ...subscription,
    endpoint: "http://169.254.169.254/latest/meta-data",
  });

  expect(response.status).toBe(400);
});

test("tells the person whose cap team work reached, and every admin, but no one else", async () => {
  const { route, events } = registered();

  const [own, anas, boss] = await Promise.all(
    ["device-1", "device-2", "device-3"].map(async (device) =>
      browser(`https://fcm.googleapis.com/fcm/send/${device}`),
    ),
  );

  await call(route, "PUT", "subscriptions", own?.subscription, "owner");
  await call(route, "PUT", "subscriptions", anas?.subscription, "ana");
  await call(route, "PUT", "subscriptions", boss?.subscription, "boss");

  events.publish({
    type: "usage.budget_warned",
    person: "ana",
    share: 80,
    spent: 40,
    limit: 50,
  });

  await delivered(2);

  const bodyTo = (device: string): Uint8Array =>
    sent.find(({ url }) => url.endsWith(device))?.body ?? new Uint8Array();

  expect(
    sent
      .map(({ url }) => url.split("/").at(-1))
      .toSorted((a = "", b = "") => a.localeCompare(b)),
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
