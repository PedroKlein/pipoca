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
  Timer,
  ToolResult,
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
    // Another plugin's event by its name, for a plugin whose people name
    // events at run time, such as in a trigger they write.
    (
      type: `${string}.${string}`,
      fn: (event: {
        readonly type: `${string}.${string}`;
        readonly fields: Readonly<Record<string, unknown>>;
        readonly to: readonly Owner[];
        readonly plugin: string;
      }) => void,
    ): void;
  };
  readonly declared: () => readonly DeclaredEvent[];
}

export type Params = Readonly<Record<string, string>>;

type ParamName<S extends string> = S extends `:${infer N}` | `*${infer N}`
  ? N
  : never;

type ParamNames<P extends string> = P extends `${infer S}/${infer Rest}`
  ? ParamName<S> | ParamNames<Rest>
  : ParamName<P>;

// A route's params by the names its path gives them, such as id for
// "votes/:id/pick".
export type ParamsOf<P extends string> = string extends P
  ? Params
  : Readonly<Record<ParamNames<P>, string>>;

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

export interface PersonCaller {
  readonly kind: "person";
  readonly person: Person;
  readonly owner: Owner;
}

export interface SessionCaller {
  readonly kind: "session";
  readonly session: Session;
  readonly person?: Person;
  readonly owner: Owner;
}

export interface PublicCaller {
  readonly kind: "public";
  readonly person?: Person;
}

export type Caller = PersonCaller | SessionCaller | PublicCaller;

// A person route takes only people: a Session reaches it through a route
// tool, which calls it as the person.
export type CallerOf<A extends Auth> = A extends "person" | "admin"
  ? PersonCaller
  : A extends "session"
    ? SessionCaller
    : PublicCaller;

type Schema = TSchema | undefined;

type StaticOf<S extends Schema> = [S] extends [TSchema] ? Static<S> : undefined;

export interface RouteSpec<
  A extends Auth = Auth,
  B extends Schema = Schema,
  Q extends Schema = Schema,
  R extends Schema = Schema,
> {
  readonly auth: A;
  readonly body?: B;
  readonly query?: Q;
  readonly response?: R;
  // What a reply other than 200 answers with.
  readonly status?: 201 | 202;
  // A person route that also answers at team/<path>, with the team as the
  // caller's owner, while the plugin is in team work.
  readonly team?: A extends "person" ? boolean : never;
  readonly changes?: readonly string[];
  readonly long?: boolean;
  readonly tool?: RouteToolSpec;
}

export interface RouteInput<
  P extends string,
  A extends Auth,
  B extends Schema,
  Q extends Schema,
> {
  readonly caller: CallerOf<A>;
  readonly params: ParamsOf<P>;
  readonly body: StaticOf<B>;
  readonly query: StaticOf<Q>;
  readonly raw: Request;
}

type Reply<R extends Schema> = [R] extends [TSchema]
  ? Static<R> | Response
  : unknown;

export type Handler<
  P extends string,
  A extends Auth,
  B extends Schema,
  Q extends Schema,
  R extends Schema,
> = (request: RouteInput<P, A, B, Q>) => Reply<R> | Promise<Reply<R>>;

type Read = <
  P extends string,
  A extends Auth,
  Q extends Schema = undefined,
  R extends Schema = undefined,
>(
  path: P,
  spec: RouteSpec<A, undefined, Q, R>,
  handler: Handler<P, A, undefined, Q, R>,
) => void;

type Write = <
  P extends string,
  A extends Auth,
  B extends Schema = undefined,
  Q extends Schema = undefined,
  R extends Schema = undefined,
>(
  path: P,
  spec: RouteSpec<A, B, Q, R>,
  handler: Handler<P, A, B, Q, R>,
) => void;

export interface Routes {
  readonly get: Read;
  readonly post: Write;
  readonly put: Write;
  readonly patch: Write;
  readonly delete: Read;
  readonly topic: (name: string) => void;
}

export interface Urls {
  readonly public: (path: string) => string;
  // A cookie only the plugin's own routes get back, such as the browser's
  // half of an OAuth state. It is Lax, so it comes back on the redirect
  // from another site.
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

// One kind of tool, run on the server with a ToolCall or in the Session with
// a SessionToolCall.
export interface ToolDef<Pm extends TSchema = TSchema, Call = ToolCall> {
  readonly name: string;
  readonly label?: string;
  readonly description: string;
  readonly params: Pm;
  // Which Sessions get a server tool. A Session part's tools are in every
  // Session the plugin is on in.
  readonly when?: When;
  // The question to ask the person before it runs, or undefined to run
  // without asking.
  readonly asks?: (
    input: Static<Pm>,
    call: Call,
  ) => string | undefined | Promise<string | undefined>;
  readonly annotations?: {
    readonly readOnly?: boolean;
    readonly destructive?: boolean;
  };
  readonly exposure?: "direct" | "deferred";
  // What the system prompt says about the tool, as Pi's own tools do.
  readonly prompt?: {
    readonly snippet: string;
    readonly guidelines?: readonly string[];
  };
  // Runs alone, never beside the turn's other tool calls.
  readonly sequential?: boolean;
  // A user's own tool of this name wins.
  readonly replaceable?: boolean;
  readonly run: (
    input: Static<Pm>,
    call: Call,
  ) => ToolOutput | Promise<ToolOutput>;
}

export interface ServerTools {
  readonly define: <Pm extends TSchema>(tool: ToolDef<Pm>) => void;
  readonly fromRoute: (
    method: Exclude<Method, "ANY">,
    path: string,
    spec: RouteToolSpec,
  ) => void;
  // Runs a route tool, a kernel one or a plugin's, as the person a Session
  // acts for, in a Session on a Profile that loads route tools. It is how a
  // plugin's tool does what other tools already do, such as writing a
  // Profile's files.
  readonly call: (
    name: string,
    input: unknown,
    o: { readonly session: string },
  ) => Promise<ToolResult>;
}

export interface Sessions {
  readonly start: (
    request: Omit<StartRequest, "access"> & {
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
  // A key of the plugin's own, such as a mail thread, names one Session.
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
  readonly templates: () => readonly EnvironmentTemplate[];
}

// What Profiles hold that a plugin reads, such as the MCP servers people
// sign in to.
export interface PluginProfiles {
  // Every MCP server of the base, everyone's My defaults and every Profile.
  readonly mcpServers: () => readonly ProfileMcpServer[];
  // The Profiles one builds on, nearest first.
  readonly buildsOn: (profileId: string) => readonly string[];
}

export interface Providers {
  readonly models: (offer: ModelOffer) => void;
  // The logins a Session's git and gh sign in with: its person's, the
  // team's, or for a Session that acts as one of this plugin's identities,
  // that identity's. Called as a runner takes the Session, so it can't wait.
  readonly gitCredentials: (
    of: (
      owner: Owner,
      session: Pick<Session, "actsAs" | "workspace">,
    ) => readonly GitLogin[],
  ) => void;
  // Sessions on the Profile load every route tool when routeTools is true.
  readonly profile: (
    key: string,
    profile: PluginProfile,
    o?: { readonly team?: boolean; readonly routeTools?: boolean },
  ) => string;
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
  // In-memory time, lost on restart, for waits such as a long poll.
  readonly timer: Timer;
  readonly log: Log;
  readonly signal: AbortSignal;
}

export interface ServerPart<P extends PluginDefinition = PluginDefinition> {
  readonly plugin: P;
  register(ctx: ServerContext<P>): void;
}

export function defineServer<P extends PluginDefinition>(
  plugin: P,
  register: (ctx: ServerContext<P>) => void,
): ServerPart<P> {
  return { plugin, register };
}
