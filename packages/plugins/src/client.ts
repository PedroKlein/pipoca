import { protocolVersion, versionHeader } from "@pipoca/protocol";
import type { PluginDefinition } from "./definition";
import { HttpError } from "./http";

type Query = Readonly<Record<string, string | number | boolean | undefined>>;

interface CallOptions {
  readonly signal?: AbortSignal;
}

type Read = <R = unknown>(
  path: string,
  query?: Query,
  o?: CallOptions,
) => Promise<R>;

type Write = <R = unknown>(
  path: string,
  body?: unknown,
  o?: CallOptions,
) => Promise<R>;

// A path that starts with / is the kernel's, such as /api/sessions; any
// other is the plugin's own route.
export interface TypedClient {
  readonly get: Read;
  readonly post: Write;
  readonly put: Write;
  readonly patch: Write;
  readonly delete: Read;
  // The response as it came, such as for bytes or a status to check.
  readonly raw: (path: string, init?: RequestInit) => Promise<Response>;
}

export interface ClientOptions {
  readonly server?: string | URL;
  readonly session?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
}

export function pluginClient(
  plugin: Pick<PluginDefinition, "id">,
  options: ClientOptions = {},
): TypedClient {
  const send = options.fetch ?? (async (url, init) => fetch(url, init));

  const base =
    options.session === undefined
      ? `/api/ext/${plugin.id}/`
      : `/runner/sessions/${encodeURIComponent(options.session)}/ext/${plugin.id}/`;

  const request = async (
    path: string,
    init: RequestInit,
  ): Promise<Response> => {
    const url = path.startsWith("/") ? path : `${base}${path}`;

    return send(
      options.server === undefined ? url : new URL(url, options.server).href,
      {
        ...init,
        headers: {
          ...options.headers,
          ...(options.session !== undefined && {
            [versionHeader]: String(protocolVersion),
          }),
          ...(typeof init.body === "string" && {
            "content-type": "application/json",
          }),
          ...(init.headers as Readonly<Record<string, string>> | undefined),
        },
      },
    );
  };

  const call = async <R>(
    method: string,
    path: string,
    query: Query | undefined,
    body: unknown,
    { signal }: CallOptions = {},
  ): Promise<R> => {
    const search = new URLSearchParams();

    for (const [name, value] of Object.entries(query ?? {})) {
      if (value !== undefined) {
        search.set(name, String(value));
      }
    }

    const answered = await request(
      `${path}${search.size === 0 ? "" : `?${search.toString()}`}`,
      {
        method,
        ...(body !== undefined && { body: JSON.stringify(body) }),
        ...(signal !== undefined && { signal }),
      },
    );

    const text = await answered.text();
    const parsed = parsedOf(text);

    if (!answered.ok) {
      const { error, message } = (parsed ?? {}) as {
        error?: unknown;
        message?: unknown;
      };

      throw new HttpError(
        answered.status,
        typeof message === "string" ? message : text,
        typeof error === "string" ? error : undefined,
      );
    }

    return parsed as R;
  };

  return {
    get: async (path, query, o) => call("GET", path, query, undefined, o),
    post: async (path, body, o) => call("POST", path, undefined, body, o),
    put: async (path, body, o) => call("PUT", path, undefined, body, o),
    patch: async (path, body, o) => call("PATCH", path, undefined, body, o),
    delete: async (path, query, o) => call("DELETE", path, query, undefined, o),
    raw: async (path, init = {}) => request(path, init),
  };
}

function parsedOf(text: string): unknown {
  if (text === "") {
    return undefined;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
