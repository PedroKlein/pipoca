import { afterEach, expect, test } from "bun:test";
import type { Server } from "bun";
import { relay } from "./relay";

const heartbeatMs = 50;

let servers: Server<undefined>[] = [];
let controllers: AbortController[] = [];

afterEach(() => {
  for (const each of controllers) {
    each.abort();
  }

  for (const each of servers) {
    void each.stop(true);
  }

  servers = [];
  controllers = [];
});

// A server whose relay sockets stay open, answering pings only if told to.
function relayServer(answers: boolean): { readonly connections: () => number } {
  let connections = 0;

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request, bunServer) =>
      bunServer.upgrade(request, { data: undefined })
        ? undefined
        : new Response("expected a websocket", { status: 400 }),
    websocket: {
      open: () => {
        connections++;
      },
      message: (ws, message) => {
        if (answers && message === "ping") {
          ws.send("pong");
        }
      },
    },
  });

  servers.push(server);

  const controller = new AbortController();
  controllers.push(controller);

  void relay(
    { server: server.url.href, token: "pct_test" },
    [{ host: "git.example.com", port: 443 }],
    () => undefined,
    controller.signal,
    heartbeatMs,
  );

  return { connections: () => connections };
}

test("a relay socket that goes quiet without closing, as behind a load balancer after the server restarts, is opened again", async () => {
  const server = relayServer(false);

  await Bun.sleep(heartbeatMs * 4 + 1500);

  expect(server.connections()).toBeGreaterThan(1);
});

test("a relay socket whose server answers stays open", async () => {
  const server = relayServer(true);

  await Bun.sleep(heartbeatMs * 10);

  expect(server.connections()).toBe(1);
});
