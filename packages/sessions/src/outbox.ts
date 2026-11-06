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

// plugin is null for what the kernel sends.
export type Unsent = Outgoing & {
  readonly sessionId: string;
  readonly plugin: string | null;
  readonly actor: Actor;
  readonly dedupe: string | null;
  readonly createdAt: number;
};

// One message for its Session's host, kept until the host acknowledges its
// seq, which grows in send order.
export type Queued = Unsent & {
  readonly seq: number;
  // A host's stream took it before, so it goes again as it is.
  readonly sent: boolean;
};

export interface OutboxStore {
  // False when a message with the same dedupe key waits, or a host took one
  // after keysSince.
  readonly add: (message: Unsent, keysSince: number) => boolean;
  readonly after: (sessionId: string, seq: number) => Queued | undefined;
  readonly sent: (seq: number, at: number) => void;
  readonly remove: (seq: number) => void;
  // The host took everything up to seq, at `at`.
  readonly acked: (sessionId: string, seq: number, at: number) => void;
  readonly removeAll: (sessionId: string) => readonly Queued[];
  readonly sessions: () => readonly string[];
}

export type Delivery =
  "sent" | "waits" | "not_found" | "archived" | "stale_generation";

// How long the dedupe key of a message a host took still holds.
const keepKeysMs = 24 * 60 * 60 * 1000;

export class Outbox {
  readonly #store: OutboxStore;
  readonly #deliver: (message: Queued) => Delivery;
  readonly #clock: Clock;
  readonly #log: Log;
  readonly #flushing = new Set<string>();
  // The last seq written to each Session's current stream.
  readonly #written = new Map<string, number>();

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
    const now = this.#clock.now();

    const added = this.#store.add(
      {
        ...outgoing,
        sessionId,
        plugin: plugin ?? null,
        dedupe: dedupe ?? null,
        createdAt: now,
      },
      now - keepKeysMs,
    );

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

    const next = (): Queued | undefined =>
      this.#store.after(sessionId, this.#written.get(sessionId) ?? 0);

    try {
      for (let message = next(); message !== undefined; message = next()) {
        const delivery = this.#deliver(message);

        if (delivery === "waits") {
          return;
        }

        if (delivery === "sent") {
          this.#written.set(sessionId, message.seq);

          if (!message.sent) {
            this.#store.sent(message.seq, this.#clock.now());
          }

          continue;
        }

        this.#store.remove(message.seq);
        this.#dropped(message, delivery);
      }
    } finally {
      this.#flushing.delete(sessionId);
    }
  }

  // A new stream gets again what its host hasn't acknowledged.
  attached(sessionId: string, acked: number | undefined): void {
    if (acked !== undefined) {
      this.ack(sessionId, acked);
    }

    this.#written.delete(sessionId);
    this.flush(sessionId);
  }

  ack(sessionId: string, seq: number): void {
    this.#store.acked(sessionId, seq, this.#clock.now());
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

  // One a host took before is no loss.
  #dropped(message: Queued, reason: string): void {
    if (message.sent) {
      return;
    }

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
