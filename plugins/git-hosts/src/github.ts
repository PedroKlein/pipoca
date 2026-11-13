import { isHttpError, type Network, type OnBehalf } from "@pipoca/plugins";
import type { HostConfig, OAuthApp } from "./hosts";
import type { HostEmails } from "./model";

// What a host answered, in words for the person connecting.
export class HostRefused extends Error {}

const timeoutMs = 15_000;

// A host as one owner's calls reach it, through an Environment of theirs
// when it is private (ADR 0080).
export interface HostCall extends HostConfig {
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
}

export function hostCall(
  host: HostConfig,
  network: Network,
  on: OnBehalf,
): HostCall {
  return {
    ...host,
    fetch: async (url, init) => network.fetch(url, init, on),
  };
}

// The account a token signs in as, which also proves the token works.
export async function loginOf(host: HostCall, token: string): Promise<string> {
  const response = await reach(host, `${host.api}/user`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
    },
  });

  if (response.status === 401) {
    throw new HostRefused(`${host.host} doesn't accept this token`);
  }

  if (!response.ok) {
    throw new HostRefused(
      `${host.host} answered ${String(response.status)} when asked who the token belongs to`,
    );
  }

  const { login } = (await response.json()) as { login?: unknown };

  if (typeof login !== "string") {
    throw new HostRefused(`${host.host} didn't say who the token belongs to`);
  }

  return login;
}

// The account's verified emails, the primary first, to commit as. A token
// without the user:email scope can't list them, and then the account's
// public email is all there is.
export async function emailsOf(
  host: HostCall,
  token: string,
): Promise<HostEmails> {
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
  };

  const [user, listed] = await Promise.all([
    reach(host, `${host.api}/user`, { headers }),
    reach(host, `${host.api}/user/emails?per_page=100`, { headers }),
  ]);

  if (!user.ok) {
    throw new HostRefused(
      `${host.host} answered ${String(user.status)} when asked who the token belongs to`,
    );
  }

  const { name, email } = (await user.json().catch(() => ({}))) as {
    name?: unknown;
    email?: unknown;
  };

  const list: unknown = listed.ok ? await listed.json().catch(() => []) : [];

  const found = (Array.isArray(list) ? list : []).flatMap((item: unknown) => {
    const each = (item ?? {}) as {
      email?: unknown;
      verified?: unknown;
      primary?: unknown;
    };

    return typeof each.email === "string" && each.verified === true
      ? [{ email: each.email, primary: each.primary === true }]
      : [];
  });

  const emails = [
    ...found.filter(({ primary }) => primary),
    ...found.filter(({ primary }) => !primary),
  ].map(({ email: each }) => each);

  return {
    name: typeof name === "string" && name.trim() !== "" ? name.trim() : null,
    emails:
      emails.length === 0 && typeof email === "string" && email !== ""
        ? [email]
        : emails,
  };
}

// GitHub's web flow for OAuth apps. repo covers private repositories and
// pushes, read:org the organizations' repositories, and user:email the
// emails to commit as.
export function authorizationUrl(
  host: HostConfig,
  oauth: OAuthApp,
  redirectUri: string,
  state: string,
): string {
  const params = new URLSearchParams({
    client_id: oauth.clientId,
    redirect_uri: redirectUri,
    scope: "repo read:org user:email",
    state,
  });

  return `https://${host.host}/login/oauth/authorize?${params.toString()}`;
}

export async function redeem(
  host: HostCall,
  oauth: OAuthApp,
  redirectUri: string,
  code: string,
): Promise<string> {
  const response = await reach(
    host,
    `https://${host.host}/login/oauth/access_token`,
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        client_id: oauth.clientId,
        client_secret: oauth.clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
    },
  );

  const answer = (await response.json().catch(() => ({}))) as {
    access_token?: unknown;
    error_description?: unknown;
    error?: unknown;
  };

  if (typeof answer.access_token !== "string") {
    const reason = answer.error_description ?? answer.error;

    throw new HostRefused(
      typeof reason === "string"
        ? `${host.host} refused the sign-in: ${reason}`
        : `${host.host} answered ${String(response.status)} to the sign-in`,
    );
  }

  return answer.access_token;
}

export interface Repository {
  // What git clones.
  readonly url: string;
  // owner/name
  readonly name: string;
  readonly pushedAt?: string;
  readonly language?: string;
}

// The repositories the token's account pushed to last, those of them whose
// name holds the query, and with a query, the matching ones anywhere on the
// host it can see.
export async function repositoriesOf(
  host: HostCall,
  token: string,
  query: string,
): Promise<readonly Repository[]> {
  const get = async (path: string): Promise<unknown> => {
    const response = await reach(host, `${host.api}${path}`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      throw new HostRefused(
        `${host.host} answered ${String(response.status)} to ${path}`,
      );
    }

    return response.json();
  };

  const needle = query.toLowerCase();

  const [mine, searched] = await Promise.all([
    get("/user/repos?sort=pushed&per_page=100"),
    query.length < 2
      ? { items: [] }
      : get(
          `/search/repositories?per_page=30&q=${encodeURIComponent(`${query} in:name`)}`,
        ),
  ]);

  const found = [
    ...repositoriesIn(mine).filter(({ name }) =>
      name.toLowerCase().includes(needle),
    ),
    ...repositoriesIn((searched as { items?: unknown }).items),
  ];

  return found.filter(
    (repository, index) =>
      found.findIndex(({ url }) => url === repository.url) === index,
  );
}

// The repositories a GitHub App's installation reaches, for what was typed.
export async function installationRepositoriesOf(
  host: HostCall,
  token: string,
  query: string,
): Promise<readonly Repository[]> {
  const path = "/installation/repositories?per_page=100";

  const response = await reach(host, `${host.api}${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    throw new HostRefused(
      `${host.host} answered ${String(response.status)} to ${path}`,
    );
  }

  const { repositories } = (await response.json()) as {
    repositories?: unknown;
  };

  const needle = query.toLowerCase();

  return repositoriesIn(repositories).filter(({ name }) =>
    name.toLowerCase().includes(needle),
  );
}

function repositoriesIn(list: unknown): readonly Repository[] {
  return (Array.isArray(list) ? list : []).flatMap((item: unknown) => {
    const {
      clone_url: url,
      full_name: name,
      pushed_at: pushedAt,
      language,
    } = (item ?? {}) as {
      clone_url?: unknown;
      full_name?: unknown;
      pushed_at?: unknown;
      language?: unknown;
    };

    return typeof url === "string" && typeof name === "string"
      ? [
          {
            url,
            name,
            ...(typeof pushedAt === "string" && { pushedAt }),
            ...(typeof language === "string" && { language }),
          },
        ]
      : [];
  });
}

export async function reach(
  host: HostCall,
  url: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await host.fetch(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (failure) {
    if (isHttpError(failure)) {
      throw failure;
    }

    throw new HostRefused(
      `couldn't reach ${host.host}: ${failure instanceof Error ? failure.message : String(failure)}`,
    );
  }
}
