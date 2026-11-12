import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineServer, definePlugin, Type } from "@pipoca/plugins";
import {
  type EnvironmentRelays,
  protocolVersion,
  versionHeader,
} from "@pipoca/protocol";
import { closeServers, testServer, type TestServer } from "./testdata/harness";
import { runnerCredentials } from "./testdata/runners";

const host = "github.acme.internal";

const caller = definePlugin({
  id: "caller",
  title: "Caller",
  description: "Calls a private host",
});

const callerServer = defineServer(caller, ({ routes, network }) => {
  routes.get(
    "hello",
    { auth: "person", query: Type.Object({ path: Type.String() }) },
    async ({ caller: { owner }, query: { path } }) => {
      const response = await network.fetch(`https://${host}${path}`, {}, owner);

      return { status: response.status, text: await response.text() };
    },
  );

  routes.get("git", { auth: "person" }, async ({ caller: { owner } }) => {
    const url = `https://${host}/acme/payments.git`;
    const { env, done } = await network.env(url, owner);

    try {
      const git = Bun.spawn(["git", "ls-remote", url], {
        env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: "0" },
      });

      return { exitCode: await git.exited };
    } finally {
      done();
    }
  });
});

let certs: string;
let inside: ReturnType<typeof Bun.serve>;
let server: TestServer;
let relays: WebSocket[];
let seen: string[];

beforeEach(() => {
  certs = mkdtempSync(join(tmpdir(), "private-host-"));
  seen = [];

  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-subj",
      `/CN=${host}`,
      "-addext",
      `subjectAltName=DNS:${host}`,
      "-days",
      "1",
      "-keyout",
      join(certs, "key.pem"),
      "-out",
      join(certs, "cert.pem"),
    ],
    { stdio: "ignore" },
  );

  inside = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    tls: {
      key: readFileSync(join(certs, "key.pem"), "utf8"),
      cert: readFileSync(join(certs, "cert.pem"), "utf8"),
    },
    fetch: (request) => {
      seen.push(
        `${request.headers.get("user-agent")?.split("/")[0] ?? ""} ${new URL(request.url).pathname}`,
      );

      return request.url.endsWith("/moved")
        ? Response.redirect("https://elsewhere.example/hello", 302)
        : new Response(`hello from inside ${new URL(request.url).pathname}`);
    },
  });

  server = testServer({
    builtIns: false,
    servers: [callerServer],
    runners: { pollWaitMs: 50, offlineAfterMs: 60_000 },
  });

  relays = [];
});

afterEach(async () => {
  for (const each of relays) {
    each.close();
  }

  await inside.stop(true);
  await closeServers();
  rmSync(certs, { recursive: true, force: true });
});

function agentHeaders(token: string): Record<string, string> {
  return {
    [versionHeader]: String(protocolVersion),
    authorization: `Bearer ${token}`,
  };
}

// A runner that reaches the host and relays to it, as `pipoca agent --reach`
// does, but to the test's loopback server.
async function joinRelay(runner: string): Promise<void> {
  const token = await runnerCredentials(server, server.signedIn).token(runner);

  await fetch(new URL("/runner/work", server.url), {
    method: "POST",
    headers: { ...agentHeaders(token), "content-type": "application/json" },
    body: JSON.stringify({
      running: [],
      folders: [],
      models: [],
      reach: [{ host, port: 443, reached: true }],
    }),
  });

  const socketUrl = (path: string): URL => {
    const url = new URL(path, server.url);
    url.protocol = "ws:";

    return url;
  };

  const control = new WebSocket(socketUrl("/runner/relay"), {
    headers: agentHeaders(token),
  });

  relays.push(control);

  control.addEventListener("message", (event: MessageEvent) => {
    const { id } = JSON.parse(String(event.data)) as { id: string };

    const tunnel = new WebSocket(socketUrl(`/runner/relay/${id}`), {
      headers: agentHeaders(token),
    });

    tunnel.binaryType = "arraybuffer";
    relays.push(tunnel);

    tunnel.addEventListener("open", () => {
      const socket = connect({ host: "127.0.0.1", port: inside.port ?? 0 });

      socket.on("connect", () => {
        tunnel.send("ready");
      });

      socket.on("data", (data) => {
        tunnel.send(data);
      });

      socket.on("close", () => {
        tunnel.close();
      });

      tunnel.addEventListener("message", (message: MessageEvent) => {
        socket.write(new Uint8Array(message.data as ArrayBuffer));
      });

      tunnel.addEventListener("close", () => {
        socket.destroy();
      });
    });
  });

  await new Promise((resolve) => {
    control.addEventListener("open", resolve, { once: true });
  });
}

async function listHost(ca: "own" | null = "own"): Promise<void> {
  const saved = await server.api("/api/settings/private-hosts", {
    method: "PUT",
    body: {
      hosts: [
        {
          host,
          ca: ca && readFileSync(join(certs, "cert.pem"), "utf8"),
          teamWatch: false,
        },
      ],
    },
  });

  expect(saved.status).toBe(200);
}

async function hello(path = "/hello"): Promise<Response> {
  return server.api(`/api/ext/caller/hello?path=${encodeURIComponent(path)}`);
}

test("a plugin reaches a private host through its caller's own Environment", async () => {
  await listHost();
  await joinRelay("vm");

  const reply = await hello();

  expect(reply.status).toBe(200);

  expect(await reply.json()).toEqual({
    status: 200,
    text: "hello from inside /hello",
  });

  const [environment] = (await (
    await server.api("/api/environments")
  ).json()) as { id: string }[];

  const relayed = (await (
    await server.api(`/api/environments/${environment?.id ?? ""}/relays`)
  ).json()) as EnvironmentRelays;

  expect(relayed.confirmed).toEqual([{ runner: "vm", host, port: 443 }]);

  expect(
    relayed.recent.map(({ runner, host: to, plugin }) => ({
      runner,
      host: to,
      plugin,
    })),
  ).toContainEqual({ runner: "vm", host, plugin: "caller" });
});

test("a call to a private host no Environment of the caller reaches fails as unreachable", async () => {
  await listHost();

  const reply = await hello();

  expect(reply.status).toBe(409);

  expect(await reply.json()).toMatchObject({
    error: "unreachable",
    host,
    message: `${host} is a private host and no Environment of yours reaches it.`,
  });
});

test("a private host's certificate is checked against its own CA", async () => {
  await listHost(null);
  await joinRelay("vm");

  const reply = await hello();

  expect(reply.status).toBe(409);
  expect(await reply.json()).toMatchObject({ error: "unreachable", host });
});

test("a private host's redirect to another host isn't followed", async () => {
  await listHost();
  await joinRelay("vm");

  const reply = await hello("/moved");

  expect(reply.status).toBe(409);

  expect(await reply.json()).toMatchObject({
    error: "unreachable",
    message: `${host} is a private host and sent a redirect to elsewhere.example, which isn't followed.`,
  });
});

test("deleting an Environment closes its relay", async () => {
  await listHost();
  await joinRelay("vm");

  const [control] = relays;

  const closed = new Promise((resolve) => {
    control?.addEventListener("close", resolve, { once: true });
  });

  const [environment] = (await (
    await server.api("/api/environments")
  ).json()) as { id: string }[];

  await server.api(`/api/environments/${environment?.id ?? ""}`, {
    method: "DELETE",
  });

  await closed;

  expect((await hello()).status).toBe(409);
});

test("a child process such as git reaches a private host through the same route", async () => {
  await listHost();
  await joinRelay("vm");

  const reply = await server.api("/api/ext/caller/git");

  expect(await reply.json()).toEqual({ exitCode: 0 });
  expect(seen).toContain("git /acme/payments.git/info/refs");
});
