import type { Static, TSchema } from "typebox";

// Who may call a route. A person signs in with a cookie or an access token;
// a runner and its Sessions' hosts carry the tokens the server gave them
// (ADR 0033). A webhook proves itself with a signature, which plugins get
// in slice 6.
export type Auth =
  | "public"
  | "person"
  | "admin"
  | "runner"
  | "session"
  | { readonly webhook: { readonly header?: string } };

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

export type BodyOf<Spec extends RouteSpec> = Spec["body"] extends TSchema
  ? Static<Spec["body"]>
  : undefined;

export type QueryOf<Spec extends RouteSpec> = Spec["query"] extends TSchema
  ? Static<Spec["query"]>
  : undefined;

export type ReplyOf<Spec extends RouteSpec> = Spec["response"] extends TSchema
  ? Static<Spec["response"]>
  : unknown;
