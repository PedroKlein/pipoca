import { createHash, randomBytes } from "node:crypto";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { Store } from "@pipoca/plugins";
import type { Clock } from "@pipoca/protocol";

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
interface ProxyTokens {
  readonly issue: (sessionId: string) => string;
  readonly sessionOf: (token: string) => string | undefined;
}

export function proxyTokens(store: Store, clock: Clock): ProxyTokens {
  return {
    issue: (sessionId) => {
      const token = `ppx_${randomBytes(24).toString("base64url")}`;

      store.run(
        "insert into logins_proxy_tokens (token_hash, session_id, created_at) values (?, ?, ?)",
        hash(token),
        sessionId,
        clock.now(),
      );

      return token;
    },
    sessionOf: (token) =>
      store.get<{ session_id: string }>(
        "select session_id from logins_proxy_tokens where token_hash = ?",
        hash(token),
      )?.session_id,
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

// What one model call used, as the provider's answer reports it.
interface CallUsage {
  readonly model: string | null;
  readonly input: number;
  readonly output: number;
}

// Sends the request on with the real key and streams the answer back as it
// comes, reading the tokens it reports on the way (ADR 0066).
export async function forward(
  request: Request,
  upstream: Upstream,
  rest: string,
  key: string,
  onUsage: (usage: CallUsage) => void,
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

  const body = request.body === null ? null : await request.text();

  const answer = await fetch(url, {
    method: request.method,
    headers,
    ...(body !== null && { body }),
    signal: request.signal,
  });

  // fetch has already undone the encoding, so the length and encoding it
  // came with no longer fit the body.
  const back = new Headers(answer.headers);
  back.delete("content-encoding");
  back.delete("content-length");

  const [counted, passed] = answer.body?.tee() ?? [null, null];

  if (counted !== null && answer.ok) {
    void tokensIn(counted).then((tokens) => {
      if (tokens !== undefined) {
        onUsage({ model: modelOf(body, rest), ...tokens });
      }
    });
  }

  return new Response(passed, {
    status: answer.status,
    statusText: answer.statusText,
    headers: back,
  });
}

// The model a call names: in its JSON body, or in Google's path.
function modelOf(body: string | null, rest: string): string | null {
  const named = /(?:^|\/)models\/([^/:]+)/.exec(rest)?.[1];
  if (named !== undefined) {
    return named;
  }

  try {
    const parsed = JSON.parse(body ?? "") as { model?: unknown };

    return typeof parsed.model === "string" ? parsed.model : null;
  } catch {
    return null;
  }
}

interface Tokens {
  readonly input: number;
  readonly output: number;
}

// Reads an answer to its end, or to where it was cut off, such as when the
// person stops the turn: a stream of server-sent events or one JSON body.
// The last report of each count wins, since streams send running totals.
async function tokensIn(
  stream: ReadableStream<Uint8Array>,
): Promise<Tokens | undefined> {
  const text = await textUntilCut(stream);

  const objects = text.trimStart().startsWith("{")
    ? [text]
    : text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trim());

  let found: Partial<Tokens> = {};

  for (const each of objects) {
    try {
      found = { ...found, ...reported(JSON.parse(each)) };
    } catch {
      continue;
    }
  }

  return found.input === undefined && found.output === undefined
    ? undefined
    : { input: found.input ?? 0, output: found.output ?? 0 };
}

async function textUntilCut(
  stream: ReadableStream<Uint8Array>,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";

  try {
    for await (const chunk of stream) {
      text += decoder.decode(chunk, { stream: true });
    }
  } catch {
    return text;
  }

  return text + decoder.decode();
}

const count = (value: unknown): number =>
  typeof value === "number" ? value : 0;

const objectAt = (value: unknown, key: string): Record<string, unknown> => {
  const inner =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)[key]
      : undefined;

  return typeof inner === "object" && inner !== null
    ? (inner as Record<string, unknown>)
    : {};
};

// Where each API reports tokens: Anthropic in message_start and
// message_delta, OpenAI Responses in response.completed, OpenAI chat in a
// usage chunk, and Google in usageMetadata.
function reported(event: unknown): Partial<Tokens> {
  const usage = {
    ...objectAt(objectAt(event, "message"), "usage"),
    ...objectAt(objectAt(event, "response"), "usage"),
    ...objectAt(event, "usage"),
  };

  const google = objectAt(event, "usageMetadata");

  if ("promptTokenCount" in google) {
    return {
      input: count(google["promptTokenCount"]),
      output:
        count(google["candidatesTokenCount"]) +
        count(google["thoughtsTokenCount"]),
    };
  }

  return {
    ...("input_tokens" in usage && {
      input:
        count(usage["input_tokens"]) +
        count(usage["cache_creation_input_tokens"]) +
        count(usage["cache_read_input_tokens"]),
    }),
    ...("prompt_tokens" in usage && { input: count(usage["prompt_tokens"]) }),
    ...("output_tokens" in usage && { output: count(usage["output_tokens"]) }),
    ...("completion_tokens" in usage && {
      output: count(usage["completion_tokens"]),
    }),
  };
}
