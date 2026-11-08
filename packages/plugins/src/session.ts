import type {
  AgentSession,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import type { CredentialStore } from "@earendil-works/pi-ai";
import type {
  Clock,
  Log,
  Permission,
  PermissionDetail,
  Question,
  QuestionsAnswer,
  ThinkingLevel,
  Timer,
} from "@pipoca/protocol";
import type { Static, TSchema } from "typebox";
import type { SessionBlobs } from "./blobs";
import type { TypedClient } from "./client";
import type { PluginDefinition } from "./definition";
import type { ToolDef } from "./server";

export type Explain = (
  questionId: string,
  value: string,
  question: string | null,
) => Promise<string>;

export type AskQuestions = (
  questions: readonly Question[],
  explain: Explain | undefined,
  signal: AbortSignal | undefined,
  // In team work, the name of the person the questions are for.
  person?: string,
) => Promise<QuestionsAnswer | null>;

// Asks the user whether a tool call may run, and resolves to "deny" when the
// prompt goes away unanswered.
export type AskPermission = (
  title: string,
  details: readonly PermissionDetail[],
  signal: AbortSignal | undefined,
) => Promise<Permission>;

// A git checkout in the Session's workspace, and the commit its session
// branch started from when it has one.
export interface Checkout {
  readonly path: string;
  readonly base: string | null;
}

export interface ChildOptions {
  // Names or patterns of tools the Session's Profile gives: Pi's own, an
  // extension's, or an MCP server's, such as "mcp__jira__*".
  readonly tools: readonly string[];
  // The Profile's MCP servers whose tools the child gets, by name.
  readonly mcp?: readonly string[];
  // The Profile's skills the child sees, by name. None when left out.
  readonly skills?: readonly string[];
  // As Pi's --model takes it, such as "anthropic/claude-sonnet-4-5". The
  // Session's current model when left out.
  readonly model?: string;
  readonly thinking?: ThinkingLevel;
  // Added to Pi's system prompt.
  readonly systemPrompt?: string;
  // A child's session file to carry on from, when it is still there.
  readonly continueFrom?: string;
}

export interface SessionLogins {
  readonly models: CredentialStore;
  readonly mcp: McpLoginStore;
}

// What Pi's MCP extension asks of its sign-in store, which Pi keeps in
// mcp-auth.json by default. Its calls don't wait, except a token refresh,
// which runs while no other process refreshes the same server.
export interface McpLoginStore {
  readonly forServer: (
    name: string,
    serverUrl: string,
  ) => {
    readonly load: () => McpLoginState | undefined;
    readonly save: (state: McpLoginState) => void;
    readonly withRefreshLock: <T>(fn: () => Promise<T>) => Promise<T>;
  };
  readonly tokens: (name: string, serverUrl: string) => unknown;
  readonly remove: (name: string, serverUrl: string) => boolean;
}

// One MCP server's client registration and tokens, as Pi keeps them.
export interface McpLoginState {
  readonly tokens?: unknown;
  readonly [field: string]: unknown;
}

export interface SessionToolCall {
  readonly id: string;
  readonly signal: AbortSignal | undefined;
  // Pi's working directory, where a tool reads and writes the workspace.
  readonly cwd: string;
  // Asks the Session's model one question outside its conversation, such as
  // to explain an option. Undefined while the Session has no model.
  readonly complete?: (o: {
    readonly system: string;
    readonly prompt: string;
  }) => Promise<string>;
}

export type SessionTool<Pm extends TSchema = TSchema> = ToolDef<
  Pm,
  SessionToolCall
>;

export type ConfigValue<P extends PluginDefinition> = [P["config"]] extends [
  TSchema,
]
  ? Static<NonNullable<P["config"]>>
  : Readonly<Record<string, never>>;

export interface SessionContext<P extends PluginDefinition = PluginDefinition> {
  readonly tools: {
    readonly define: <Pm extends TSchema>(tool: SessionTool<Pm>) => void;
  };
  readonly extension: (factory: ExtensionFactory) => void;
  // The plugin's config when the Session started, without its secrets.
  readonly config: ConfigValue<P>;
  readonly api: TypedClient;
  // Uploads to the plugin's blob store, once its server part accepts them.
  readonly blobs: SessionBlobs;
  readonly publish: (
    key: string,
    data: unknown,
    o?: { readonly waiting?: boolean },
  ) => void;
  readonly askQuestions: AskQuestions;
  readonly askPermission: AskPermission;
  readonly checkouts: readonly Checkout[];
  readonly startChild: (o: ChildOptions) => Promise<AgentSession>;
  readonly provide: {
    // Where the Session keeps its model and MCP logins in place of the
    // runner's files, such as on the server (ADR 0045). One plugin per
    // server gives them; without one, Pi uses the runner's own.
    readonly modelCredentials: (logins: () => Promise<SessionLogins>) => void;
  };
  readonly clock: Clock;
  // Waits that end with the Session, such as a retry, since a Session part
  // has no durable schedule.
  readonly timer: Timer;
  readonly log: Log;
}

export interface SessionPart<P extends PluginDefinition = PluginDefinition> {
  readonly plugin: P;
  readonly setup: (s: SessionContext<P>) => void | Promise<void>;
}

export function defineSession<P extends PluginDefinition>(
  plugin: P,
  setup: (s: SessionContext<P>) => void | Promise<void>,
): SessionPart<P> {
  return { plugin, setup };
}
