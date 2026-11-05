import type { DeclaredEvent, Owner } from "@pipoca/protocol";
import type { Static, TObject } from "typebox";
import type { EventDef, Events, PluginDefinition } from "./definition";
import type { KernelEventOf } from "./events";
import type { KernelEvent, ServerPlugin, ServerPluginContext } from "./plugin";

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

export type ServerContext<P extends PluginDefinition> = Omit<
  ServerPluginContext,
  "events"
> & {
  readonly id: P["id"];
  readonly events: ServerPluginContext["events"] & PluginEvents<P>;
  readonly people: People;
  readonly transcript: Transcript;
};

export function defineServer<const P extends PluginDefinition>(
  plugin: P,
  register: (context: ServerContext<P>) => void,
): ServerPlugin {
  return {
    name: plugin.id,
    ...(plugin.schema !== undefined && { schema: plugin.schema }),
    definition: plugin,
    register: (context) => {
      register(context as unknown as ServerContext<P>);
    },
  };
}
