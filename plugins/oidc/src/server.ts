import {
  defineServer,
  NotFound,
  type Person,
  type Store,
  Type,
} from "@pipoca/plugins";
import type { Clock } from "@pipoca/protocol";
import { oidc } from "../plugin";
import type {
  Account,
  LinkedIdentity,
  ProviderTest,
  ProviderView,
} from "./model";
import {
  type Attempt,
  type Client,
  authorizationUrl,
  discover,
  type Identity,
  LoginFailed,
  newAttempt,
  type Provider,
  redeem,
} from "./oidc";
import {
  type ProviderConfig,
  providerChange,
  providers as providerList,
  viewOf,
} from "./providers";

// A browser has this long to come back from the provider.
const attemptMs = 10 * 60_000;
const weekMs = 7 * 24 * 60 * 60_000;

interface Pending extends Attempt {
  readonly providerId: string;
  readonly browser: string;
  // Set when a signed-in person links their identity.
  readonly linkTo: string | undefined;
  // The invite link the person followed to get here (ADR 0063).
  readonly join: string | undefined;
  readonly expires: number;
}

const startQuery = Type.Object({ join: Type.Optional(Type.String()) });

const callbackQuery = Type.Object({
  state: Type.Optional(Type.String()),
  code: Type.Optional(Type.String()),
  error: Type.Optional(Type.String()),
  error_description: Type.Optional(Type.String()),
});

export const server = defineServer(oidc, (context) => {
  const { routes, urls, clock, log } = context;
  const identities = identityStore(context.store, clock);
  const providers = providerList(context.config.collection("providers"));
  const pending = new Map<string, Pending>();
  const discovered = new Map<string, Promise<Provider>>();
  const callback = (): string => urls.public("callback");

  const people = context.provide.signIn({
    logins: () =>
      providers.list().map(({ id, label }) => ({ label, path: `start/${id}` })),
  });

  const discovery = async (issuer: string): Promise<Provider> => {
    const found = discovered.get(issuer) ?? discover(issuer);
    discovered.set(issuer, found);

    // A failed discovery is tried again on the next sign-in.
    return found.catch((error: unknown) => {
      discovered.delete(issuer);
      throw error;
    });
  };

  const client = (config: ProviderConfig): Client => ({
    id: config.clientId,
    secret: config.clientSecret,
  });

  const start = async (
    providerId: string,
    linkTo: string | undefined,
    join: string | undefined,
  ): Promise<Response> => {
    const config = providers.get(providerId);

    if (config === undefined) {
      return page("This server has no such sign-in.", 404);
    }

    const now = clock.now();

    for (const [state, each] of pending) {
      if (each.expires < now) {
        pending.delete(state);
      }
    }

    const attempt = newAttempt();

    let location: string;

    try {
      location = authorizationUrl(
        await discovery(config.issuer),
        client(config),
        callback(),
        attempt,
      );
    } catch (failure) {
      if (!(failure instanceof LoginFailed)) {
        throw failure;
      }

      log("discovery failed", { provider: config.id, error: failure.message });

      return page(`Sign-in failed: ${failure.message}`, 502);
    }

    const response = new Response(null, { status: 302, headers: { location } });

    pending.set(attempt.state, {
      ...attempt,
      providerId,
      browser: urls.browser.mark(response, attemptMs),
      linkTo,
      join,
      expires: now + attemptMs,
    });

    return response;
  };

  const signIn = (
    request: Request,
    config: ProviderConfig,
    identity: Identity,
    { linkTo, join }: Pick<Pending, "linkTo" | "join">,
  ): Response => {
    const fields = {
      provider: config.id,
      subject: identity.subject,
      email: identity.email,
    };

    const { allowed, admin } = access(config, identity);
    const linked = identities.find(identity);

    // An invite lets a new person in past the rules, and keeps them in.
    const invite =
      linked === undefined && linkTo === undefined
        ? people.invited(
            join,
            identity.emailVerified ? (identity.email ?? undefined) : undefined,
          )
        : undefined;

    if (!allowed && invite === undefined && linked?.invited !== true) {
      log("sign-in refused: not let in", fields);

      return page(
        "This server doesn't let your account in. Ask its admin to add you.",
        403,
      );
    }

    if (linkTo !== undefined) {
      if (linked !== undefined && linked.userId !== linkTo) {
        return page("This account already signs in as another user.", 409);
      }

      identities.link(identity, linkTo, false, false);
      log("identity linked", { ...fields, userId: linkTo });
      routes.topic("account");

      return redirect("/#settings/accounts", undefined);
    }

    let made: Person | undefined;

    if (linked === undefined) {
      const asAdmin = admin || invite?.admin === true;
      const name = identity.email ?? identity.subject;

      made = people.create(name, asAdmin);

      if (made === undefined) {
        return page(
          `A user named ${name} already exists. Sign in with its password and link this account in Settings.`,
          409,
        );
      }

      identities.link(identity, made.id, true, invite !== undefined);

      if (invite !== undefined) {
        people.acceptInvite(invite.id);
      }

      log("user created", {
        ...fields,
        userId: made.id,
        admin: asAdmin,
        invited: invite !== undefined,
      });
    } else if (
      linked.created &&
      !linked.invited &&
      (config.adminGroup !== "" || config.adminEmails.length > 0)
    ) {
      // Groups are read again on every sign-in, so a change in the provider
      // applies the next time. A provider that names no admins, or someone
      // an invite let in, leaves roles to People.
      people.setAdmin(linked.userId, admin);
    }

    const userId = made?.id ?? linked?.userId ?? "";
    const cookie = people.startSession(userId, request);

    if (cookie === undefined) {
      return page("This account's user no longer exists.", 403);
    }

    identities.signedIn(identity);
    log("signed in", { ...fields, userId });

    return redirect("/", cookie);
  };

  routes.get(
    "start/:id",
    { auth: "public", query: startQuery },
    async ({ params, query }) => start(params.id, undefined, query.join),
  );

  routes.get(
    "callback",
    { auth: "public", query: callbackQuery },
    async ({ query, raw }) => {
      const attempt = pending.get(query.state ?? "");
      const config = attempt && providers.get(attempt.providerId);

      // The state must come back to the browser that left with it, so a
      // link can't sign someone in as another person (RFC 6749, 10.12).
      if (
        attempt === undefined ||
        config === undefined ||
        attempt.expires < clock.now() ||
        !urls.browser.is(raw, attempt.browser)
      ) {
        return page("This sign-in has expired. Start it again.", 400);
      }

      pending.delete(attempt.state);

      if (query.error !== undefined) {
        log("sign-in refused by the provider", {
          provider: config.id,
          error: query.error,
        });

        return page(
          `The identity provider refused the sign-in: ${query.error_description ?? query.error}`,
          403,
        );
      }

      try {
        const identity = await redeem(
          await discovery(config.issuer),
          client(config),
          callback(),
          attempt,
          query.code ?? "",
          clock.now(),
        );

        return signIn(raw, config, identity, attempt);
      } catch (failure) {
        if (!(failure instanceof LoginFailed)) {
          throw failure;
        }

        log("sign-in failed", { provider: config.id, error: failure.message });

        return page(`Sign-in failed: ${failure.message}`, 502);
      }
    },
  );

  routes.get("link/:id", { auth: "person" }, async ({ caller, params }) =>
    start(params.id, caller.person.id, undefined),
  );

  const account = (person: Person): Account => ({
    admin: person.admin,
    passwordLogin: people.passwordLogin(),
    lockedIn: context.config.lockedIn() ?? null,
    providers: providers
      .list()
      .map(({ id, label, issuer }) => ({ id, label, issuer })),
    identities: identities.of(person.id),
  });

  routes.get("account", { auth: "person" }, ({ caller }) =>
    account(caller.person),
  );

  routes.delete(
    "identities/:issuer",
    { auth: "person", changes: ["account"] },
    ({ caller, params }) => {
      identities.unlink(caller.person.id, params.issuer);

      log("identity unlinked", {
        userId: caller.person.id,
        issuer: params.issuer,
      });

      return account(caller.person);
    },
  );

  // Admins add, change and remove providers.
  const view = (config: ProviderConfig): ProviderView =>
    viewOf(
      config,
      identities.signedInSince(config.issuer, clock.now() - weekMs),
    );

  routes.get("providers", { auth: "admin" }, () => providers.list().map(view));

  routes.post(
    "providers",
    {
      auth: "admin",
      body: providerChange,
      status: 201,
      changes: ["providers", "account"],
    },
    ({ body }) => {
      const created = providers.create(body);
      log("provider added", { provider: created.id });

      return view(created);
    },
  );

  routes.post(
    "providers/:id",
    { auth: "admin", body: providerChange, changes: ["providers", "account"] },
    ({ params, body }) => view(providers.update(params.id, body)),
  );

  routes.delete(
    "providers/:id",
    { auth: "admin", changes: ["providers", "account"] },
    ({ params }) => {
      providers.remove(params.id);
      log("provider removed", { provider: params.id });

      return { removed: params.id };
    },
  );

  routes.post("providers/:id/test", { auth: "admin" }, async ({ params }) => {
    const config = providers.get(params.id);

    if (config === undefined) {
      throw new NotFound(`no provider ${params.id}`);
    }

    const test = await discover(config.issuer).then(
      (): ProviderTest => ({ ok: true, error: null }),
      (failure: unknown): ProviderTest => {
        if (!(failure instanceof LoginFailed)) {
          throw failure;
        }

        return { ok: false, error: failure.message };
      },
    );

    log("provider tested", { provider: config.id, ok: test.ok });

    return test;
  });
});

// The groups come from the claim the provider puts them in. Emails count
// only once the provider has verified them.
function access(
  config: ProviderConfig,
  identity: Identity,
): { readonly allowed: boolean; readonly admin: boolean } {
  const claim = identity.claims[config.groupsClaim];

  const groups = (Array.isArray(claim) ? claim : [claim]).filter(
    (group): group is string => typeof group === "string" && group !== "",
  );

  const email = identity.emailVerified
    ? (identity.email?.toLowerCase() ?? "")
    : "";

  const domain = email.slice(email.lastIndexOf("@") + 1);

  const admin =
    groups.includes(config.adminGroup) ||
    (email !== "" && config.adminEmails.includes(email));

  return {
    admin,
    allowed:
      admin ||
      groups.includes(config.accessGroup) ||
      (email !== "" &&
        (config.allowedEmails.includes(email) ||
          config.allowedDomains.includes(domain))),
  };
}

// A page that moves on by itself instead of a 302: the browser came here
// from the provider's site, and would leave the new Strict cookie off a
// redirect it follows straight away.
function redirect(to: string, cookie: string | undefined): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${to}"><title>Pipoca</title><a href="${to}">Continue</a>`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        ...(cookie !== undefined && { "set-cookie": cookie }),
      },
    },
  );
}

function page(message: string, status: number): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Pipoca</title><p>${escaped(message)}</p><p><a href="/">Back to Pipoca</a></p>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );
}

function escaped(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (character) => `&#${String(character.charCodeAt(0))};`,
  );
}

interface IdentityStore {
  readonly find: (identity: Identity) =>
    | {
        readonly userId: string;
        readonly created: boolean;
        readonly invited: boolean;
      }
    | undefined;
  // created is true when the plugin made the user, so its groups decide
  // whether it is an admin. invited is true when an invite let them in.
  readonly link: (
    identity: Identity,
    userId: string,
    created: boolean,
    invited: boolean,
  ) => void;
  readonly of: (userId: string) => readonly LinkedIdentity[];
  readonly signedIn: (identity: Identity) => void;
  // How many people signed in with the issuer since the time.
  readonly signedInSince: (issuer: string, since: number) => number;
  readonly unlink: (userId: string, issuer: string) => void;
}

function identityStore(store: Store, clock: Clock): IdentityStore {
  return {
    find: ({ issuer, subject }) => {
      const row = store.get<{
        user_id: string;
        created: number;
        invited: number;
      }>(
        "select user_id, created, invited from oidc_identities where issuer = ? and subject = ?",
        issuer,
        subject,
      );

      return (
        row && {
          userId: row.user_id,
          created: row.created === 1,
          invited: row.invited === 1,
        }
      );
    },
    link: ({ issuer, subject, email }, userId, created, invited) => {
      store.run(
        "insert into oidc_identities (issuer, subject, user_id, email, created, linked_at, invited) values (?, ?, ?, ?, ?, ?, ?) on conflict (issuer, subject) do update set email = excluded.email",
        issuer,
        subject,
        userId,
        email,
        created ? 1 : 0,
        clock.now(),
        invited ? 1 : 0,
      );
    },
    of: (userId) =>
      store
        .all<{
          issuer: string;
          email: string | null;
          linked_at: number;
          created: number;
        }>(
          "select issuer, email, linked_at, created from oidc_identities where user_id = ? order by linked_at",
          userId,
        )
        .map((row) => ({
          issuer: row.issuer,
          email: row.email,
          linkedAt: new Date(row.linked_at).toISOString(),
          created: row.created === 1,
        })),
    signedIn: ({ issuer, subject }) => {
      store.run(
        "update oidc_identities set signed_in_at = ? where issuer = ? and subject = ?",
        clock.now(),
        issuer,
        subject,
      );
    },
    signedInSince: (issuer, since) =>
      store.get<{ people: number }>(
        "select count(distinct user_id) as people from oidc_identities where issuer = ? and signed_in_at >= ?",
        issuer,
        since,
      )?.people ?? 0,
    unlink: (userId, issuer) => {
      store.run(
        "delete from oidc_identities where user_id = ? and issuer = ? and created = 0",
        userId,
        issuer,
      );
    },
  };
}
