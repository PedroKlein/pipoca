import type { Static, TSchema } from "typebox";
import type { ParamsOf, RouteSpec } from "./route";
import { type RouteKey, type Routes, routes } from "./routes";
import type { Wire } from "./wire";

type Bytes = NonNullable<RequestInit["body"]>;

// Whether every field of T may be left out.
type AllOptional<T> = Partial<T> extends T ? true : false;

type ParamsInput<Spec extends RouteSpec> = keyof ParamsOf<
  Spec["path"]
> extends never
  ? { readonly params?: undefined }
  : { readonly params: ParamsOf<Spec["path"]> };

type QueryInput<Spec extends RouteSpec> = Spec["query"] extends TSchema
  ? AllOptional<Static<Spec["query"]>> extends true
    ? { readonly query?: Wire<Spec["query"]> }
    : { readonly query: Wire<Spec["query"]> }
  : { readonly query?: undefined };

type BodyInput<Spec extends RouteSpec> = Spec["body"] extends "bytes"
  ? { readonly body: Bytes }
  : Spec["body"] extends TSchema
    ? AllOptional<Static<Spec["body"]>> extends true
      ? { readonly body?: Wire<Spec["body"]> }
      : { readonly body: Wire<Spec["body"]> }
    : { readonly body?: undefined };

// What calling a route takes: the parameters its path names, its query and
// its body, as its schemas type them.
export type ApiInput<Key extends RouteKey> = ParamsInput<Routes[Key]> &
  QueryInput<Routes[Key]> &
  BodyInput<Routes[Key]> & {
    readonly headers?: Readonly<Record<string, string>>;
    readonly signal?: AbortSignal;
  };

// A JSON reply as its schema types it. A file or a stream comes as the
// Response itself.
type ReplyOf<Spec extends RouteSpec> = Spec["response"] extends
  "bytes" | "stream"
  ? Response
  : Spec["response"] extends TSchema
    ? Wire<Spec["response"]>
    : undefined;

export type ApiReply<Key extends RouteKey> = ReplyOf<Routes[Key]>;

export type ApiArgs<Key extends RouteKey> =
  AllOptional<ApiInput<Key>> extends true
    ? [input?: ApiInput<Key>]
    : [input: ApiInput<Key>];

// An error the server answered, with its code and the message a person
// reads (ADR 0047). The code is also the cause, for code that checks it.
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly body: unknown;

  constructor(status: number, code: string, message: string, body: unknown) {
    super(message, { cause: code });
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

export interface ApiClient {
  <Key extends RouteKey>(
    key: Key,
    ...input: ApiArgs<Key>
  ): Promise<ApiReply<Key>>;
  // The Response of a route that answered with a 2xx, such as a stream.
  readonly response: <Key extends RouteKey>(
    key: Key,
    ...input: ApiArgs<Key>
  ) => Promise<Response>;
}

export interface ApiClientOptions {
  // Where the server is; the page's own origin when unset.
  readonly server?: string | URL;
  readonly headers?: Readonly<Record<string, string>>;
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
}

// The path and query of a route, such as /api/sessions/abc?archived=true,
// for a link, an EventSource or a WebSocket.
export function apiPath<Key extends RouteKey>(
  key: Key,
  ...[input]: ApiArgs<Key>
): string {
  const spec: RouteSpec = routes[key];
  const params: Readonly<Record<string, string>> = input?.params ?? {};

  const path = spec.path
    .split("/")
    .map((part) => {
      if (part.startsWith(":")) {
        return encodeURIComponent(params[part.slice(1)] ?? "");
      }

      // The rest of a path goes as given, encoded by the caller, as the
      // server hands it on.
      return part.startsWith("*") ? (params[part.slice(1)] ?? "") : part;
    })
    .join("/");

  const query = new URLSearchParams(
    Object.entries(input?.query ?? {}).flatMap(([name, value]) =>
      value === undefined
        ? []
        : [
            [name, String(value as string | number | boolean)] satisfies [
              string,
              string,
            ],
          ],
    ),
  ).toString();

  return query === "" ? path : `${path}?${query}`;
}

// A typed client for the server's routes, which throws an ApiError when the
// server answers with one.
export function apiClient(options: ApiClientOptions = {}): ApiClient {
  const send = options.fetch ?? (async (url, init) => fetch(url, init));

  const response = async <Key extends RouteKey>(
    key: Key,
    ...args: ApiArgs<Key>
  ): Promise<Response> => {
    const spec: RouteSpec = routes[key];
    const [input] = args;
    const path = apiPath(key, ...args);
    const json = typeof spec.body === "object";

    const answered = await send(
      options.server === undefined ? path : new URL(path, options.server).href,
      {
        method: spec.method === "ANY" ? "GET" : spec.method,
        headers: {
          ...options.headers,
          ...(json && { "content-type": "application/json" }),
          ...input?.headers,
        },
        ...(json && { body: JSON.stringify(input?.body ?? {}) }),
        ...(spec.body === "bytes" && { body: input?.body as Bytes }),
        ...(input?.signal !== undefined && { signal: input.signal }),
      },
    );

    if (!answered.ok) {
      throw await errorOf(answered);
    }

    return answered;
  };

  const call = async <Key extends RouteKey>(
    key: Key,
    ...args: ApiArgs<Key>
  ): Promise<ApiReply<Key>> => {
    const spec: RouteSpec = routes[key];
    const answered = await response(key, ...args);

    if (spec.response === "bytes" || spec.response === "stream") {
      return answered as ApiReply<Key>;
    }

    const text = await answered.text();

    return (text === "" ? undefined : JSON.parse(text)) as ApiReply<Key>;
  };

  return Object.assign(call, { response });
}

async function errorOf(response: Response): Promise<ApiError> {
  const text = await response.text();
  let body: unknown = text;

  try {
    body = JSON.parse(text);
  } catch {
    // Not every answer is JSON, such as a proxy's.
  }

  const fields =
    typeof body === "object" && body !== null
      ? (body as { error?: unknown; message?: unknown })
      : {};

  const code =
    typeof fields.error === "string" ? fields.error : String(response.status);

  const message =
    typeof fields.message === "string" && fields.message !== ""
      ? fields.message
      : `${String(response.status)} ${response.statusText}`.trim();

  return new ApiError(response.status, code, message, body);
}
