import type {
  Clock,
  DeclaredEvent,
  Log,
  Owner,
  Session,
} from "@pipoca/protocol";
import type { Static, TObject, TSchema } from "typebox";
import type { EventDef, Events, PluginDefinition } from "./definition";
import type { KernelEventOf } from "./events";
import type { KernelEvent } from "./plugin";

export interface Person {
  readonly id: string;
  readonly name: string;
  readonly admin: boolean;
  readonly email?: string;
}

export interface People {
  readonly get: (id: string) => Person | undefined;
  readonly list: () => readonly Person[];
  readonly byName: (name: string) => Person | undefined;
}

export interface ToolResultEntry<D = unknown> {
  readonly callId: string;
  readonly line: number;
  readonly input: unknown;
  readonly details: D;
  readonly isError: boolean;
}

export interface Transcript {
  readonly toolResults: <D = unknown>(
    sessionId: string,
    tool: string,
  ) => readonly ToolResultEntry<D>[];
  readonly messages: (
    sessionId: string,
    o?: { readonly sinceLine?: number },
  ) => readonly {
    readonly line: number;
    readonly role: "user" | "assistant";
    readonly text: string;
  }[];
  readonly lastReply: (
    sessionId: string,
  ) => { readonly line: number; readonly text: string } | undefined;
  readonly length: (sessionId: string) => number;
}

type EventsOf<P extends PluginDefinition> = NonNullable<P["events"]> & Events;

export interface PluginEvents<P extends PluginDefinition> {
  readonly emit: <N extends keyof EventsOf<P> & string>(
    name: N,
    fields: Static<EventsOf<P>[N]["fields"]>,
    o: { readonly to: readonly Owner[] },
  ) => void;
  // Kernel events by type, or another plugin's by its imported definition.
  // That plugin is an optional require: while it is off, nothing is heard.
  readonly on: {
    <T extends KernelEvent["type"]>(
      type: T,
      fn: (event: KernelEventOf<T>) => void,
    ): void;
    <F extends TObject>(
      def: EventDef<F>,
      fn: (event: {
        readonly fields: Static<F>;
        readonly to: readonly Owner[];
        readonly plugin: string;
      }) => void,
    ): void;
  };
  readonly declared: () => readonly DeclaredEvent[];
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
  readonly people: People;
  readonly routes: Routes;
  readonly events: PluginEvents<P>;
  readonly transcript: Transcript;
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
