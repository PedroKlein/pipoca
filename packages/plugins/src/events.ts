import type { Actor, Log, Owner, Session } from "@pipoca/protocol";
import { Value } from "typebox/value";
import type { EventDef, PluginDefinition } from "./definition";
import { owners } from "./owners";
import type { PluginEvents } from "./server";

export type KernelEvent =
  | {
      readonly type: "SessionCreated";
      readonly session: Session;
      readonly actor: Actor;
    }
  | {
      readonly type: "SessionStateChanged";
      readonly session: Session;
      readonly previous: Session["status"];
    }
  // Pi asked a question and waits for a person to answer it, in team work
  // maybe a named one.
  | {
      readonly type: "SessionWaiting";
      readonly session: Session;
      readonly for?: string;
    }
  | { readonly type: "TurnStarted"; readonly session: Session }
  | {
      readonly type: "TurnEnded";
      readonly session: Session;
      // How many transcript lines the turn ended with, when the Session's
      // host says. The transcript upload can still be behind it.
      readonly transcriptLength?: number;
    }
  // The actor is the person who asked, and absent when a plugin did.
  | {
      readonly type: "SessionArchived";
      readonly session: Session;
      readonly actor?: Actor;
    }
  | {
      readonly type: "SessionUnarchived";
      readonly session: Session;
      readonly actor?: Actor;
      // When the Session was archived.
      readonly archivedAt: string;
    }
  // Someone moved personal work to the team, which started this Session.
  | {
      readonly type: "SessionMoved";
      readonly session: Session;
      readonly from: string;
      readonly actor: Actor;
    }
  // Whoever started team work, or an admin, changed who steers it.
  | {
      readonly type: "AccessChanged";
      readonly session: Session;
      readonly actor: Actor;
    }
  // Someone asked Pi to stop the turn it is on.
  | {
      readonly type: "StopAsked";
      readonly session: Session;
      readonly actor: Actor;
    }
  | {
      readonly type: "ToolCalled";
      readonly session: Session;
      readonly tool: string;
      readonly actor: Actor;
    }
  // An admin invited someone by email, whose link works once (ADR 0063).
  | {
      readonly type: "PersonInvited";
      readonly email: string;
      readonly link: string;
      readonly invitedBy: { readonly id: string; readonly name: string };
      readonly admin: boolean;
      readonly expiresAt: string;
    };

export type KernelEventOf<T extends KernelEvent["type"]> = Extract<
  KernelEvent,
  { type: T }
> & { readonly to: readonly Owner[] };

export interface Emitted {
  readonly type: `${string}.${string}`;
  readonly plugin: string;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly to: readonly Owner[];
}

type Heard = KernelEventOf<KernelEvent["type"]> | Emitted;

export interface EventBus {
  readonly publish: (event: KernelEvent) => void;
  readonly emit: (event: Emitted) => void;
  readonly on: (type: string, listener: (event: Heard) => void) => () => void;
}

export function eventBus(
  onError: (type: string, error: unknown) => void,
): EventBus {
  const listeners = new Map<string, Set<(event: Heard) => void>>();

  const deliver = (event: Heard): void => {
    for (const listener of listeners.get(event.type) ?? []) {
      try {
        listener(event);
      } catch (error) {
        onError(event.type, error);
      }
    }
  };

  return {
    publish: (event) => {
      deliver({
        ...event,
        to:
          "session" in event
            ? [event.session.ownedBy]
            : [owners.of(event.invitedBy.id)],
      });
    },
    emit: deliver,
    on: (type, listener) => {
      const forType = listeners.get(type) ?? new Set();
      listeners.set(type, forType);
      forType.add(listener);

      return () => {
        forType.delete(listener);
      };
    },
  };
}

export function pluginEvents<P extends PluginDefinition>(
  bus: EventBus,
  plugin: P,
  known: readonly PluginDefinition[],
  // Hears of each listener added, with the type it listens to.
  listening: (stop: () => void, type: string) => void,
  log: Log,
): Pick<PluginEvents<P>, "emit" | "on"> {
  return {
    emit: (name, fields, { to }) => {
      const def = plugin.events?.[name];

      if (def === undefined) {
        throw new Error(`${plugin.id} defines no event ${name}`);
      }

      const [misfit] = Value.Errors(def.fields, fields);

      if (misfit !== undefined) {
        throw new Error(
          `${plugin.id}.${name} ${misfit.instancePath.slice(1) || "fields"} ${misfit.message}`,
        );
      }

      bus.emit({ type: `${plugin.id}.${name}`, plugin: plugin.id, fields, to });
    },
    on: (
      what: string | EventDef,
      fn: (event: never) => void | Promise<void>,
    ) => {
      const type = typeof what === "string" ? what : typeOf(known, what);

      if (type === undefined) {
        return;
      }

      listening(
        bus.on(type, (event) => {
          const failed = (error: unknown): void => {
            log("event listener failed", { type, error: String(error) });
          };

          try {
            const heard = (fn as (heard: Heard) => void | Promise<void>)(event);

            if (heard instanceof Promise) {
              heard.catch(failed);
            }
          } catch (error) {
            failed(error);
          }
        }),
        type,
      );
    },
  };
}

function typeOf(
  known: readonly PluginDefinition[],
  def: EventDef,
): string | undefined {
  for (const { id, events = {} } of known) {
    const name = Object.keys(events).find((each) => events[each] === def);

    if (name !== undefined) {
      return `${id}.${name}`;
    }
  }

  return undefined;
}
