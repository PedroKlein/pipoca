import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import {
  BadRequest,
  defineServer,
  type Owner,
  owners,
  type Person,
  type Secrets,
  type ServerContext,
  type Store,
  Type,
} from "@pipoca/plugins";
import { isBusy, type Session, type SessionStatus } from "@pipoca/protocol";
import { routines } from "@pipoca/routines/plugin";
import { usage } from "@pipoca/usage/plugin";
import { push } from "../plugin";
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

const remind = "remind:";

interface Subscription {
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
}

interface Notice {
  readonly title: string;
  readonly body: string;
  readonly session?: string;
  // A newer notice of the same tag replaces the one shown.
  readonly tag?: string;
  readonly url: string;
}

interface Reminder {
  readonly sessionId: string;
  readonly asked: string;
}

// Web Push to each browser a person subscribed: when their Session finishes
// or Pi needs them, and of budget warnings.
export const server = defineServer(
  push,
  ({
    clock,
    config,
    events,
    log,
    network,
    people,
    routes,
    schedule,
    secrets,
    sessions,
    store,
  }) => {
    const keys = vapidKeys(store, secrets);

    routes.get("key", { auth: "person" }, () => ({ key: keys.publicKey }));

    routes.put(
      "subscriptions",
      { auth: "person", body: subscription },
      ({ body: { endpoint, keys: browser }, caller: { person } }) => {
        if (!isPushService(endpoint)) {
          throw new BadRequest("endpoint must be a browser's push service");
        }

        store.run(
          "insert into push_subscriptions (endpoint, user_id, p256dh, auth, created_at) values (?, ?, ?, ?, ?) on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth",
          endpoint,
          person.id,
          browser.p256dh,
          browser.auth,
          clock.now(),
        );
      },
    );

    routes.delete(
      "subscriptions",
      { auth: "person", query: unsubscription },
      ({ query: { endpoint }, caller: { person } }) => {
        store.run(
          "delete from push_subscriptions where endpoint = ? and user_id = ?",
          endpoint,
          person.id,
        );
      },
    );

    const sender = { store, clock, log, keys, network };

    const tell = (userId: string, notice: Notice, urgent: boolean): void => {
      const subscriptions = store.all<Subscription>(
        "select endpoint, p256dh, auth from push_subscriptions where user_id = ?",
        userId,
      );

      for (const target of subscriptions) {
        void deliver(target, notice, urgent, sender);
      }
    };

    const send = (session: Session, title: string, urgent: boolean): void => {
      if (session.startedBy === null) {
        return;
      }

      tell(session.startedBy, sessionNotice(session, title), urgent);
    };

    // The person whose cap it is and every admin hear of a budget warning
    // (ADR 0066).
    events.on(usage.events.budget_warned, ({ fields }) => {
      const { person, share, spent, limit } = fields;
      const capped = person === null ? undefined : people.get(person);
      const body = `$${spent.toFixed(2)} of $${limit.toFixed(2)} this month`;

      const title = (user: Person): string => {
        if (user.id === capped?.id) {
          return `Your team work reached ${String(share)}% of your monthly cap`;
        }

        return capped === undefined
          ? `Team work reached ${String(share)}% of its monthly budget`
          : `${capped.name}'s team work reached ${String(share)}% of their monthly cap`;
      };

      for (const user of people.list()) {
        if (user.id === capped?.id || user.admin) {
          tell(
            user.id,
            { title: title(user), body, tag: "usage.budget", url: "/" },
            false,
          );
        }
      }
    });

    // A routine that paused itself, such as at its daily spend cap, or
    // whose chain went too deep, tells its person, or every admin for the
    // team's (ADR 0075, ADR 0076).
    const tellRoutine = (
      to: readonly Owner[],
      notice: {
        readonly title: string;
        readonly body: string;
        readonly tag: string;
      },
    ): void => {
      const told = new Set(
        to.flatMap((owner) => {
          const id = owners.personId(owner);

          return id === undefined
            ? people.list().flatMap((user) => (user.admin ? [user.id] : []))
            : [id];
        }),
      );

      for (const id of told) {
        tell(id, { ...notice, url: "/" }, false);
      }
    };

    events.on(routines.events.paused, ({ fields, to }) => {
      tellRoutine(to, {
        title: `Routine paused: ${fields.title}`,
        body: fields.reason,
        tag: `routines.paused.${fields.name}`,
      });
    });

    events.on(routines.events.chain_stopped, ({ fields, to }) => {
      tellRoutine(to, {
        title: `Routine chain stopped: ${fields.title}`,
        body: fields.reason,
        tag: `routines.chain_stopped.${fields.name}`,
      });
    });

    // In team work Pi asks a named person, and whoever started the work hears
    // of it too if nobody answers in time (ADR 0065).
    events.on("SessionWaiting", ({ session, for: name }) => {
      const asked =
        session.ownedBy === "team" && name !== undefined
          ? people.byName(name)
          : undefined;

      if (asked === undefined) {
        send(session, "Pi needs you", true);

        return;
      }

      tell(asked.id, sessionNotice(session, "Pi has a question for you"), true);

      if (asked.id !== session.startedBy) {
        const reminder: Reminder = { sessionId: session.id, asked: asked.name };

        schedule.at(
          `${remind}${session.id}`,
          clock.now() + config.get().answerMinutes * 60_000,
          reminder,
        );
      }
    });

    schedule.on(remind, (payload) => {
      const { sessionId, asked } = payload as Reminder;
      const session = sessions.get(sessionId);

      if (session?.waiting === true) {
        send(session, `Nobody answered Pi's question for ${asked}`, true);
      }
    });

    // Sessions a plugin owns, such as a Project's threads, report to it
    // instead of to a person.
    events.on("SessionStateChanged", ({ session, previous }) => {
      const stopped =
        isBusy(previous) &&
        !isBusy(session.status) &&
        (previous === "running" || session.status !== "idle");

      if (stopped && session.plugin === null) {
        send(session, finishedTitle(session.status), false);
      }
    });
  },
);

function sessionNotice(session: Session, title: string): Notice {
  return {
    title,
    body: session.title ?? "",
    session: session.id,
    url: `/#${session.id}`,
  };
}

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

function vapidKeys(store: Store, secrets: Secrets): VapidKeys {
  const row = store.get<{ private_key: string }>(
    "select private_key from push_vapid",
  );

  const pem =
    row === undefined
      ? createVapidKey(store, secrets)
      : secrets.open("push_vapid", "1", row.private_key);

  const jwk = createPrivateKey(pem).export({ format: "jwk" });

  const point = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(jwk.x ?? "", "base64url"),
    Buffer.from(jwk.y ?? "", "base64url"),
  ]);

  return { publicKey: point.toString("base64url"), privateKey: pem };
}

function createVapidKey(store: Store, secrets: Secrets): string {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pem = privateKey.export({ format: "pem", type: "pkcs8" });

  store.run(
    "insert into push_vapid (id, private_key) values (1, ?)",
    secrets.seal("push_vapid", "1", pem),
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
function vapidToken(audience: string, keys: VapidKeys, now: number): string {
  const encode = (value: object): string =>
    Buffer.from(JSON.stringify(value)).toString("base64url");

  const unsigned = `${encode({ typ: "JWT", alg: "ES256" })}.${encode({
    aud: audience,
    exp: Math.floor(now / 1000) + 12 * 60 * 60,
    sub: contact,
  })}`;

  const signature = sign("sha256", Buffer.from(unsigned), {
    key: keys.privateKey,
    dsaEncoding: "ieee-p1363",
  });

  return `${unsigned}.${signature.toString("base64url")}`;
}

interface Sender extends Pick<
  ServerContext,
  "store" | "clock" | "log" | "network"
> {
  readonly keys: VapidKeys;
}

async function deliver(
  target: Subscription,
  notice: Notice,
  urgent: boolean,
  { store, clock, log, keys, network }: Sender,
): Promise<void> {
  const endpoint = new URL(target.endpoint);

  try {
    const body = await encrypt(
      new TextEncoder().encode(JSON.stringify(notice)),
      Uint8Array.from(Buffer.from(target.p256dh, "base64url")),
      Uint8Array.from(Buffer.from(target.auth, "base64url")),
      await newSender(),
    );

    const response = await network.fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: `vapid t=${vapidToken(endpoint.origin, keys, clock.now())}, k=${keys.publicKey}`,
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

      log("push subscription gone, removed", {
        service: endpoint.hostname,
        status: response.status,
      });

      return;
    }

    if (!response.ok) {
      log("push service refused a notification", {
        service: endpoint.hostname,
        status: response.status,
        body: (await response.text()).slice(0, 200),
      });
    }
  } catch (error) {
    log("could not send a push notification", {
      service: endpoint.hostname,
      error: String(error),
    });
  }
}
