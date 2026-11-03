import { call, SlackRefused } from "./slack";

const firstRetryMs = 1_000;
const longestRetryMs = 60_000;

export interface Connection {
  readonly connected: () => boolean;
  readonly error: () => string | null;
  readonly close: () => void;
}

// Socket Mode: the server opens a WebSocket to Slack, so Slack needs no
// public URL to reach it (ADR 0062). Every envelope is acknowledged, and a
// dropped connection is opened again, waiting longer each time it fails.
export function connect(
  api: string,
  appToken: string,
  onEvent: (event: Readonly<Record<string, unknown>>) => void,
  log: (message: string, fields?: Readonly<Record<string, unknown>>) => void,
): Connection {
  let socket: WebSocket | undefined;
  let open = false;
  let closed = false;
  let error: string | null = null;
  let retryMs = firstRetryMs;
  let retry: ReturnType<typeof setTimeout> | undefined;

  const again = (): void => {
    open = false;

    if (closed) {
      return;
    }

    retry = setTimeout(start, retryMs);
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
      onEvent(event as Readonly<Record<string, unknown>>);
    }
  };

  function start(): void {
    call(api, appToken, "apps.connections.open").then(
      ({ url }) => {
        if (closed || typeof url !== "string") {
          return;
        }

        socket = new WebSocket(url);

        socket.addEventListener("message", ({ data }) => {
          try {
            received(data);
          } catch (failure) {
            log("couldn't read a message from Slack", {
              error: String(failure),
            });
          }
        });

        socket.addEventListener("close", again);
      },
      (failure: unknown) => {
        error =
          failure instanceof SlackRefused ? failure.message : String(failure);

        log("couldn't connect to Slack", { error });
        again();
      },
    );
  }

  start();

  return {
    connected: () => open,
    error: () => error,
    close: () => {
      closed = true;
      clearTimeout(retry);
      socket?.close();
    },
  };
}
