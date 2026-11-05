import type { Clock, Log, Owner, Session } from "@pipoca/protocol";
import type { Static, TSchema } from "typebox";
import type { PluginDefinition } from "./definition";

export interface Person {
  readonly id: string;
  readonly name: string;
  readonly admin: boolean;
  readonly email?: string;
}

export type Params = Readonly<Record<string, string>>;

export type Auth =
  | "person"
  | "admin"
  | "session"
  | "public"
  | {
      readonly webhook: {
        readonly secret: (params: Params) => string | undefined;
        readonly header?: string;
        readonly maxBytes?: number;
      };
    };

export type Caller =
  | { readonly kind: "person"; readonly person: Person; readonly owner: Owner }
  | {
      readonly kind: "session";
      readonly session: Session;
      readonly person?: Person;
      readonly owner: Owner;
    }
  | { readonly kind: "public"; readonly person?: Person };

type Schema = TSchema | undefined;

type StaticOf<S extends Schema> = [S] extends [TSchema] ? Static<S> : undefined;

export interface RouteSpec<
  B extends Schema = Schema,
  Q extends Schema = Schema,
  R extends Schema = Schema,
> {
  readonly auth: Auth;
  readonly body?: B;
  readonly query?: Q;
  readonly response?: R;
  readonly changes?: readonly string[];
  readonly long?: boolean;
}

export interface RouteInput<B extends Schema, Q extends Schema> {
  readonly caller: Caller;
  readonly params: Params;
  readonly body: StaticOf<B>;
  readonly query: StaticOf<Q>;
  readonly raw: Request;
}

type Reply<R extends Schema> = [R] extends [TSchema]
  ? Static<R> | Response
  : unknown;

export type Handler<B extends Schema, Q extends Schema, R extends Schema> = (
  request: RouteInput<B, Q>,
) => Reply<R> | Promise<Reply<R>>;

type Read = <Q extends Schema = undefined, R extends Schema = undefined>(
  path: string,
  spec: RouteSpec<undefined, Q, R>,
  handler: Handler<undefined, Q, R>,
) => void;

type Write = <
  B extends Schema = undefined,
  Q extends Schema = undefined,
  R extends Schema = undefined,
>(
  path: string,
  spec: RouteSpec<B, Q, R>,
  handler: Handler<B, Q, R>,
) => void;

type ScopedRead = <Q extends Schema = undefined, R extends Schema = undefined>(
  path: string,
  spec: Omit<RouteSpec<undefined, Q, R>, "auth">,
  handler: (
    request: RouteInput<undefined, Q> & { readonly owner: Owner },
  ) => Reply<R> | Promise<Reply<R>>,
) => void;

type ScopedWrite = <
  B extends Schema = undefined,
  Q extends Schema = undefined,
  R extends Schema = undefined,
>(
  path: string,
  spec: Omit<RouteSpec<B, Q, R>, "auth">,
  handler: (
    request: RouteInput<B, Q> & { readonly owner: Owner },
  ) => Reply<R> | Promise<Reply<R>>,
) => void;

export interface ScopedRoutes {
  readonly get: ScopedRead;
  readonly post: ScopedWrite;
  readonly put: ScopedWrite;
  readonly patch: ScopedWrite;
  readonly delete: ScopedRead;
}

export interface Routes {
  readonly get: Read;
  readonly post: Write;
  readonly put: Write;
  readonly patch: Write;
  readonly delete: Read;
  readonly scoped: (path: string, routes: (r: ScopedRoutes) => void) => void;
  readonly topic: (name: string) => void;
}

export interface Urls {
  readonly public: (path: string) => string;
  readonly cookie: {
    readonly set: (
      response: Response,
      name: string,
      value: string,
      maxAgeS: number,
    ) => void;
    readonly get: (request: Request, name: string) => string | undefined;
  };
}

export interface ServerContext<P extends PluginDefinition = PluginDefinition> {
  readonly id: P["id"];
  readonly routes: Routes;
  readonly urls: Urls;
  readonly clock: Clock;
  readonly log: Log;
  readonly signal: AbortSignal;
}

export interface ServerPart<P extends PluginDefinition = PluginDefinition> {
  readonly plugin: P;
  register(ctx: ServerContext<P>): void | Promise<void>;
}

export function defineServer<P extends PluginDefinition>(
  plugin: P,
  register: (ctx: ServerContext<P>) => void | Promise<void>,
): ServerPart<P> {
  return { plugin, register };
}
