import type { Network } from "@pipoca/plugins";
import type { Log } from "@pipoca/protocol";
import { call, SlackRefused } from "./slack";

const firstRetryMs = 1_000;
const longestRetryMs = 60_000;

export interface Connection {
  readonly connected: () => boolean;
  readonly error: () => string | null;
  // Opens it again once the wait retryIn asked for is over.
  readonly reopen: () => void;
  readonly close: () => void;
}

// Socket Mode: the server opens a WebSocket to Slack, so Slack needs no
// public URL to reach it (ADR 0062). Every envelope is acknowledged, and a
// dropped connection is opened again, waiting longer each time it fails.
export function connect(
  api: string,
  appToken: string,
  o: {
    readonly fetch: Network["fetch"];
    readonly onEvent: (event: Readonly<Record<string, unknown>>) => void;
    readonly retryIn: (ms: number) => void;
    readonly log: Log;
  },
): Connection {
  let socket: WebSocket | undefined;
  let open = false;
  let closed = false;
  let waiting = false;
  let error: string | null = null;
  let retryMs = firstRetryMs;

  const again = (): void => {
    open = false;

    if (closed) {
      return;
    }

    waiting = true;
    o.retryIn(retryMs);
    retryMs = Math.min(retryMs * 2, longestRetryMs);
  };

  const received = (data: unknown): void => {
    const envelope = JSON.parse(String(data)) as {
      envelope_id?: unknown;
      type?: unknown;
      payload?: { event?: unknown };
    };

    if (typeof envelope.envelope_id === "string") {
      socket?.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
    }

    if (envelope.type === "hello") {
      open = true;
      error = null;
      retryMs = firstRetryMs;
    }

    if (envelope.type === "disconnect") {
      socket?.close();
    }

    const event = envelope.payload?.event;

    if (envelope.type === "events_api" && typeof event === "object") {
      o.onEvent(event as Readonly<Record<string, unknown>>);
    }
  };

  const start = (): void => {
    call(o.fetch, api, appToken, "apps.connections.open").then(
      ({ url }) => {
        if (closed || typeof url !== "string") {
          return;
        }

        socket = new WebSocket(url);

        socket.addEventListener("message", ({ data }) => {
          try {
            received(data);
          } catch (failure) {
            o.log("couldn't read a message from Slack", {
              error: String(failure),
            });
          }
        });

        socket.addEventListener("close", again);
      },
      (failure: unknown) => {
        error =
          failure instanceof SlackRefused ? failure.message : String(failure);

        o.log("couldn't connect to Slack", { error });
        again();
      },
    );
  };

  start();

  return {
    connected: () => open,
    error: () => error,
    reopen: () => {
      if (waiting && !closed) {
        waiting = false;
        start();
      }
    },
    close: () => {
      closed = true;
      socket?.close();
    },
  };
}
