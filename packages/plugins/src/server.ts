import type {
  ActsAs,
  Actor,
  Clock,
  CreateSession,
  DeclaredAction,
  DeclaredCheck,
  DeclaredDestination,
  DeclaredEvent,
  EnvironmentTemplate,
  Environment,
  GitLogin,
  Log,
  Method,
  ModelRef,
  Owner,
  ProfileContent,
  RegisteredProvider,
  RouteToolSpec,
  Session,
  SessionAccess,
  StartAgent,
  Timer,
  ToolResult,
} from "@pipoca/protocol";
import type { Static, TObject, TSchema } from "typebox";
import type { EventDef, Events, PluginDefinition } from "./definition";
import type { KernelEvent, KernelEventOf } from "./events";
import type {
  QuestionDesk,
  QuestionKeeper,
  Questions,
  ReplyPlace,
} from "./questions";
import type { Schedule } from "./schedule";
import type { Transcript } from "./transcript";

export type { ToolResultEntry, Transcript } from "./transcript";

export type StartRequest = CreateSession & {
  readonly actor: Actor;
  // The identity a plugin's gitCredentials resolve for its git, such as a
  // technical user (ADR 0060). Only plugins start Sessions acting as one.
  readonly actsAs?: ActsAs;
  // Only plugins start a Session that proposes what it writes outside
  // instead of writing it (ADR 0076).
  readonly proposes?: boolean;
  // Who steers team work from the start, such as only the person whose
  // Team assistant it is (ADR 0067).
  readonly access?: SessionAccess;
  // Only plugins start a Session as a named agent, such as a routine's.
  readonly agent?: StartAgent;
  // Only plugins name a Session as it starts, such as a thread after its
  // title, so the first message doesn't name it.
  readonly title?: string;
};

// What decides where an Environment's runners come from (ADR 0049).
export type RunnerSource = Pick<Environment, "id" | "templateId">;

export type SqlValue = string | number | bigint | null | Uint8Array;

export interface ProfileMcpServer {
  readonly name: string;
  readonly config: unknown;
}

// A read-only Profile a plugin ships for the Sessions it owns, such as the
// meta Profile (ADR 0035). Users don't list or edit it.
export interface PluginProfile extends Omit<ProfileContent, "off"> {
  readonly name: string;
}

// Models a plugin offers for an Environment: listed before the machine's own
// in model fields, and a default for Sessions that name none.
export interface OfferedModels {
  readonly models: readonly ModelRef[];
  readonly default?: ModelRef;
  // `provider/id` of models the pickers leave out, such as ones an admin hid.
  readonly hidden?: readonly string[];
}

// The user is the one who looks at the models, when there is one, such as
// models their own logins reach.
export type ModelOffer = (
  environment: RunnerSource & Pick<Environment, "ownerId">,
  userId?: string,
) => OfferedModels;

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
      fn: (event: KernelEventOf<T>) => void | Promise<void>,
    ): void;
    <F extends TObject>(
      def: EventDef<F>,
      fn: (event: {
        readonly fields: Static<F>;
        readonly to: readonly Owner[];
        readonly plugin: string;
      }) => void | Promise<void>,
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
      }) => void | Promise<void>,
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

interface RouteInput<
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
  // Ties a flow such as an OAuth state to the browser that starts it, so a
  // link can't finish it in another (RFC 6749, 10.12). mark gives the
  // response's browser a cookie for ttlMs, which comes back on a redirect
  // from another site, and returns what to keep with the state.
  readonly browser: {
    readonly mark: (response: Response, ttlMs: number) => string;
    readonly is: (request: Request, kept: string) => boolean;
  };
}

export interface ToolCall {
  readonly session: Session;
  readonly person?: Person;
  readonly owner: Owner;
}

export type ToolOutput =
  | string
  | {
      readonly text: string;
      readonly details?: unknown;
      // Pi stops after the tool's batch, such as once a question waits
      // for its answer as a message.
      readonly endsTurn?: boolean;
    };

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
    // It writes outside Pipoca, such as a Slack post. A Session that
    // proposes doesn't get it unless it is read only (ADR 0076).
    readonly openWorld?: boolean;
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
  // Whether the person may act in it, such as by sending it a message.
  readonly steers: (id: string, person: string) => boolean;
  readonly send: (
    id: string,
    message: {
      readonly text: string;
      readonly turn: boolean;
      readonly as?: Actor;
      readonly notice?: { readonly kind: string; readonly data?: unknown };
      // A repeat with the key of a message queued for the Session, or
      // delivered in the last day, is a no-op.
      readonly dedupe?: string;
    },
  ) => "queued" | "gone";
  // A key of the plugin's own, such as a mail thread, names one Session.
  readonly bind: (key: string, sessionId: string) => void;
  readonly boundTo: (key: string) => string | undefined;
  // Makes the Session wait for a person, as a prompt does, for something
  // the plugin keeps itself by key, until null clears it. for names the
  // person, in team work.
  readonly need: (
    id: string,
    key: string,
    need: { readonly for?: string } | null,
  ) => void;
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
    fn: (
      next: ConfigValue<P>,
      previous: ConfigValue<P>,
    ) => void | Promise<void>,
  ) => void;
  readonly lockedIn: () => string | undefined;
  readonly collection: <K extends CollectionKeys<ConfigValue<P>>>(
    name: K,
  ) => Collection<ItemOf<ConfigValue<P>, K>>;
  readonly dir: string;
}

export interface PluginEnvironments {
  readonly list: () => readonly Environment[];
  readonly get: (id: string) => Environment | undefined;
  readonly templates: () => readonly EnvironmentTemplate[];
  // The plugin's key in a template's entry in pipoca.json, such as its pod
  // settings, with the schema's defaults filled. A key that doesn't fit is
  // logged and read as none; set throws when the value doesn't fit or no
  // template has the id.
  readonly templateConfig: <const S extends TSchema>(
    schema: S,
  ) => TemplateConfig<Static<S>>;
}

interface TemplateConfig<T> {
  readonly get: (templateId: string) => T | undefined;
  readonly set: (templateId: string, value: unknown) => T | undefined;
}

// What a plugin that starts runners does with them.
export interface Runners {
  // Sessions no online runner in the pool can take now: queued ones beyond
  // the room its runners have, and ones held by a runner that went away.
  readonly unplaced: (environmentId: string) => readonly Session[];
  // The token a runner the plugin starts polls with. It lasts until revoked,
  // and a new Environment key leaves it be.
  readonly token: (environmentId: string, runner: string) => string;
  readonly revoke: (environmentId: string, runner: string) => void;
}

// The plugin that starts runners for an Environment when its Sessions need
// one, such as pods in a cluster.
export interface RunnerProvider {
  // What the Environments page calls its runners, and an icon of @pipoca/ui.
  // choice is how server setup offers a template whose runners it starts,
  // such as "A pod for each person".
  readonly kind: {
    readonly label: string;
    readonly icon: string;
    readonly choice?: string;
  };
  readonly starts: (environment: RunnerSource) => boolean;
  // The server then runs no runner of its own, such as in a cluster where
  // its Sessions would share the server's files.
  readonly replacesServerRunner?: boolean;
}

// What a plugin needs to start runners on the server's own machine. Read it
// once the server listens, such as when a runner starts.
export interface Runtime {
  // Runs the pipoca binary, which runs a runner as `agent`.
  readonly command: readonly string[];
  readonly serverUrl: string;
  readonly dataDir: string;
  // The Environment a new solo install made for this machine, and the
  // folders it was started with.
  readonly solo?: {
    readonly environmentId: string;
    readonly folders: readonly string[];
  };
}

// The links the sign-in page shows beside the password form, each a path
// under the plugin's routes, asked for each time the page loads.
export interface SignInProvider {
  readonly logins: () => readonly {
    readonly label: string;
    readonly path: string;
  }[];
}

// What a sign-in provider's routes do once their own checks pass.
export interface SignInApi {
  // A person who signs in only through the plugin, or undefined when the
  // name is taken.
  readonly create: (name: string, admin: boolean) => Person | undefined;
  readonly setAdmin: (personId: string, admin: boolean) => void;
  // The invite that lets someone in past the plugin's own rules: the one
  // whose link they followed, or else one for their verified email.
  readonly invited: (
    join: string | undefined,
    email: string | undefined,
  ) => { readonly id: string; readonly admin: boolean } | undefined;
  readonly acceptInvite: (id: string) => void;
  readonly passwordLogin: () => boolean;
  // The Set-Cookie value of a new browser session, or undefined when no one
  // has the id.
  readonly startSession: (
    personId: string,
    request: Request,
  ) => string | undefined;
}

// What Profiles hold that a plugin reads, such as the MCP servers people
// sign in to.
interface PluginProfiles {
  // Every MCP server of the base, the person's My defaults and the
  // Profiles they see.
  readonly mcpServers: (personId: string) => readonly ProfileMcpServer[];
  // The Profiles one builds on, nearest first.
  readonly buildsOn: (profileId: string) => readonly string[];
  // The model providers the base Profile's packages register, as the
  // server last listed them with no logins (ADR 0044).
  readonly baseProviders: () => readonly RegisteredProvider[];
  // A Profile's files with every layer under it, as text by path, when the
  // person sees it. Team work sees only team Profiles.
  readonly stacked: (
    personId: string,
    profileId: string,
    team: boolean,
  ) => Readonly<Record<string, string>> | undefined;
  // Writes files into a Profile the person may change, or throws why not.
  readonly write: (
    personId: string,
    profileId: string,
    team: boolean,
    files: Readonly<Record<string, string>>,
  ) => void;
}

// A run that applies a proposal: its Session, whose identity the action
// writes as (ADR 0060), and for a pull request, a git bundle of the commits
// on its workspace branch.
export interface ActionCall {
  readonly session: Session;
  readonly commits?: Uint8Array;
}

// What the action wrote, in a line, and where it is, such as a pull
// request's address.
export interface Applied {
  readonly text: string;
  readonly url?: string;
}

type ActionsOf<P extends PluginDefinition> = Exclude<P["actions"], undefined>;

// A plugin's handlers by its actions' names, each given its own input. A
// plugin known only as PluginDefinition takes any.
export type ActionHandlers<P extends PluginDefinition> =
  string extends keyof ActionsOf<P>
    ? Readonly<
        Record<string, (input: never, call: ActionCall) => Promise<Applied>>
      >
    : {
        readonly [N in keyof ActionsOf<P>]: (
          input: Static<ActionsOf<P>[N]["input"]>,
          call: ActionCall,
        ) => Promise<Applied>;
      };

// Every enabled plugin's actions, as a plugin that applies proposals reads
// them (ADR 0076).
export interface PluginActions {
  readonly declared: () => readonly DeclaredAction[];
  // Checks the input against the action's schema, then applies it.
  readonly apply: (
    type: string,
    input: unknown,
    call: ActionCall,
  ) => Promise<Applied>;
}

// A routine's run that ended, whose result a destination writes as the
// run's Session would (ADR 0075).
export interface Delivery {
  readonly session: Session;
  // The routine's title.
  readonly routine: string;
  readonly outcome: "done" | "nothing" | "blocked" | "failed" | "stopped";
  readonly summary: string;
  readonly output?: Readonly<Record<string, unknown>>;
  // The events the run was started with, oldest first.
  readonly events: readonly {
    readonly type: string;
    readonly fields: Readonly<Record<string, unknown>>;
  }[];
  // The result as plain text, ready to post.
  readonly text: string;
}

type DestinationsOf<P extends PluginDefinition> = Exclude<
  P["destinations"],
  undefined
>;

export type DestinationHandlers<P extends PluginDefinition> =
  string extends keyof DestinationsOf<P>
    ? Readonly<
        Record<
          string,
          (settings: never, delivery: Delivery) => Promise<Applied>
        >
      >
    : {
        readonly [N in keyof DestinationsOf<P>]: (
          settings: Static<DestinationsOf<P>[N]["settings"]>,
          delivery: Delivery,
        ) => Promise<Applied>;
      };

// Every enabled plugin's result destinations, as the plugin that delivers
// runs' results reads them (ADR 0075).
export interface PluginDestinations {
  readonly declared: () => readonly DeclaredDestination[];
  // Checks the settings against the destination's schema, then delivers.
  readonly deliver: (
    type: string,
    settings: unknown,
    delivery: Delivery,
  ) => Promise<Applied>;
}

// Every enabled plugin's named checks (ADR 0075).
export interface PluginChecks {
  readonly declared: () => readonly DeclaredCheck[];
}

export interface Providers<P extends PluginDefinition = PluginDefinition> {
  readonly runners: (provider: RunnerProvider) => Runners;
  readonly runtime: () => Runtime;
  readonly models: (offer: ModelOffer) => void;
  // One plugin per server signs people in without a password.
  readonly signIn: (provider: SignInProvider) => SignInApi;
  // The logins a Session's git and gh sign in with: its person's, the
  // team's, or for a Session that acts as one of this plugin's identities,
  // that identity's. Called as a runner takes the Session, so it can't wait.
  readonly gitCredentials: (
    of: (
      owner: Owner,
      session: Pick<Session, "actsAs" | "proposes" | "workspace">,
    ) => readonly GitLogin[],
  ) => void;
  // One plugin per server keeps the questions that wait for an answer as
  // a message (ADR 0076).
  readonly questions: (keeper: QuestionKeeper) => QuestionDesk;
  // How a plugin that publishes events posts a question back where one of
  // them came from, and so hears its answer there.
  readonly replies: (place: ReplyPlace) => void;
  // How the plugin applies each action its definition declares.
  // A method, so a plugin's own handlers fit where any plugin's are taken.
  actions(handlers: ActionHandlers<P>): void;
  // How the plugin delivers to each destination its definition declares.
  destinations(handlers: DestinationHandlers<P>): void;
  // Sessions on the Profile load every route tool when routeTools is true.
  readonly profile: (
    key: string,
    profile: PluginProfile,
    o?: { readonly team?: boolean; readonly routeTools?: boolean },
  ) => string;
}

export interface StoredBlob {
  readonly hash: string;
  readonly size: number;
}

// The plugin's bytes on the server's data volume, each named by its SHA-256
// (ADR 0078). The plugin keeps which hashes its rows use and removes a hash
// once none does.
export interface Blobs {
  readonly put: (bytes: Uint8Array) => Promise<StoredBlob>;
  readonly size: (hash: string) => Promise<number | undefined>;
  readonly read: (
    hash: string,
  ) => Promise<ReadableStream<Uint8Array> | undefined>;
  readonly bytes: (hash: string) => Promise<Uint8Array | undefined>;
  readonly remove: (hash: string) => Promise<void>;
  // What the plugin's blobs take and what's free on their volume, in bytes.
  readonly space: () => Promise<{
    readonly used: number;
    readonly free: number;
  }>;
  // Lets the plugin's Session part upload with s.blobs, and people's
  // browsers through the routes in blobRoutes, in chunks that
  // resume, up to maxBytes a file.
  readonly acceptUploads: (o: { readonly maxBytes: () => number }) => void;
}

export interface ServerContext<P extends PluginDefinition = PluginDefinition> {
  readonly id: P["id"];
  readonly people: People;
  readonly sessions: Sessions;
  readonly routes: Routes;
  readonly tools: ServerTools;
  readonly schedule: Schedule;
  readonly events: PluginEvents<P>;
  readonly questions: Questions;
  readonly config: PluginConfig<P>;
  readonly store: Store;
  readonly blobs: Blobs;
  readonly transcript: Transcript;
  readonly urls: Urls;
  readonly provide: Providers<P>;
  readonly actions: PluginActions;
  readonly destinations: PluginDestinations;
  readonly checks: PluginChecks;
  readonly secrets: Secrets;
  readonly environments: PluginEnvironments;
  readonly profiles: PluginProfiles;
  // A folder of the plugin's own with the server's data, for files it
  // writes as it works. It may not exist yet.
  readonly dataDir: string;
  readonly clock: Clock;
  // The server's environment variables, such as a chart sets.
  readonly env: (name: string) => string | undefined;
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
