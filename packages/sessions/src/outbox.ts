import type { Actor, Clock, Log, ToolResult } from "@pipoca/protocol";

export type Outgoing =
  | { readonly kind: "message" | "context"; readonly text: string }
  | {
      readonly kind: "notice";
      readonly text: string;
      readonly notice: { readonly kind: string; readonly data?: unknown };
      readonly turn: boolean;
    }
  | {
      readonly kind: "tool_result";
      readonly generation: number;
      readonly call: string;
      readonly result: ToolResult;
    };

// One message waiting for its Session's host. plugin is null for what the
// kernel sends.
export type Queued = Outgoing & {
  readonly id: string;
  readonly sessionId: string;
  readonly plugin: string | null;
  readonly actor: Actor;
  readonly dedupe: string | null;
  readonly createdAt: number;
};

export interface OutboxStore {
  // False when a queued message has the same dedupe key.
  readonly add: (message: Queued) => boolean;
  readonly first: (sessionId: string) => Queued | undefined;
  readonly remove: (id: string) => void;
  readonly removeAll: (sessionId: string) => readonly Queued[];
  readonly sessions: () => readonly string[];
}

export type Delivery =
  "sent" | "waits" | "not_found" | "archived" | "stale_generation";

export class Outbox {
  readonly #store: OutboxStore;
  readonly #deliver: (message: Queued) => Delivery;
  readonly #clock: Clock;
  readonly #log: Log;
  readonly #flushing = new Set<string>();

  constructor(
    store: OutboxStore,
    deliver: (message: Queued) => Delivery,
    clock: Clock,
    log: Log,
  ) {
    this.#store = store;
    this.#deliver = deliver;
    this.#clock = clock;
    this.#log = log;
  }

  enqueue(
    sessionId: string,
    message: Outgoing & {
      readonly plugin?: string;
      readonly actor: Actor;
      readonly dedupe?: string;
    },
  ): void {
    const { plugin, dedupe, ...outgoing } = message;

    const added = this.#store.add({
      ...outgoing,
      id: Bun.randomUUIDv7(),
      sessionId,
      plugin: plugin ?? null,
      dedupe: dedupe ?? null,
      createdAt: this.#clock.now(),
    });

    if (added) {
      this.flush(sessionId);
    }
  }

  // In send order, until the first one the Session can't take yet.
  flush(sessionId: string): void {
    if (this.#flushing.has(sessionId)) {
      return;
    }

    this.#flushing.add(sessionId);

    try {
      for (
        let next = this.#store.first(sessionId);
        next !== undefined;
        next = this.#store.first(sessionId)
      ) {
        const delivery = this.#deliver(next);

        if (delivery === "waits") {
          return;
        }

        this.#store.remove(next.id);

        if (delivery !== "sent") {
          this.#dropped(next, delivery);
        }
      }
    } finally {
      this.#flushing.delete(sessionId);
    }
  }

  flushAll(): void {
    for (const sessionId of this.#store.sessions()) {
      this.flush(sessionId);
    }
  }

  drop(sessionId: string, reason: Exclude<Delivery, "sent" | "waits">): void {
    for (const message of this.#store.removeAll(sessionId)) {
      this.#dropped(message, reason);
    }
  }

  #dropped(message: Queued, reason: string): void {
    this.#log("message to a Session dropped", {
      sessionId: message.sessionId,
      plugin: message.plugin,
      kind: message.kind,
      ...(message.kind === "tool_result" && {
        generation: message.generation,
        callId: message.call,
      }),
      reason,
    });
  }
}
