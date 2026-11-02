import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import {
  BadRequest,
  NotFound,
  type PluginStore,
  readBody,
  type ServerPlugin,
  type ServerPluginContext,
  Type,
} from "@pipoca/plugins";
import type { Session, SessionStatus } from "@pipoca/protocol";
import { encrypt, newSender } from "./encrypt";

// Browsers hand out endpoints on their vendor's push service. Sending only
// there keeps the server from posting to any address a user names.
const pushServices = [
  /^fcm\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /^web\.push\.apple\.com$/,
  /\.push\.apple\.com$/,
  /\.notify\.windows\.com$/,
];

// Apple refuses a VAPID token without a contact.
const contact = "https://github.com/PedroKlein/pipoca";

const subscription = Type.Object({
  endpoint: Type.String(),
  keys: Type.Object({ p256dh: Type.String(), auth: Type.String() }),
});

const unsubscription = Type.Object({ endpoint: Type.String() });

const busy: readonly SessionStatus[] = ["queued", "starting", "running"];

interface Subscription {
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
}

interface Notice {
  readonly title: string;
  readonly body: string;
  readonly session: string;
  readonly url: string;
}

export const push: ServerPlugin = {
  name: "push",
  register: (context) => {
    const { store } = context;

    store.exec(
      "create table if not exists push_vapid (id integer primary key check (id = 1), private_key text not null)",
    );

    store.exec(
      "create table if not exists push_subscriptions (endpoint text primary key, user_id text not null, p256dh text not null, auth text not null, created_at text not null)",
    );

    const keys = vapidKeys(store);

    context.routes.handle(async (request, path, caller) => {
      if (caller.kind !== "user") {
        throw new NotFound(`no route ${path}`);
      }

      if (path === "key" && request.method === "GET") {
        return Response.json({ key: keys.publicKey });
      }

      if (path === "subscriptions" && request.method === "PUT") {
        const { endpoint, keys: browser } = await readBody(
          request,
          subscription,
        );

        if (!isPushService(endpoint)) {
          throw new BadRequest("endpoint must be a browser's push service");
        }

        store.run(
          "insert into push_subscriptions (endpoint, user_id, p256dh, auth, created_at) values (?, ?, ?, ?, ?) on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth",
          endpoint,
          caller.actor.slice("user:".length),
          browser.p256dh,
          browser.auth,
          new Date().toISOString(),
        );

        return Response.json({ ok: true });
      }

      if (path === "subscriptions" && request.method === "DELETE") {
        const { endpoint } = await readBody(request, unsubscription);

        store.run(
          "delete from push_subscriptions where endpoint = ? and user_id = ?",
          endpoint,
          caller.actor.slice("user:".length),
        );

        return Response.json({ ok: true });
      }

      throw new NotFound(`no route ${path}`);
    });

    const send = (session: Session, title: string, urgent: boolean): void => {
      if (session.startedBy === null) {
        return;
      }

      const notice: Notice = {
        title,
        body: session.title ?? "",
        session: session.id,
        url: `/#${session.id}`,
      };

      const subscriptions = store.all(
        "select endpoint, p256dh, auth from push_subscriptions where user_id = ?",
        session.startedBy,
      ) as Subscription[];

      for (const target of subscriptions) {
        void deliver(target, notice, urgent, keys, store, context);
      }
    };

    context.events.subscribe("SessionWaiting", ({ session }) => {
      send(session, "Pi needs you", true);
    });

    // Sessions a plugin owns, such as a Project's threads, report to it
    // instead of to a person.
    context.events.subscribe("SessionStateChanged", ({ session, previous }) => {
      const stopped =
        busy.includes(previous) &&
        !busy.includes(session.status) &&
        (previous === "running" || session.status !== "idle");

      if (stopped && session.owner === null) {
        send(session, finishedTitle(session.status), false);
      }
    });
  },
};

function finishedTitle(status: SessionStatus): string {
  switch (status) {
    case "failed":
      return "Pi failed";
    case "interrupted":
      return "Pi was interrupted";
    case "stopped":
      return "Pi stopped";
    case "queued":
    case "starting":
    case "running":
    case "idle":
      return "Pi finished";
  }
}

interface VapidKeys {
  readonly publicKey: string;
  readonly privateKey: string;
}

function vapidKeys(store: PluginStore): VapidKeys {
  const [row] = store.all("select private_key from push_vapid") as {
    private_key: string;
  }[];

  const pem =
    row === undefined
      ? createVapidKey(store)
      : store.open(row.private_key, "push.vapid");

  const jwk = createPrivateKey(pem).export({ format: "jwk" });

  const point = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(jwk.x ?? "", "base64url"),
    Buffer.from(jwk.y ?? "", "base64url"),
  ]);

  return { publicKey: point.toString("base64url"), privateKey: pem };
}

function createVapidKey(store: PluginStore): string {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pem = privateKey.export({ format: "pem", type: "pkcs8" });

  store.run(
    "insert into push_vapid (id, private_key) values (1, ?)",
    store.seal(pem, "push.vapid"),
  );

  return pem;
}

function isPushService(endpoint: string): boolean {
  if (!URL.canParse(endpoint)) {
    return false;
  }

  const url = new URL(endpoint);

  return (
    url.protocol === "https:" &&
    pushServices.some((host) => host.test(url.hostname))
  );
}

// RFC 8292: a token signed with the server's key that the push service
// checks against the key the browser subscribed with.
function vapidToken(audience: string, keys: VapidKeys): string {
  const encode = (value: object): string =>
    Buffer.from(JSON.stringify(value)).toString("base64url");

  const unsigned = `${encode({ typ: "JWT", alg: "ES256" })}.${encode({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: contact,
  })}`;

  const signature = sign("sha256", Buffer.from(unsigned), {
    key: keys.privateKey,
    dsaEncoding: "ieee-p1363",
  });

  return `${unsigned}.${signature.toString("base64url")}`;
}

async function deliver(
  target: Subscription,
  notice: Notice,
  urgent: boolean,
  keys: VapidKeys,
  store: PluginStore,
  context: ServerPluginContext,
): Promise<void> {
  const endpoint = new URL(target.endpoint);

  try {
    const body = await encrypt(
      new TextEncoder().encode(JSON.stringify(notice)),
      Uint8Array.from(Buffer.from(target.p256dh, "base64url")),
      Uint8Array.from(Buffer.from(target.auth, "base64url")),
      await newSender(),
    );

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: `vapid t=${vapidToken(endpoint.origin, keys)}, k=${keys.publicKey}`,
        "content-encoding": "aes128gcm",
        "content-type": "application/octet-stream",
        ttl: String(24 * 60 * 60),
        urgency: urgent ? "high" : "normal",
      },
      body,
    });

    // The browser unsubscribed or the subscription expired.
    if (response.status === 404 || response.status === 410) {
      store.run(
        "delete from push_subscriptions where endpoint = ?",
        target.endpoint,
      );

      context.log("push subscription gone, removed", {
        service: endpoint.hostname,
        status: response.status,
      });

      return;
    }

    if (!response.ok) {
      context.log("push service refused a notification", {
        service: endpoint.hostname,
        status: response.status,
        body: (await response.text()).slice(0, 200),
      });
    }
  } catch (error) {
    context.log("could not send a push notification", {
      service: endpoint.hostname,
      error: String(error),
    });
  }
}
