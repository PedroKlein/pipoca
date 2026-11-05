import type {
  Actor,
  Clock,
  DeclaredEvent,
  EnvironmentTemplate,
  Environment,
  GitLogin,
  Log,
  Method,
  Owner,
  RouteToolSpec,
  Session,
  SessionAccess,
} from "@pipoca/protocol";
import type { Static, TObject, TSchema } from "typebox";
import type { EventDef, Events, PluginDefinition } from "./definition";
import type { KernelEventOf } from "./events";
import type { Schedule } from "./schedule";
import type {
  KernelEvent,
  ModelOffer,
  PluginProfile,
  ProfileMcpServer,
  RunnerSource,
  SessionCloud,
  SessionLogins,
  SqlValue,
  StartRequest,
} from "./plugin";
import type { Transcript } from "./transcript";

export type { ToolResultEntry, Transcript } from "./transcript";

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
  readonly tool?: RouteToolSpec;
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

export interface ToolCall {
  readonly session: Session;
  readonly person?: Person;
  readonly owner: Owner;
}

export type ToolOutput =
  string | { readonly text: string; readonly details?: unknown };

export interface When {
  readonly owner?: "person" | "team" | "any";
  readonly ownSessions?: boolean;
  readonly available?: (
    session: Session,
    person: Person | undefined,
  ) => boolean;
}

export interface ToolDef<Pm extends TSchema = TSchema> {
  readonly name: string;
  readonly label?: string;
  readonly description: string;
  readonly params: Pm;
  readonly when?: When;
  // The question to ask the person before it runs, or undefined to run
  // without asking.
  readonly asks?: (
    input: Static<Pm>,
    call: ToolCall,
  ) => string | undefined | Promise<string | undefined>;
  readonly annotations?: {
    readonly readOnly?: boolean;
    readonly destructive?: boolean;
  };
  readonly exposure?: "direct" | "deferred";
  readonly replaceable?: boolean;
  readonly run: (
    input: Static<Pm>,
    call: ToolCall,
  ) => ToolOutput | Promise<ToolOutput>;
}

export interface ServerTools {
  readonly define: <Pm extends TSchema>(tool: ToolDef<Pm>) => void;
  readonly fromRoute: (
    method: Exclude<Method, "ANY">,
    path: string,
    spec: RouteToolSpec,
  ) => void;
}

export interface Sessions {
  readonly start: (
    request: Omit<StartRequest, "actsAs" | "access"> & {
      readonly key?: string;
      readonly access?: SessionAccess;
    },
  ) => Session;
  readonly get: (id: string) => Session | undefined;
  readonly owned: (
    key: string,
    o?: { readonly archived?: boolean },
  ) => readonly Session[];
  readonly archive: (id: string) => void;
  readonly unarchive: (id: string) => void;
  readonly sees: (id: string, person: string) => boolean;
  readonly send: (
    id: string,
    message: {
      readonly text: string;
      readonly turn: boolean;
      readonly as?: Actor;
      readonly notice?: { readonly kind: string; readonly data?: unknown };
      // A repeat with the key of a message still queued for the Session is
      // a no-op. Once that one is delivered, the key sends again.
      readonly dedupe?: string;
    },
  ) => "queued" | "gone";
  readonly bind: (key: string, sessionId: string) => void;
  readonly boundTo: (key: string) => string | undefined;
  readonly unbind: (key: string) => void;
}

export interface Store {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the caller names the row's type, as with all
  readonly get: <T>(
    sql: string,
    ...params: readonly SqlValue[]
  ) => T | undefined;
  readonly all: <T>(sql: string, ...params: readonly SqlValue[]) => T[];
  readonly run: (
    sql: string,
    ...params: readonly SqlValue[]
  ) => { readonly changes: number };
  readonly transaction: <T>(fn: () => T) => T;
}

export interface Secrets {
  readonly seal: (table: string, rowId: string, text: string) => string;
  readonly open: (table: string, rowId: string, sealed: string) => string;
  readonly token: (bytes?: number) => string;
  readonly hash: (token: string) => string;
}

type ConfigValue<P extends PluginDefinition> = [P["config"]] extends [TSchema]
  ? Static<NonNullable<P["config"]>>
  : Readonly<Record<string, never>>;

type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { readonly [K in keyof T]?: DeepPartial<T[K]> }
    : T;

type CollectionKeys<V> = {
  [K in keyof V]: V[K] extends readonly Readonly<Record<string, unknown>>[]
    ? K
    : never;
}[keyof V] &
  string;

type ItemOf<V, K extends keyof V> = V[K] extends readonly (infer I)[]
  ? I
  : never;

export interface Collection<I> {
  readonly list: () => readonly I[];
  readonly get: (key: string) => I | undefined;
  readonly put: (item: I) => void;
  readonly remove: (key: string) => boolean;
}

export interface PluginConfig<P extends PluginDefinition = PluginDefinition> {
  // Defaults filled, secrets opened, bad collection items logged and skipped.
  readonly get: () => ConfigValue<P>;
  // Seals plain secrets.
  readonly set: (change: DeepPartial<ConfigValue<P>>) => void;
  readonly watch: (
    fn: (next: ConfigValue<P>, previous: ConfigValue<P>) => void,
  ) => void;
  readonly lockedIn: () => string | undefined;
  readonly collection: <K extends CollectionKeys<ConfigValue<P>>>(
    name: K,
  ) => Collection<ItemOf<ConfigValue<P>, K>>;
  readonly dir: string;
}

export interface PluginEnvironments {
  readonly list: () => readonly Environment[];
  readonly unplaced: (environmentId: string) => readonly Session[];
  readonly runnerToken: (environmentId: string, runner: string) => string;
  readonly revokeRunner: (environmentId: string, runner: string) => void;
  readonly templates: () => readonly EnvironmentTemplate[];
  readonly templateConfig: {
    readonly get: (templateId: string) => unknown;
    readonly set: (templateId: string, value: unknown) => void;
  };
}

export interface PluginProfiles {
  readonly mcpServers: () => readonly ProfileMcpServer[];
  readonly buildsOn: (id: string) => readonly string[];
}

export interface SignInProvider {
  readonly logins: () => readonly {
    readonly label: string;
    readonly path: string;
  }[];
}

export interface Providers {
  readonly runners: (p: {
    readonly kind: { readonly label: string; readonly icon: string };
    readonly starts: (environment: RunnerSource) => boolean;
    readonly replacesServerRunner?: () => boolean;
  }) => void;
  readonly models: (offer: ModelOffer) => void;
  readonly gitCredentials: (
    fn: (
      person: string,
      session: Pick<Session, "actsAs" | "workspace">,
    ) => readonly GitLogin[],
  ) => void;
  readonly modelCredentials: (
    fn: (cloud: SessionCloud) => Promise<SessionLogins>,
  ) => void;
  readonly signIn: (provider: SignInProvider) => void;
  // Sessions on the Profile load every route tool when routeTools is true.
  readonly profile: (
    key: string,
    profile: PluginProfile,
    o?: { readonly team?: boolean; readonly routeTools?: boolean },
  ) => string;
  readonly runtime: () => {
    readonly binary: string;
    readonly serverUrl: string;
    readonly dataDir: string;
    readonly solo?: {
      readonly environmentId: string;
      readonly folders: readonly string[];
    };
  };
}

export interface ServerContext<P extends PluginDefinition = PluginDefinition> {
  readonly id: P["id"];
  readonly people: People;
  readonly sessions: Sessions;
  readonly routes: Routes;
  readonly tools: ServerTools;
  readonly schedule: Schedule;
  readonly events: PluginEvents<P>;
  readonly config: PluginConfig<P>;
  readonly store: Store;
  readonly transcript: Transcript;
  readonly urls: Urls;
  readonly provide: Providers;
  readonly secrets: Secrets;
  readonly environments: PluginEnvironments;
  readonly profiles: PluginProfiles;
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
