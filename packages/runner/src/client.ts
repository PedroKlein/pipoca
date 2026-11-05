import { setTimeout as sleep } from "node:timers/promises";
import {
  type ApiArgs,
  apiClient,
  ApiError,
  type ApiInput,
  apiPath,
  type ApiReply,
  type JoinRequest,
  type RouteKey,
  type Joined,
  type SessionStart,
  type Command,
  type LiveEvent,
  type LivePost,
  type PreviewRequest,
  type ProfileFiles,
  type PreviewResponse,
  type RemovalPost,
  type StartFailure,
  type ToolCall,
  type TrustAnswer,
  protocolVersion,
  type TerminalControl,
  type TranscriptBatch,
  liveSurface,
  type Log,
  readSse,
  versionHeader,
} from "@pipoca/protocol";
import type {
  PreviewExchange,
  SessionStream,
  TerminalChannel,
  TerminalPeer,
} from "@pipoca/sessionhost";
import { backoff } from "./backoff";
import type { ControlPlane } from "./poll";

const reconnect = { initialMs: 500, maxMs: 20_000 };
const pollTimeoutMs = 30_000;
const requestTimeoutMs = 30_000;

// Only a terminal's last output is replayed (ADR 0026), so a socket this far
// behind the server is closed instead of buffered without bound. The built-in
// provider shares the server's event loop, where tens of MB can queue for a
// moment while everything is healthy, so the limit sits well above that.
const maxTerminalBufferedBytes = 64 * 1024 * 1024;

// A runner and a server of other protocol versions can't work together, so
// retrying never helps.
export class UnsupportedVersion extends Error {}

// The server refused the runner's name, which no retry changes (ADR 0032).
export class JoinRefused extends Error {}

// A runner's token, or one of its Sessions' (ADR 0033).
export interface Agent {
  readonly server: string;
  readonly token: string;
}

function agentHeaders(agent: Agent): Record<string, string> {
  return {
    [versionHeader]: String(protocolVersion),
    authorization: `Bearer ${agent.token}`,
  };
}

// Joins the pool of the Environment the key belongs to, waiting for a server
// that isn't up yet. A key the server refuses ends the wait, and so does the
// signal, with undefined.
export async function joinPool(
  server: string,
  key: string,
  request: JoinRequest,
  log: Log,
  signal: AbortSignal,
): Promise<Joined | undefined> {
  const retry = backoff(reconnect.initialMs, reconnect.maxMs);

  while (!signal.aborted) {
    try {
      return await call({ server, token: key }, "runner.join", {
        body: request,
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(requestTimeoutMs),
        ]),
      });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        throw new Error("the server refused the Environment key", {
          cause: error,
        });
      }

      if (error instanceof ApiError && error.status === 409) {
        throw new JoinRefused(error.message, { cause: error });
      }

      if (error instanceof UnsupportedVersion) {
        throw error;
      }

      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- the signal can abort while the call above is pending
      if (signal.aborted) {
        return undefined;
      }

      log("join failed", {
        error: String(error),
        retryInMs: retry.delayMs(),
      });
    }

    await retry.wait(signal);
  }

  return undefined;
}

// A call to the server as a runner or a Session host. A server of another
// protocol version answers none of them, in this version's words or in its
// own.
async function call<Key extends RouteKey>(
  agent: Agent,
  key: Key,
  ...input: ApiArgs<Key>
): Promise<ApiReply<Key>> {
  try {
    return await apiClient({
      server: agent.server,
      headers: agentHeaders(agent),
    })(key, ...input);
  } catch (error) {
    if (
      error instanceof ApiError &&
      error.status === 400 &&
      (error.code === "unsupported_version" ||
        error.code.startsWith("unsupported protocol version"))
    ) {
      throw new UnsupportedVersion(
        `the server at ${agent.server} doesn't speak this runner's protocol version ${String(protocolVersion)}; run the same Pipoca version on both`,
        { cause: error },
      );
    }

    throw error;
  }
}

export function httpControlPlane(
  agent: Agent,
  letGo: (reason?: UnsupportedVersion) => void,
): ControlPlane {
  return {
    work: async (poll, signal) => {
      try {
        return await call(agent, "runner.work", {
          body: poll,
          signal: AbortSignal.any([signal, AbortSignal.timeout(pollTimeoutMs)]),
        });
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          letGo();
        }

        if (error instanceof UnsupportedVersion) {
          letGo(error);
        }

        throw error;
      }
    },
  };
}

export async function reportStartFailure(
  agent: Agent,
  sessionId: string,
  failure: StartFailure,
): Promise<void> {
  await call(agent, "runner.startFailure", {
    params: { id: sessionId },
    body: failure,
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
}

// The server's copy of a Session's transcript, for a runner that has none
// (ADR 0032).
export async function fetchTranscript(
  agent: Agent,
  sessionId: string,
): Promise<readonly string[]> {
  const { entries } = await call(agent, "runner.transcript", {
    params: { id: sessionId },
    signal: AbortSignal.timeout(requestTimeoutMs),
  });

  return entries;
}

// An installed plugin's Session part, asked for by its bundle's hash (ADR
// 0022).
export async function fetchSessionPart(
  server: string,
  assignment: SessionStart,
  name: string,
  hash: string,
): Promise<Uint8Array> {
  const response = await call(
    { server, token: assignment.token },
    "runner.part",
    {
      params: { id: assignment.sessionId, plugin: name, hash },
      signal: AbortSignal.timeout(requestTimeoutMs),
    },
  );

  return new Uint8Array(await response.arrayBuffer());
}

// The files of an assigned Session's Profile (ADR 0041) or of the docs every
// Session gets (ADR 0052).
export async function fetchFolder(
  server: string,
  assignment: SessionStart,
  folder: "profile" | "docs",
): Promise<ProfileFiles> {
  return call(
    { server, token: assignment.token },
    folder === "profile" ? "runner.profile" : "runner.docs",
    {
      params: { id: assignment.sessionId },
      signal: AbortSignal.timeout(requestTimeoutMs),
    },
  );
}

export async function reportRemoval(
  agent: Agent,
  sessionId: string,
  report: RemovalPost,
): Promise<void> {
  await call(agent, "runner.workspaceRemoval", {
    params: { id: sessionId },
    body: report,
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
}

export function httpSessionStream(
  server: string,
  assignment: SessionStart,
  log: Log,
  fenced: () => void,
): SessionStream {
  const { sessionId, generation } = assignment;
  const agent = { server, token: assignment.token };
  const params = { id: sessionId };

  // A rejected post means the server moved on from this attempt.
  const fencing = async <T>(posted: Promise<T>): Promise<T> => {
    try {
      return await posted;
    } catch (error) {
      if (rejected(error)) {
        fenced();
      }

      throw error;
    }
  };

  const open = new Map<string, LiveEvent>();
  let sending = Promise.resolve();

  // No one follows a fenced attempt live, such as one whose Session was just
  // archived, so its events are dropped without a retry. Posts go one at a
  // time, so surfaces sent again never overtake a newer event.
  const postLive = async (
    events: () => readonly LiveEvent[],
  ): Promise<void> => {
    const sent = sending.then(async () => {
      const live: LivePost = { generation, events: events() };

      if (live.events.length === 0) {
        return;
      }

      await fencing(
        call(agent, "runner.events", {
          params,
          body: live,
          signal: AbortSignal.timeout(requestTimeoutMs),
        }),
      ).catch((error: unknown) => {
        if (!rejected(error)) {
          throw error;
        }
      });
    });

    sending = sent.catch(() => undefined);

    return sent;
  };

  return {
    uploadTranscript: async (start, lines) => {
      const batch: TranscriptBatch = { generation, start, lines };

      const { acked } = await fencing(
        call(agent, "runner.transcript.append", {
          params,
          body: batch,
          signal: AbortSignal.timeout(requestTimeoutMs),
        }),
      );

      return acked;
    },
    publish: async (events) => {
      for (const event of events) {
        const surface = liveSurface(event);
        if (surface) {
          open.delete(surface.key);
          if (surface.open) {
            open.set(surface.key, event);
          }
        }
      }

      await postLive(() => events);
    },
    commands: (listener) => {
      const controller = new AbortController();

      // A server that restarted lost the open surfaces, such as a prompt that
      // waits on the user.
      const republish = (): void => {
        postLive(() => [...open.values()]).catch((error: unknown) => {
          log("open surfaces not sent again", { error: String(error) });
        });
      };

      void followCommands(
        agent,
        { params, query: { generation } },
        listener,
        republish,
        log,
        controller.signal,
      ).then((stoppedByServer) => {
        if (stoppedByServer) {
          fenced();
        }
      });

      return () => {
        controller.abort();
      };
    },
    tools: async () =>
      call(agent, "runner.tools", {
        params,
        query: { generation },
        signal: AbortSignal.timeout(requestTimeoutMs),
      }),
    callTool: async (id, name, input) => {
      const toolCall: ToolCall = { generation, id, name, input };

      await fencing(
        call(agent, "runner.toolCalls.create", {
          params,
          body: toolCall,
          signal: AbortSignal.timeout(requestTimeoutMs),
        }),
      );
    },
    answerTrust: async (trusted) => {
      const answer: TrustAnswer = { generation, trusted };

      await fencing(
        call(agent, "runner.trust", {
          params,
          body: answer,
          signal: AbortSignal.timeout(requestTimeoutMs),
        }),
      );
    },
    pluginRequest: async (plugin, path, init = {}) => {
      const url = new URL(
        apiPath("runner.ext", { params: { id: sessionId, plugin, path } }),
        agent.server,
      );

      url.searchParams.set("generation", String(generation));

      const headers = new Headers(init.headers);
      for (const [name, value] of Object.entries(agentHeaders(agent))) {
        headers.set(name, value);
      }

      return fetch(url, { ...init, headers });
    },
    terminal: (terminalId, peer) =>
      openTerminalSocket(
        agent,
        `/runner/sessions/${sessionId}/terminals/${terminalId}?generation=${String(generation)}`,
        peer,
        log,
      ),
    preview: (connectionId) =>
      openPreviewSocket(
        agent,
        `/runner/sessions/${sessionId}/previews/${connectionId}?generation=${String(generation)}`,
      ),
  };
}

// A slow browser makes the Session host wait instead of buffering a whole
// download.
const maxPreviewBufferedBytes = 1024 * 1024;

function openPreviewSocket(agent: Agent, path: string): PreviewExchange {
  const url = new URL(path, agent.server);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

  const socket = new WebSocket(url, { headers: agentHeaders(agent) });
  socket.binaryType = "arraybuffer";

  const opened = new Promise((resolve) => {
    socket.addEventListener("open", resolve, { once: true });
  });

  // A WebSocket's frames from the browser, once the request has arrived.
  let relayed: WebSocket | undefined;

  const request = new Promise<{
    readonly head: PreviewRequest;
    readonly body: Uint8Array;
  }>((resolve, reject) => {
    let head: PreviewRequest | undefined;
    let received = false;

    socket.addEventListener("message", (event: MessageEvent) => {
      const data = event.data as string | ArrayBuffer;
      if (received) {
        relayed?.send(data);
      } else if (typeof data === "string") {
        head = JSON.parse(data) as PreviewRequest;
      } else if (head !== undefined) {
        received = true;
        resolve({ head, body: new Uint8Array(data) });
      }
    });

    socket.addEventListener("close", () => {
      reject(new Error("the preview socket closed"));
    });
  });

  request.catch(() => undefined);

  return {
    request,
    respond: async (response) => {
      const head: PreviewResponse = {
        status: response.status,
        headers: [...response.headers],
      };

      socket.send(JSON.stringify(head));
      if (response.body === null) {
        socket.close(1000);

        return;
      }

      const chunks: AsyncIterable<Uint8Array> = response.body;
      for await (const chunk of chunks) {
        if (socket.readyState !== WebSocket.OPEN) {
          return;
        }

        socket.send(chunk);
        while (socket.bufferedAmount > maxPreviewBufferedBytes) {
          await sleep(10);
        }
      }

      socket.close(1000);
    },
    relay: (app) => {
      app.binaryType = "arraybuffer";

      app.addEventListener("open", () => {
        relayed = app;
        const head: PreviewResponse = { status: 101, headers: [] };
        socket.send(JSON.stringify(head));
      });

      app.addEventListener("message", (event: MessageEvent) => {
        socket.send(event.data as string | ArrayBuffer);
      });

      app.addEventListener("close", (event) => {
        socket.close(
          relayed === undefined ? 1011 : 1000,
          relayed === undefined
            ? "the app refused the WebSocket"
            : event.reason,
        );
      });

      socket.addEventListener("close", () => {
        app.close();
      });
    },
    fail: (reason) => {
      void opened.then(() => {
        socket.close(1011, reason.slice(0, 120));
      });
    },
  };
}

function openTerminalSocket(
  agent: Agent,
  path: string,
  peer: TerminalPeer,
  log: Log,
): TerminalChannel {
  const url = new URL(path, agent.server);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

  const socket = new WebSocket(url, {
    headers: agentHeaders(agent),
  });

  socket.binaryType = "arraybuffer";
  const pending: Uint8Array[] = [];

  socket.addEventListener("open", () => {
    for (const data of pending.splice(0)) {
      socket.send(data);
    }
  });

  socket.addEventListener("message", (event: MessageEvent) => {
    if (event.data instanceof ArrayBuffer) {
      peer.input(new Uint8Array(event.data));

      return;
    }

    const control = JSON.parse(String(event.data)) as TerminalControl;
    if (control.type === "close") {
      peer.end();
    } else {
      peer.resize(control.cols, control.rows);
    }
  });

  socket.addEventListener("close", (event) => {
    log("terminal socket closed", {
      path,
      code: event.code,
      reason: event.reason,
    });

    peer.closed();
  });

  return {
    send: (data) => {
      if (socket.readyState === WebSocket.CONNECTING) {
        pending.push(data);
      } else if (socket.readyState === WebSocket.OPEN) {
        socket.send(data);

        if (socket.bufferedAmount > maxTerminalBufferedBytes) {
          log("terminal fell behind", {
            path,
            bufferedAmount: socket.bufferedAmount,
          });

          socket.terminate();
        }
      }
    },
    close: () => {
      socket.close();
    },
  };
}

function rejected(error: unknown): boolean {
  return (
    error instanceof ApiError && (error.status === 404 || error.status === 409)
  );
}

async function followCommands(
  agent: Agent,
  input: ApiInput<"runner.commands">,
  listener: (command: Command) => void,
  reconnected: () => void,
  log: Log,
  signal: AbortSignal,
): Promise<boolean> {
  const retry = backoff(reconnect.initialMs, reconnect.maxMs);
  let connected = false;
  while (!signal.aborted) {
    try {
      const response = await call(agent, "runner.commands", {
        ...input,
        signal,
      });

      retry.reset();
      if (connected) {
        reconnected();
      }

      connected = true;
      for await (const command of readSse(response)) {
        listener(command as Command);
      }
    } catch (error) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- the signal can abort while the await above is pending
      if (signal.aborted) {
        return false;
      }

      if (rejected(error)) {
        log("command stream rejected", {
          sessionId: input.params.id,
          error: String(error),
        });

        return true;
      }

      log("command stream failed", {
        sessionId: input.params.id,
        error: String(error),
        retryInMs: retry.delayMs(),
      });
    }

    await retry.wait(signal);
  }

  return false;
}
