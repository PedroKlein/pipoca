import type {
  AgentSession,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import type { Clock, Log } from "@pipoca/protocol";
import type { Static, TSchema } from "typebox";
import type { TypedClient } from "./client";
import type { PluginDefinition } from "./definition";
import type { ToolOutput } from "./server";
import type {
  AskPermission,
  AskQuestions,
  Checkout,
  ChildOptions,
} from "./plugin";

export interface SessionToolCall {
  readonly id: string;
  readonly signal: AbortSignal | undefined;
}

export interface SessionTool<Pm extends TSchema = TSchema> {
  readonly name: string;
  readonly label?: string;
  readonly description: string;
  readonly params: Pm;
  // The question to ask the person before it runs, or undefined to run
  // without asking.
  readonly asks?: (
    input: Static<Pm>,
  ) => string | undefined | Promise<string | undefined>;
  readonly annotations?: {
    readonly readOnly?: boolean;
    readonly destructive?: boolean;
  };
  readonly exposure?: "direct" | "deferred";
  // A user's own tool of this name wins.
  readonly replaceable?: boolean;
  readonly run: (
    input: Static<Pm>,
    call: SessionToolCall,
  ) => ToolOutput | Promise<ToolOutput>;
}

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
  readonly publish: (
    key: string,
    data: unknown,
    o?: { readonly waiting?: boolean },
  ) => void;
  readonly askQuestions: AskQuestions;
  readonly askPermission: AskPermission;
  readonly checkouts: readonly Checkout[];
  readonly startChild: (o: ChildOptions) => Promise<AgentSession>;
  readonly clock: Clock;
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
