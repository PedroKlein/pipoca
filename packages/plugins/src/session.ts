import type {
  AgentSession,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import type { Clock, Log, Timer } from "@pipoca/protocol";
import type { Static, TSchema } from "typebox";
import type { TypedClient } from "./client";
import type { PluginDefinition } from "./definition";
import type { ToolDef } from "./server";
import type {
  AskPermission,
  AskQuestions,
  Checkout,
  ChildOptions,
} from "./plugin";

export interface SessionToolCall {
  readonly id: string;
  readonly signal: AbortSignal | undefined;
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
