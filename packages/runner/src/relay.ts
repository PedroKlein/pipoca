import { connect, type Socket } from "node:net";
import type { HostPort, Log } from "@pipoca/protocol";
import { backoff } from "./backoff";
import { type Agent, agentHeaders } from "./client";
import { relayAddress } from "./reach";

// What the server asks for on the relay socket: a tunnel to one of the
// hosts the owner named.
interface TunnelRequest {
  readonly id: string;
  readonly host: string;
  readonly port: number;
}

const maxTunnels = 16;
const idleMs = 5 * 60_000;

// Keeps a socket open to the server that it asks tunnels through, to the
// private hosts named with --reach and nothing else (ADR 0080). Each tunnel
// is a socket of its own carrying the host's bytes as they are, so TLS runs
// from the server to the host and this machine sees none of it.
export async function relay(
  agent: Agent,
  hosts: readonly HostPort[],
  log: Log,
  signal: AbortSignal,
): Promise<void> {
  const retry = backoff(1000, 30_000);
  const open = new Set<() => void>();

  const allowed = (request: TunnelRequest): boolean =>
    hosts.some(
      ({ host, port }) => host === request.host && port === request.port,
    );

  while (!signal.aborted) {
    const closed = await new Promise<boolean>((resolve) => {
      const socket = new WebSocket(socketUrl(agent, "/runner/relay"), {
        headers: agentHeaders(agent),
      });

      const stop = (): void => {
        socket.close();
      };

      signal.addEventListener("abort", stop, { once: true });

      socket.addEventListener("open", () => {
        retry.reset();
        log("relay ready", { hosts: hosts.length });
      });

      socket.addEventListener("message", (event: MessageEvent) => {
        const request = JSON.parse(String(event.data)) as TunnelRequest;

        if (!allowed(request) || open.size >= maxTunnels) {
          log("relay refused", {
            host: request.host,
            port: request.port,
            open: open.size,
          });

          return;
        }

        tunnel(agent, request, open, log);
      });

      socket.addEventListener("close", (event) => {
        signal.removeEventListener("abort", stop);
        resolve(event.code === 1000);
      });
    });

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- the signal can abort while the socket is open
    if (!signal.aborted) {
      log("relay socket closed", { clean: closed, retryInMs: retry.delayMs() });
      await retry.wait(signal);
    }
  }

  for (const end of open) {
    end();
  }
}

function tunnel(
  agent: Agent,
  request: TunnelRequest,
  open: Set<() => void>,
  log: Log,
): void {
  const started = Date.now();
  const bytes = { in: 0, out: 0 };

  const socket = new WebSocket(
    socketUrl(agent, `/runner/relay/${request.id}`),
    {
      headers: agentHeaders(agent),
    },
  );

  socket.binaryType = "arraybuffer";

  let host: Socket | undefined;
  const early: Uint8Array[] = [];

  const end = (): void => {
    open.delete(end);
    host?.destroy();
    socket.close();
  };

  open.add(end);

  socket.addEventListener("open", () => {
    void relayAddress(request.host)
      .catch(() => undefined)
      .then((address) => {
        if (address === undefined) {
          log("relay refused", { host: request.host, reason: "local address" });
          end();

          return;
        }

        host = connect({ host: address, port: request.port });
        host.setTimeout(idleMs, end);

        host.on("connect", () => {
          for (const data of early.splice(0)) {
            host?.write(data);
          }

          socket.send("ready");
        });

        host.on("data", (data: Buffer) => {
          bytes.in += data.length;
          socket.send(data);
        });

        host.on("close", end);
        host.on("error", end);
      });
  });

  socket.addEventListener("message", (event: MessageEvent) => {
    if (!(event.data instanceof ArrayBuffer)) {
      return;
    }

    const data = new Uint8Array(event.data);
    bytes.out += data.length;

    if (host?.readyState === "open") {
      host.write(data);
    } else {
      early.push(data);
    }
  });

  socket.addEventListener("close", () => {
    host?.destroy();
    open.delete(end);

    log("relayed", {
      id: request.id,
      host: request.host,
      port: request.port,
      bytesIn: bytes.in,
      bytesOut: bytes.out,
      ms: Date.now() - started,
    });
  });
}

function socketUrl(agent: Agent, path: string): URL {
  const url = new URL(path, agent.server);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

  return url;
}
