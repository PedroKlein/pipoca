import { createHash, randomBytes } from "node:crypto";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { PluginStore } from "@pipoca/plugins";

// Where a provider's requests go, and how its key travels: the proxy
// translates nothing, it only swaps the key (ADR 0066).
export interface Upstream {
  readonly baseUrl: string;
  readonly header: KeyHeader;
}

type KeyHeader = "x-api-key" | "authorization" | "x-goog-api-key";

// How each of Pi's APIs sends its key. Adding a provider's API is one row.
const keyHeaders: Readonly<Record<string, KeyHeader>> = {
  "anthropic-messages": "x-api-key",
  "openai-responses": "authorization",
  "openai-completions": "authorization",
  "google-generative-ai": "x-goog-api-key",
};

// Pi's providers whose models all go to one address in one way, which a
// Session can point at the proxy as a whole.
export function upstreams(
  models: readonly Model<Api>[],
): ReadonlyMap<string, Upstream> {
  const byProvider = new Map<string, Upstream | null>();

  for (const { provider, api, baseUrl } of models) {
    const header = keyHeaders[api];
    const seen = byProvider.get(provider);

    byProvider.set(
      provider,
      header === undefined ||
        seen === null ||
        (seen !== undefined &&
          (seen.baseUrl !== baseUrl || seen.header !== header))
        ? null
        : { baseUrl, header },
    );
  }

  return new Map(
    [...byProvider].flatMap(([provider, upstream]) =>
      upstream === null ? [] : [[provider, upstream]],
    ),
  );
}

// Tokens that stand in for a key in one team Session, kept as hashes.
export interface ProxyTokens {
  readonly issue: (sessionId: string) => string;
  readonly sessionOf: (token: string) => string | undefined;
}

export function proxyTokens(store: PluginStore): ProxyTokens {
  store.exec(
    "create table if not exists logins_proxy_tokens (token_hash text primary key, session_id text not null, created_at text not null)",
  );

  return {
    issue: (sessionId) => {
      const token = `ppx_${randomBytes(24).toString("base64url")}`;

      store.run(
        "insert into logins_proxy_tokens (token_hash, session_id, created_at) values (?, ?, ?)",
        hash(token),
        sessionId,
        new Date().toISOString(),
      );

      return token;
    },
    sessionOf: (token) => {
      const [row] = store.all(
        "select session_id from logins_proxy_tokens where token_hash = ?",
        hash(token),
      ) as { session_id: string }[];

      return row?.session_id;
    },
  };
}

function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// The token where the provider's client put its key.
export function tokenOf(
  request: Request,
  header: KeyHeader,
): string | undefined {
  const value = request.headers.get(header);

  if (value === null) {
    return undefined;
  }

  return header === "authorization" ? /^Bearer (.+)$/i.exec(value)?.[1] : value;
}

// Headers the server's own hop sets, or that carry the Session's token.
const dropped = new Set([
  "host",
  "cookie",
  "connection",
  "content-length",
  "x-api-key",
  "authorization",
  "x-goog-api-key",
]);

// Sends the request on with the real key and streams the answer back as it
// comes.
export async function forward(
  request: Request,
  upstream: Upstream,
  rest: string,
  key: string,
): Promise<Response> {
  const url = new URL(
    `${upstream.baseUrl.replace(/\/$/, "")}/${rest}${new URL(request.url).search}`,
  );

  const headers = new Headers();

  for (const [name, value] of request.headers) {
    if (!dropped.has(name.toLowerCase())) {
      headers.set(name, value);
    }
  }

  headers.set(
    upstream.header,
    upstream.header === "authorization" ? `Bearer ${key}` : key,
  );

  const answer = await fetch(url, {
    method: request.method,
    headers,
    ...(request.body !== null && { body: request.body, duplex: "half" }),
    signal: request.signal,
  });

  // fetch has already undone the encoding, so the length and encoding it
  // came with no longer fit the body.
  const back = new Headers(answer.headers);
  back.delete("content-encoding");
  back.delete("content-length");

  return new Response(answer.body, {
    status: answer.status,
    statusText: answer.statusText,
    headers: back,
  });
}
