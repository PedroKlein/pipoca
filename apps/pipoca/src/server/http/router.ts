import { createHmac, timingSafeEqual } from "node:crypto";
import { HttpError, isHttpError } from "@pipoca/plugins";
import { checkBody, readJson } from "@pipoca/plugins/host";
import type { OnBehalf, UserActor } from "@pipoca/pluginhost";
import {
  type BodyOf,
  type Log,
  type ParamsOf,
  protocolVersion,
  type QueryOf,
  type ReplyOf,
  type RouteKey,
  type Routes,
  type RouteSpec,
  versionHeader,
} from "@pipoca/protocol";
import type { RunnerCaller } from "@pipoca/environments";
import { Value } from "typebox/value";
import { errorReply, thrown } from "./replies";

export interface PersonCaller {
  readonly kind: "person";
  readonly actor: UserActor;
  readonly id: string;
  readonly admin: boolean;
}

export interface PublicCaller {
  readonly kind: "public";
}

export type AnyCaller = PersonCaller | RunnerCaller | PublicCaller;

type CallerOf<Spec extends RouteSpec> = Spec["auth"] extends "person" | "admin"
  ? PersonCaller
  : Spec["auth"] extends "runner" | "session"
    ? RunnerCaller
    : PublicCaller;

export interface Context<Spec extends RouteSpec> {
  readonly request: Request;
  readonly params: ParamsOf<Spec["path"]>;
  readonly query: QueryOf<Spec>;
  readonly body: BodyOf<Spec>;
  readonly caller: CallerOf<Spec>;
}

// A reply is the route's JSON, nothing for a reply without a body, or a
// Response of its own, such as a stream or a file.
export type Handler<Spec extends RouteSpec> = (
  context: Context<Spec>,
) =>
  | ReplyOf<Spec>
  | Response
  | undefined
  | Promise<ReplyOf<Spec> | Response | undefined>;

export type Handlers<Key extends RouteKey = RouteKey> = {
  readonly [K in Key]: Handler<Routes[K]>;
};

export interface Route {
  readonly spec: RouteSpec;
  readonly handler: Handler<RouteSpec>;
  // The secret a webhook route's body is signed with.
  readonly secret?: (
    params: Readonly<Record<string, string>>,
  ) => string | undefined;
}

// How the router knows who calls.
export interface Callers {
  readonly person: (request: Request) => PersonCaller | undefined;
  readonly runner: (request: Request) => RunnerCaller | undefined;
  // Whether a runner's or Session host's token reaches this Session.
  readonly hosts: (caller: RunnerCaller, sessionId: string) => boolean;
}

export interface Router {
  readonly handle: (request: Request) => Promise<Response>;
  readonly takesLong: (request: Request) => boolean;
}

type Segment =
  | { readonly kind: "static"; readonly value: string }
  | { readonly kind: "param" | "rest"; readonly name: string };

interface Compiled extends Route {
  readonly segments: readonly Segment[];
}

const runnerPrefix = "/runner/";

const webhookMaxBytes = 1024 * 1024;

const kindOrder = { static: 0, param: 1, rest: 2 } as const;

// One place answers every route: it finds the route, checks who calls and
// what they send, answers errors with { error, message } (ADR 0047), logs
// the request and publishes its change topics.
export function createRouter(
  routes: readonly Route[],
  deps: {
    readonly callers: Callers;
    readonly publish: (topic: string) => void;
    // A domain error that is the caller's to fix, answered with a 400.
    readonly refused: (error: unknown) => boolean;
    readonly log: Log;
  },
): Router {
  const compiled: readonly Compiled[] = routes.map((route) => ({
    ...route,
    segments: route.spec.path
      .split("/")
      .slice(1)
      .map((part): Segment => {
        if (part.startsWith(":")) {
          return { kind: "param", name: part.slice(1) };
        }

        return part.startsWith("*")
          ? { kind: "rest", name: part.slice(1) }
          : { kind: "static", value: part };
      }),
  }));

  const find = (
    request: Request,
  ):
    | { readonly route: Compiled; readonly params: Record<string, string> }
    | { readonly allow: readonly string[] }
    | undefined => {
    const parts = new URL(request.url).pathname.split("/").slice(1);

    const matched = compiled.flatMap((route) => {
      const params = matchOf(route.segments, parts);

      return params === undefined ? [] : [{ route, params }];
    });

    const [best] = matched
      .filter(
        ({ route }) =>
          route.spec.method === "ANY" || route.spec.method === request.method,
      )
      .sort((a, b) => specificity(a.route.segments, b.route.segments));

    if (best !== undefined) {
      return best;
    }

    return matched.length === 0
      ? undefined
      : { allow: [...new Set(matched.map(({ route }) => route.spec.method))] };
  };

  const callerOf = (
    spec: RouteSpec,
    request: Request,
    params: Readonly<Record<string, string>>,
  ): AnyCaller => {
    const { auth } = spec;

    if (spec.path.startsWith(runnerPrefix)) {
      const version = request.headers.get(versionHeader);

      if (version !== String(protocolVersion)) {
        throw new HttpError(
          400,
          `unsupported protocol version ${String(version)}`,
          "unsupported_version",
        );
      }
    }

    if (auth === "public" || typeof auth === "object") {
      return { kind: "public" };
    }

    if (auth === "person" || auth === "admin") {
      const person = deps.callers.person(request);

      if (person === undefined) {
        throw new HttpError(401, "Sign in again.", "signed_out");
      }

      if (auth === "admin" && !person.admin) {
        throw new HttpError(403, "Only admins can do this.", "admin_only");
      }

      return person;
    }

    const runner = deps.callers.runner(request);

    if (runner === undefined) {
      throw new HttpError(
        401,
        "The server doesn't know this token.",
        "unknown_token",
      );
    }

    const reaches =
      auth === "runner"
        ? runner.sessionId === null
        : deps.callers.hosts(runner, params["id"] ?? "");

    if (!reaches) {
      throw new HttpError(404, "Not found.", "not_found");
    }

    return runner;
  };

  const answer = async (
    route: Compiled,
    request: Request,
    params: Readonly<Record<string, string>>,
  ): Promise<{ readonly response: Response; readonly actor?: string }> => {
    const { spec } = route;
    const caller = callerOf(spec, request, params);

    if (typeof spec.auth === "object") {
      await signed(request, spec.auth.webhook, route.secret?.(params));
    }

    const query =
      spec.query === undefined
        ? undefined
        : checkBody(
            Value.Convert(
              spec.query,
              Object.fromEntries(new URL(request.url).searchParams),
            ),
            spec.query,
          );

    if (typeof spec.body === "object" && !sentJson(request)) {
      throw new HttpError(
        415,
        "Send the body as JSON, with content-type application/json.",
        "unsupported_media_type",
      );
    }

    const body =
      spec.body === undefined || spec.body === "bytes"
        ? undefined
        : checkBody(await readJson(request), spec.body);

    const reply = await route.handler({
      request,
      params,
      query,
      body,
      caller,
    } as Context<RouteSpec>);

    const actor = "actor" in caller ? caller.actor : undefined;

    if (reply instanceof Response) {
      return { response: reply, ...(actor !== undefined && { actor }) };
    }

    return {
      response:
        reply === undefined
          ? new Response(null, { status: spec.status ?? 204 })
          : Response.json(reply, { status: spec.status ?? 200 }),
      ...(actor !== undefined && { actor }),
    };
  };

  return {
    handle: async (request) => {
      const started = performance.now();
      const found = find(request);

      if (found === undefined) {
        return errorReply(404, "not_found", "Not found.");
      }

      if ("allow" in found) {
        return Response.json(
          {
            error: "method_not_allowed",
            message: `${request.method} isn't one of ${found.allow.join(", ")}.`,
          },
          { status: 405, headers: { allow: found.allow.join(", ") } },
        );
      }

      const { route, params } = found;
      const { spec } = route;
      let actor: string | undefined;
      let response: Response;

      try {
        ({ response, actor } = await answer(route, request, params));
      } catch (error) {
        response = failed(error, deps.refused);

        if (response.status === 500) {
          deps.log("request failed", {
            method: request.method,
            path: new URL(request.url).pathname,
            error: String(error),
          });
        }
      }

      if (request.method !== "GET" && response.ok) {
        for (const topic of spec.changes ?? []) {
          deps.publish(topic);
        }
      }

      // Runners post often while a Session works, and reads say little, so
      // only changes people make and failures are logged.
      const quiet =
        response.status < 400 &&
        (request.method === "GET" ||
          spec.auth === "runner" ||
          spec.auth === "session");

      if (!quiet) {
        deps.log("request", {
          method: request.method,
          route: spec.path,
          status: response.status,
          ms: Math.round(performance.now() - started),
          ...(actor !== undefined && { actor }),
        });
      }

      return response;
    },
    takesLong: (request) => {
      const found = find(request);

      return (
        found !== undefined &&
        "route" in found &&
        found.route.spec.long === true
      );
    },
  };
}

// A webhook's body, signed as sha256=<hex> in its header or in GitHub's.
async function signed(
  request: Request,
  webhook: { readonly header?: string; readonly maxBytes?: number },
  secret: string | undefined,
): Promise<void> {
  const limit = webhook.maxBytes ?? webhookMaxBytes;

  const tooLarge = new HttpError(
    413,
    `The body is over ${String(limit)} bytes.`,
    "too_large",
  );

  if (Number(request.headers.get("content-length") ?? 0) > limit) {
    throw tooLarge;
  }

  const body = new Uint8Array(await request.clone().arrayBuffer());

  if (body.length > limit) {
    throw tooLarge;
  }

  const sent = (
    request.headers.get(webhook.header ?? "x-pipoca-signature") ??
    request.headers.get("x-hub-signature-256") ??
    ""
  ).replace(/^sha256=/, "");

  const expected =
    secret === undefined
      ? ""
      : createHmac("sha256", secret).update(body).digest("hex");

  if (
    expected === "" ||
    sent.length !== expected.length ||
    !timingSafeEqual(Buffer.from(sent), Buffer.from(expected))
  ) {
    throw new HttpError(
      401,
      "The signature doesn't match the body.",
      "bad_signature",
    );
  }
}

function sentJson(request: Request): boolean {
  const type = request.headers.get("content-type") ?? "";

  return type.split(";")[0]?.trim().toLowerCase() === "application/json";
}

function matchOf(
  segments: readonly Segment[],
  parts: readonly string[],
): Record<string, string> | undefined {
  const params: Record<string, string> = {};

  for (const [index, segment] of segments.entries()) {
    if (segment.kind === "rest") {
      if (parts.length <= index) {
        return undefined;
      }

      // Still percent-encoded, so a key holding a slash stays one key.
      params[segment.name] = parts.slice(index).join("/");

      return params;
    }

    const part = parts[index];

    if (part === undefined) {
      return undefined;
    }

    if (segment.kind === "static") {
      if (part !== segment.value) {
        return undefined;
      }
    } else {
      if (part === "") {
        return undefined;
      }

      const value = decoded(part);

      if (value === undefined) {
        return undefined;
      }

      params[segment.name] = value;
    }
  }

  return parts.length === segments.length ? params : undefined;
}

function specificity(a: readonly Segment[], b: readonly Segment[]): number {
  for (const [index, segment] of a.entries()) {
    const other = b[index];

    if (other === undefined) {
      return 1;
    }

    const order = kindOrder[segment.kind] - kindOrder[other.kind];

    if (order !== 0) {
      return order;
    }
  }

  return a.length - b.length;
}

function decoded(part: string): string | undefined {
  try {
    return decodeURIComponent(part);
  } catch {
    return undefined;
  }
}

function failed(
  error: unknown,
  refused: (error: unknown) => boolean,
): Response {
  if (isHttpError(error)) {
    return thrown(error);
  }

  if (refused(error)) {
    return errorReply(
      400,
      "bad_request",
      error instanceof Error ? error.message : String(error),
    );
  }

  return errorReply(
    500,
    "internal",
    "The server failed to answer. Its log says why.",
  );
}

// Requests a toolset tool makes as a user (ADR 0035). They never come from
// the network, so they carry no sign-in cookie.
const onBehalf = new WeakMap<Request, OnBehalf>();

export function onBehalfOf(caller: OnBehalf, request: Request): Request {
  onBehalf.set(request, caller);

  return request;
}

export function behalfOf(request: Request): OnBehalf | undefined {
  return onBehalf.get(request);
}

// The client's address, as serve saw it. Requests made inside the server
// have none.
const addresses = new WeakMap<Request, string>();

export function fromAddress(address: string, request: Request): Request {
  addresses.set(request, address);

  return request;
}

export function addressOf(request: Request): string {
  return addresses.get(request) ?? "";
}

// The rest of a path, such as a file's, which the router leaves
// percent-encoded.
export function restOf(encoded: string): string {
  try {
    return decodeURIComponent(encoded);
  } catch {
    throw new HttpError(
      400,
      "path isn't valid percent-encoding",
      "bad_request",
    );
  }
}
