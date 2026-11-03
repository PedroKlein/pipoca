import { createSign } from "node:crypto";
import {
  BadRequest,
  isObject,
  type PluginConfig,
  type PluginStore,
} from "@pipoca/plugins";
import { HostRefused, reach } from "./github";
import type { HostConfig } from "./hosts";

// A bot identity on a git host that an admin registered (ADR 0060).
export type TechnicalUser = AppUser | TokenUser;

interface Common {
  readonly name: string;
  readonly host: string;
}

export interface AppUser extends Common {
  readonly app: {
    readonly id: number;
    readonly slug: string;
    // The App's page on the host, where it is installed.
    readonly url: string;
    readonly privateKey: string;
    readonly webhookSecret: string | undefined;
    // Where the host sends the App's events, under the plugin's hooks.
    readonly hook: string;
  };
}

export interface TokenUser extends Common {
  readonly login: string;
  readonly token: string;
}

export interface TechnicalUsers {
  readonly list: () => readonly TechnicalUser[];
  readonly get: (name: string) => TechnicalUser | undefined;
  readonly add: (user: TechnicalUser) => void;
  readonly remove: (name: string) => boolean;
}

const namePattern = /^[a-z0-9][a-z0-9-]{0,62}$/;

// Technical users live under the plugin's key in pipoca.json, beside the
// hosts, with their secrets sealed (ADR 0039). One that stops fitting is
// logged and left out, and the others still work.
export function technicalUsers(
  config: PluginConfig,
  store: PluginStore,
  log: (message: string, fields?: Readonly<Record<string, unknown>>) => void,
): TechnicalUsers {
  const sealedFor = (name: string): string => `technical-user ${name}`;

  const read = (): readonly unknown[] => {
    const value = config.get();
    const listed = isObject(value) ? value["technicalUsers"] : undefined;

    return Array.isArray(listed) ? listed : [];
  };

  const list = (): readonly TechnicalUser[] =>
    read().flatMap((item, index) => {
      try {
        return [
          userOf(item, (sealed, name) => store.open(sealed, sealedFor(name))),
        ];
      } catch (failure) {
        log("a technical user in the config file doesn't fit", {
          index,
          error: failure instanceof Error ? failure.message : String(failure),
        });

        return [];
      }
    });

  const write = (items: readonly unknown[]): void => {
    const value = config.get();

    config.set({
      ...(isObject(value) ? value : {}),
      technicalUsers: items,
    });
  };

  const nameOf = (item: unknown): unknown =>
    isObject(item) ? item["name"] : undefined;

  return {
    list,
    get: (name) => list().find((user) => user.name === name),
    add: (user) => {
      if (!namePattern.test(user.name)) {
        throw new BadRequest(
          "a technical user's name is lower-case letters, digits and dashes",
        );
      }

      if (read().some((item) => nameOf(item) === user.name)) {
        throw new BadRequest(`there is a technical user ${user.name} already`);
      }

      const seal = (secret: string): string =>
        store.seal(secret, sealedFor(user.name));

      write([
        ...read(),
        "app" in user
          ? {
              name: user.name,
              host: user.host,
              app: {
                id: user.app.id,
                slug: user.app.slug,
                url: user.app.url,
                privateKey: seal(user.app.privateKey),
                ...(user.app.webhookSecret !== undefined && {
                  webhookSecret: seal(user.app.webhookSecret),
                }),
                hook: user.app.hook,
              },
            }
          : {
              name: user.name,
              host: user.host,
              login: user.login,
              token: seal(user.token),
            },
      ]);
    },
    remove: (name) => {
      const before = read();
      const after = before.filter((item) => nameOf(item) !== name);

      if (after.length === before.length) {
        return false;
      }

      write(after);

      return true;
    },
  };
}

function userOf(
  item: unknown,
  open: (sealed: string, name: string) => string,
): TechnicalUser {
  if (!isObject(item)) {
    throw new BadRequest("must be an object");
  }

  const name = text(item["name"], "name");
  const host = text(item["host"], "host");
  const { app } = item;

  if (app === undefined) {
    return {
      name,
      host,
      login: text(item["login"], "login"),
      token: open(text(item["token"], "token"), name),
    };
  }

  if (!isObject(app) || typeof app["id"] !== "number") {
    throw new BadRequest("app must hold the App's id");
  }

  const secret = app["webhookSecret"];

  return {
    name,
    host,
    app: {
      id: app["id"],
      slug: text(app["slug"], "app.slug"),
      url: text(app["url"], "app.url"),
      privateKey: open(text(app["privateKey"], "app.privateKey"), name),
      webhookSecret:
        secret === undefined
          ? undefined
          : open(text(secret, "app.webhookSecret"), name),
      hook: text(app["hook"], "app.hook"),
    },
  };
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value === "") {
    throw new BadRequest(`${field} must be text`);
  }

  return value;
}

// What a GitHub App manifest asks for: enough to clone, push, open and
// review pull requests, and to hear about them (ADR 0060).
export function appManifest(
  name: string,
  origin: string,
  hook: string | undefined,
): Readonly<Record<string, unknown>> {
  return {
    name,
    url: origin,
    redirect_url: `${origin}/api/plugins/git-hosts/app-created`,
    public: false,
    default_permissions: {
      contents: "write",
      pull_requests: "write",
      issues: "write",
      checks: "read",
      statuses: "read",
      actions: "read",
      metadata: "read",
    },
    ...(hook !== undefined && {
      hook_attributes: {
        url: `${origin}/api/plugins/git-hosts/hooks/${hook}`,
        active: true,
      },
      default_events: [
        "check_run",
        "issue_comment",
        "issues",
        "pull_request",
        "pull_request_review",
        "pull_request_review_comment",
        "push",
      ],
    }),
  };
}

export interface CreatedApp {
  readonly id: number;
  readonly slug: string;
  readonly url: string;
  readonly privateKey: string;
  readonly webhookSecret: string | undefined;
}

// Trades the code GitHub sends back from the manifest flow for the App's
// credentials. The code works once, within an hour.
export async function convertManifest(
  host: HostConfig,
  code: string,
): Promise<CreatedApp> {
  const response = await reach(
    host,
    `${host.api}/app-manifests/${encodeURIComponent(code)}/conversions`,
    {
      method: "POST",
      headers: { accept: "application/vnd.github+json" },
    },
  );

  const answer = (await response.json().catch(() => ({}))) as {
    id?: unknown;
    slug?: unknown;
    html_url?: unknown;
    pem?: unknown;
    webhook_secret?: unknown;
  };

  if (
    !response.ok ||
    typeof answer.id !== "number" ||
    typeof answer.slug !== "string" ||
    typeof answer.html_url !== "string" ||
    typeof answer.pem !== "string"
  ) {
    throw new HostRefused(
      `${host.host} answered ${String(response.status)} when asked for the new App's credentials`,
    );
  }

  return {
    id: answer.id,
    slug: answer.slug,
    url: answer.html_url,
    privateKey: answer.pem,
    webhookSecret:
      typeof answer.webhook_secret === "string" && answer.webhook_secret !== ""
        ? answer.webhook_secret
        : undefined,
  };
}

// The accounts an App is installed on, which it can act in.
export async function installationsOf(
  host: HostConfig,
  app: AppUser["app"],
): Promise<readonly { readonly id: number; readonly account: string }[]> {
  const response = await reach(host, `${host.api}/app/installations`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${appJwt(app.id, app.privateKey)}`,
    },
  });

  if (!response.ok) {
    throw new HostRefused(
      `${host.host} answered ${String(response.status)} when asked where the App is installed`,
    );
  }

  const listed: unknown = await response.json();

  return (Array.isArray(listed) ? listed : []).flatMap((item: unknown) => {
    const { id, account } = (item ?? {}) as {
      id?: unknown;
      account?: { login?: unknown } | null;
    };

    return typeof id === "number" && typeof account?.login === "string"
      ? [{ id, account: account.login }]
      : [];
  });
}

// The App signs in as itself with a short JWT, which GitHub takes for ten
// minutes at most. It starts a minute back for clocks that drift.
function appJwt(id: number, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);

  const part = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString("base64url");

  const unsigned = `${part({ alg: "RS256", typ: "JWT" })}.${part({ iat: now - 60, exp: now + 540, iss: String(id) })}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(privateKey);

  return `${unsigned}.${signature.toString("base64url")}`;
}
