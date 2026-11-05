import type { Log, Owner } from "@pipoca/protocol";
import { Value } from "typebox/value";
import type { EventDef, PluginDefinition } from "./definition";
import { owners } from "./owners";
import type { KernelEvent, PluginEvent } from "./plugin";
import type { PluginEvents } from "./server";

type AnyEvent = KernelEvent | PluginEvent;

type EventOf<T extends string> = T extends KernelEvent["type"]
  ? Extract<KernelEvent, { type: T }>
  : PluginEvent;

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
  readonly publish: (event: AnyEvent) => void;
  readonly subscribe: <T extends AnyEvent["type"]>(
    type: T,
    listener: (event: EventOf<T>) => void,
  ) => () => void;
}

export interface TypedBus extends EventBus {
  readonly emit: (event: Emitted) => void;
  readonly on: (type: string, listener: (event: Heard) => void) => () => void;
}

export function eventBus(
  onError: (type: string, error: unknown) => void,
): TypedBus {
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

  const on = (type: string, listener: (event: Heard) => void): (() => void) => {
    const forType = listeners.get(type) ?? new Set();
    listeners.set(type, forType);
    forType.add(listener);

    return () => {
      forType.delete(listener);
    };
  };

  return {
    publish: (event) => {
      deliver(heard(event));
    },
    emit: deliver,
    subscribe: (type, listener) =>
      on(type, (event) => {
        (listener as (event: AnyEvent) => void)(v1(event));
      }),
    on,
  };
}

function heard(event: AnyEvent): Heard {
  if (!isPlugin(event)) {
    return {
      ...event,
      to:
        "session" in event
          ? [event.session.ownedBy]
          : [owners.of(event.invitedBy.id)],
    };
  }

  const { type, userId, userIds, ...fields } = event;
  const ids = Array.isArray(userIds) ? userIds : [userId];

  return {
    type,
    plugin: type.slice(0, type.indexOf(".")),
    fields,
    to: ids.flatMap((id) =>
      typeof id !== "string" ? [] : [id === "team" ? "team" : owners.of(id)],
    ),
  };
}

function v1(event: Heard): AnyEvent {
  if (!("fields" in event)) {
    const { to: _to, ...kernel } = event;

    return kernel;
  }

  return {
    type: event.type,
    ...event.fields,
    ...(event.to.length > 0 && {
      userIds: event.to.map((owner) => owners.personId(owner) ?? "team"),
    }),
  };
}

function isPlugin(event: AnyEvent): event is PluginEvent {
  return event.type.includes(".");
}

export function pluginEvents<P extends PluginDefinition>(
  bus: TypedBus,
  plugin: P,
  known: readonly PluginDefinition[],
  listening: (stop: () => void) => void,
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
    on: (what: string | EventDef, fn: (event: never) => void) => {
      const type = typeof what === "string" ? what : typeOf(known, what);

      if (type === undefined) {
        return;
      }

      listening(
        bus.on(type, (event) => {
          try {
            (fn as (heard: Heard) => void)(event);
          } catch (error) {
            log("event listener failed", { type, error: String(error) });
          }
        }),
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
