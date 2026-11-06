import type { Static, TObject, TSchema } from "typebox";
import type { ToolAnnotations, ToolNamespace } from "./plugins";
import type { Wire } from "./wire";

// Who may call a route. A person signs in with a cookie or an access token;
// a runner and its Sessions' hosts carry the tokens the server gave them
// (ADR 0033). A webhook signs its body with HMAC-SHA256 under a secret its
// route knows.
export type Auth =
  | "public"
  | "person"
  | "admin"
  | "runner"
  | "session"
  | {
      readonly webhook: {
        readonly header?: string;
        readonly maxBytes?: number;
      };
    };

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "ANY";

// One route of the API. The path names its parameters as :name, and a last
// *name takes the rest of the path. A body or reply of bytes, such as a
// file, isn't JSON; a stream is server-sent events.
export interface RouteSpec {
  readonly method: Method;
  readonly path: string;
  readonly auth: Auth;
  readonly query?: TSchema;
  readonly body?: TSchema | "bytes";
  readonly response?: TSchema | "bytes" | "stream";
  // 200 when unset, or 204 for a reply without a body.
  readonly status?: 201 | 202 | 204 | 303;
  // The change topics a successful request publishes (ADR 0038).
  readonly changes?: readonly string[];
  // Takes minutes with nothing sent, such as building a plugin, so no idle
  // timeout ends it.
  readonly long?: boolean;
  readonly tool?: RouteToolSpec | readonly RouteToolSpec[];
}

type Input = Readonly<Record<string, unknown>>;

// A tool that is a request to the route, made as the person a Session acts
// for, or an MCP client's (ADR 0035). Its params default to the route's path
// parameters, query and body; body holds fields every call sends.
export interface RouteToolSpec {
  readonly name: string;
  readonly description: string;
  readonly params?: TObject;
  readonly body?: Input;
  readonly namespace?: ToolNamespace;
  readonly exposure?: "direct" | "deferred";
  readonly annotations?: ToolAnnotations;
  // lookup is a GET path whose reply text gets, to name what the call
  // changes; text gets undefined when that fails.
  readonly asks?: {
    readonly lookup?: (input: Input) => string;
    readonly text: (input: Input, found: unknown) => string;
  };
  // What the model sees of a successful reply's body.
  readonly result?: (body: unknown) => unknown;
  // What to open for the person after a successful call.
  readonly opens?: (
    body: unknown,
  ) => { readonly route: string; readonly label: string } | undefined;
  // Only plugins call it, never the model or an MCP client.
  readonly internal?: boolean;
}

type Segments<Path extends string> = Path extends `${infer Head}/${infer Rest}`
  ? Head | Segments<Rest>
  : Path;

type NameOf<Segment extends string> = Segment extends `:${infer Name}`
  ? Name
  : Segment extends `*${infer Name}`
    ? Name
    : never;

// The parameters a path names, such as { id } for /api/sessions/:id.
export type ParamsOf<Path extends string> = Readonly<
  Record<NameOf<Segments<Path>>, string>
>;

export type BodyOf<Spec extends RouteSpec> = Spec["body"] extends "bytes"
  ? undefined
  : Spec["body"] extends TSchema
    ? Static<Spec["body"]>
    : undefined;

export type QueryOf<Spec extends RouteSpec> = Spec["query"] extends TSchema
  ? Static<Spec["query"]>
  : undefined;

export type ReplyOf<Spec extends RouteSpec> = Spec["response"] extends
  "bytes" | "stream"
  ? never
  : Spec["response"] extends TSchema
    ? Wire<Spec["response"]>
    : unknown;
