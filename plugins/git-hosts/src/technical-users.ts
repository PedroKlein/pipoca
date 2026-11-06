import { createSign } from "node:crypto";
import type { Urls } from "@pipoca/plugins";
import type { TechnicalUserItem } from "../plugin";
import { HostRefused, reach } from "./github";
import type { HostConfig } from "./hosts";

// A bot identity on a git host that an admin registered (ADR 0060).
export type TechnicalUser = TechnicalUserItem;

export type AppUser = TechnicalUser & {
  readonly app: NonNullable<TechnicalUser["app"]>;
};

export function isApp(user: TechnicalUser): user is AppUser {
  return user.app !== undefined;
}

// Who its commits and comments show as.
export function botLogin(user: TechnicalUser): string {
  return user.app === undefined ? (user.login ?? "") : `${user.app.slug}[bot]`;
}

// What a GitHub App manifest asks for: enough to clone, push, open and
// review pull requests, and to hear about them (ADR 0060).
export function appManifest(
  name: string,
  urls: Urls,
  hook: string | undefined,
): Readonly<Record<string, unknown>> {
  return {
    name,
    url: new URL(urls.public("")).origin,
    redirect_url: urls.public("app-created"),
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
        url: urls.public(`hooks/${hook}`),
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
  now: number,
): Promise<readonly { readonly id: number; readonly account: string }[]> {
  const response = await reach(host, `${host.api}/app/installations`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${appJwt(app.id, app.privateKey, now)}`,
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
function appJwt(id: number, privateKey: string, at: number): string {
  const now = Math.floor(at / 1000);

  const part = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString("base64url");

  const unsigned = `${part({ alg: "RS256", typ: "JWT" })}.${part({ iat: now - 60, exp: now + 540, iss: String(id) })}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(privateKey);

  return `${unsigned}.${signature.toString("base64url")}`;
}

// A token for one installation of the App, which GitHub lets live an hour.
export async function installationToken(
  host: HostConfig,
  app: AppUser["app"],
  installation: number,
  now: number,
): Promise<{ readonly token: string; readonly expiresAt: number }> {
  const response = await reach(
    host,
    `${host.api}/app/installations/${String(installation)}/access_tokens`,
    {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${appJwt(app.id, app.privateKey, now)}`,
      },
    },
  );

  const answer = (await response.json().catch(() => ({}))) as {
    token?: unknown;
    expires_at?: unknown;
  };

  if (
    !response.ok ||
    typeof answer.token !== "string" ||
    typeof answer.expires_at !== "string"
  ) {
    throw new HostRefused(
      `${host.host} answered ${String(response.status)} when asked for an installation token`,
    );
  }

  return { token: answer.token, expiresAt: Date.parse(answer.expires_at) };
}
