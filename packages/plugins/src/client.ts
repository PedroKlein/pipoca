import { protocolVersion, versionHeader } from "@pipoca/protocol";
import type { PluginDefinition } from "./definition";
import { HttpError } from "./http";

type Query = Readonly<Record<string, string | number | boolean | undefined>>;

export interface TypedClient {
  readonly get: <R = unknown>(path: string, query?: Query) => Promise<R>;
  readonly post: <R = unknown>(path: string, body?: unknown) => Promise<R>;
  readonly put: <R = unknown>(path: string, body?: unknown) => Promise<R>;
  readonly patch: <R = unknown>(path: string, body?: unknown) => Promise<R>;
  readonly delete: <R = unknown>(path: string, query?: Query) => Promise<R>;
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
    get: async (path, query) => call("GET", path, query, undefined),
    post: async (path, body) => call("POST", path, undefined, body),
    put: async (path, body) => call("PUT", path, undefined, body),
    patch: async (path, body) => call("PATCH", path, undefined, body),
    delete: async (path, query) => call("DELETE", path, query, undefined),
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
