import { randomUUID } from "node:crypto";
import { Duplex } from "node:stream";
import type { ServerWebSocket } from "bun";
import {
  type Log,
  protocolVersion,
  type Relayed,
  versionHeader,
} from "@pipoca/protocol";
import type { Auth } from "./server/http/deps";
import type { SocketHandler, SocketServer } from "./sockets";

export interface RelayData {
  readonly kind: "relay";
  readonly environment: string;
  readonly runner: string;
  // A tunnel's id, or undefined for the runner's control socket.
  readonly tunnel: string | undefined;
}

export interface RelayRunner {
  readonly environment: string;
  readonly runner: string;
}

// One relayed connection, as the server's end of a tunnel to a host.
// Who a tunnel is for: the plugin, its owner, and what the call does.
export interface RelayedBy {
  readonly plugin: string;
  readonly owner: string;
  readonly action: string | null;
}

export interface RelayedTunnel {
  readonly stream: Duplex;
  readonly runner: RelayRunner;
}

export interface Relays {
  readonly upgrade: (
    request: Request,
    server: SocketServer,
  ) => Response | "upgraded" | undefined;
  readonly websocket: SocketHandler<RelayData>;
  // Whether a runner's relay socket is open now.
  readonly ready: (runner: RelayRunner) => boolean;
  readonly open: (
    runner: RelayRunner,
    to: { readonly host: string; readonly port: number },
    by: RelayedBy,
  ) => Promise<RelayedTunnel>;
  // The last tunnels through an Environment's runners, newest first.
  readonly recent: (environment: string) => readonly Relayed[];
  // Closes the tunnels of runners and hosts that may no longer relay.
  readonly closeWhere: (
    gone: (tunnel: RelayRunner & { readonly host: string }) => boolean,
  ) => void;
  readonly close: () => void;
}

const openTimeoutMs = 10_000;
const maxOpenPerRunner = 16;
const keptEntries = 50;
const controlPath = "/runner/relay";
const tunnelPath = /^\/runner\/relay\/([0-9a-f-]{36})$/;

interface Pending {
  readonly runner: RelayRunner;
  readonly host: string;
  readonly port: number;
  readonly by: RelayedBy;
  readonly started: number;
  readonly resolve: (tunnel: RelayedTunnel) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  ws?: ServerWebSocket<RelayData>;
  stream?: Duplex;
  bytes: number;
}

// The server's side of the runners' relays (ADR 0080): each runner that
// reaches a private host keeps a control socket open, and every tunnel the
// server asks for comes back as a socket of its own.
export function relayBroker(auth: Auth, log: Log): Relays {
  const controls = new Map<string, ServerWebSocket<RelayData>>();
  const tunnels = new Map<string, Pending>();
  const entries = new Map<string, Relayed[]>();

  const keyOf = ({ environment, runner }: RelayRunner): string =>
    JSON.stringify([environment, runner]);

  const finish = (id: string): void => {
    const tunnel = tunnels.get(id);

    if (tunnel === undefined) {
      return;
    }

    tunnels.delete(id);
    clearTimeout(tunnel.timer);

    const entry: Relayed = {
      at: tunnel.started,
      runner: tunnel.runner.runner,
      host: tunnel.host,
      port: tunnel.port,
      plugin: tunnel.by.plugin,
      owner: tunnel.by.owner,
      action: tunnel.by.action,
      bytes: tunnel.bytes,
      ms: Date.now() - tunnel.started,
    };

    log("relay closed", { environment: tunnel.runner.environment, ...entry });

    const kept = entries.get(tunnel.runner.environment) ?? [];

    entries.set(
      tunnel.runner.environment,
      [entry, ...kept].slice(0, keptEntries),
    );

    tunnel.stream?.destroy();
    tunnel.ws?.close();
  };

  return {
    upgrade: (request, server) => {
      const { pathname } = new URL(request.url);
      const tunnel = tunnelPath.exec(pathname)?.[1];

      if (pathname !== controlPath && tunnel === undefined) {
        return undefined;
      }

      const caller = auth.runners.callerOf(request);
      const pending = tunnel === undefined ? undefined : tunnels.get(tunnel);

      // A tunnel's socket comes once, from the runner it was asked of.
      const awaited =
        pending !== undefined &&
        caller !== undefined &&
        keyOf(pending.runner) === keyOf(caller) &&
        pending.ws === undefined;

      if (
        request.headers.get(versionHeader) !== String(protocolVersion) ||
        caller?.sessionId !== null ||
        (tunnel !== undefined && !awaited)
      ) {
        return new Response("Not found.", { status: 404 });
      }

      return server.upgrade(request, {
        data: {
          kind: "relay",
          environment: caller.environment,
          runner: caller.runner,
          tunnel,
        },
      })
        ? "upgraded"
        : new Response("expected a websocket", { status: 400 });
    },
    websocket: {
      open: (ws) => {
        const { tunnel } = ws.data;

        if (tunnel === undefined) {
          controls.get(keyOf(ws.data))?.close(1000, "replaced");
          controls.set(keyOf(ws.data), ws);

          log("relay ready", {
            environment: ws.data.environment,
            runner: ws.data.runner,
          });

          return;
        }

        const pending = tunnels.get(tunnel);

        if (pending === undefined) {
          ws.close();

          return;
        }

        pending.ws = ws;
      },
      message: (ws, message) => {
        const { tunnel } = ws.data;
        const pending = tunnel === undefined ? undefined : tunnels.get(tunnel);

        if (tunnel === undefined || pending === undefined) {
          return;
        }

        if (typeof message === "string") {
          if (message === "ready" && pending.stream === undefined) {
            clearTimeout(pending.timer);

            const stream = new Duplex({
              read: () => undefined,
              write: (chunk: Buffer, _encoding, done) => {
                pending.bytes += chunk.length;
                ws.send(chunk);
                done();
              },
              final: (done) => {
                finish(tunnel);
                done();
              },
              destroy: (error, done) => {
                finish(tunnel);
                done(error);
              },
            });

            pending.stream = stream;
            pending.resolve({ stream, runner: pending.runner });
          }

          return;
        }

        pending.bytes += message.length;
        pending.stream?.push(message);
      },
      close: (ws) => {
        const { tunnel } = ws.data;

        if (tunnel === undefined) {
          if (controls.get(keyOf(ws.data)) === ws) {
            controls.delete(keyOf(ws.data));
          }

          return;
        }

        const pending = tunnels.get(tunnel);

        if (pending?.stream === undefined) {
          pending?.reject(
            new Error(`${pending.runner.runner} couldn't open ${pending.host}`),
          );
        } else {
          pending.stream.push(null);
        }

        finish(tunnel);
      },
    },
    ready: (runner) => controls.has(keyOf(runner)),
    open: async (runner, { host, port }, by) => {
      const control = controls.get(keyOf(runner));

      const open = [...tunnels.values()].filter(
        (each) => keyOf(each.runner) === keyOf(runner),
      ).length;

      if (control === undefined) {
        throw new Error(`${runner.runner} has no relay open`);
      }

      if (open >= maxOpenPerRunner) {
        throw new Error(`${runner.runner} has too many relays open`);
      }

      const id = randomUUID();

      const opened = new Promise<RelayedTunnel>((resolve, reject) => {
        tunnels.set(id, {
          runner,
          host,
          port,
          by,
          started: Date.now(),
          resolve,
          reject,
          bytes: 0,
          timer: setTimeout(() => {
            reject(new Error(`${runner.runner} didn't open ${host} in time`));
            finish(id);
          }, openTimeoutMs),
        });
      });

      log("relay opening", { ...runner, host, port, ...by });
      control.send(JSON.stringify({ id, host, port }));

      return opened;
    },
    recent: (environment) => entries.get(environment) ?? [],
    closeWhere: (gone) => {
      for (const [id, tunnel] of tunnels) {
        if (gone({ ...tunnel.runner, host: tunnel.host })) {
          finish(id);
        }
      }

      for (const ws of controls.values()) {
        if (gone({ ...ws.data, host: "" })) {
          ws.close(1000, "let go");
        }
      }
    },
    close: () => {
      for (const id of [...tunnels.keys()]) {
        finish(id);
      }

      for (const ws of controls.values()) {
        ws.close(1001, "server stopping");
      }
    },
  };
}
