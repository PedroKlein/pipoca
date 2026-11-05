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

export interface TypedClient {
  readonly get: Read;
  readonly post: Write;
  readonly put: Write;
  readonly patch: Write;
  readonly delete: Read;
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

    const url = `${base}${path}${search.size === 0 ? "" : `?${search.toString()}`}`;

    const answered = await send(
      options.server === undefined ? url : new URL(url, options.server).href,
      {
        method,
        headers: {
          ...options.headers,
          ...(options.session !== undefined && {
            [versionHeader]: String(protocolVersion),
          }),
          ...(body !== undefined && { "content-type": "application/json" }),
        },
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
