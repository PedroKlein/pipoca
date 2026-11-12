import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { connect as tlsConnect } from "node:tls";
import type { Environments } from "@pipoca/environments";
import { type Network, type NetworkEnv, Unreachable } from "@pipoca/plugins";
import type { HostPort, Log, Owner } from "@pipoca/protocol";
import type { PrivateHostList } from "./private-hosts";
import type { RelayRunner, Relays } from "./relays";

export interface NetworkRouter {
  // The network calls of one plugin.
  readonly of: (plugin: string) => Network;
  // The runners and hosts the server confirmed with a handshake of its own.
  readonly confirmed: (runner: RelayRunner) => readonly HostPort[];
  readonly recent: Relays["recent"];
  // Closes tunnels that no longer have an Environment or a listed host.
  readonly sweep: () => void;
  readonly close: () => void;
}

interface Ticket {
  readonly owner: Owner;
  readonly plugin: string;
  readonly to: HostPort;
  readonly runner: RelayRunner;
  readonly until: number;
}

const ticketMs = 10 * 60_000;
const maxHops = 5;
const confirmMs = 10_000;

// The kernel's one way out to private hosts (ADR 0080): a proxy on loopback
// that opens each connection through a relay, for fetch and child processes
// alike, with a ticket that names whom it is for.
export function networkRouter(deps: {
  readonly relays: Relays;
  readonly privateHosts: PrivateHostList;
  readonly environments: Environments;
  readonly log: Log;
}): NetworkRouter {
  const { relays, privateHosts, environments, log } = deps;
  const tickets = new Map<string, Ticket>();
  const confirmed = new Set<string>();

  const keyOf = (runner: RelayRunner, to: HostPort): string =>
    JSON.stringify([runner.environment, runner.runner, to.host, to.port]);

  const routes = (owner: Owner, to: HostPort): readonly RelayRunner[] => {
    const ownerId = owner === "team" ? "team" : owner.slice("person:".length);
    const owned = environments.all().filter((each) => each.ownerId === ownerId);

    if (owned.length === 0) {
      throw new Unreachable(
        to.host,
        owner === "team"
          ? "no team Environment reaches it"
          : "no Environment of yours reaches it",
      );
    }

    const reaching = owned.flatMap(({ provider }) =>
      environments
        .runners(provider)
        .filter(({ inventory }) =>
          (inventory.reach ?? []).some(
            (each) =>
              each.reached && each.host === to.host && each.port === to.port,
          ),
        )
        .map(({ name, online }) => ({
          environment: provider,
          runner: name,
          online,
        })),
    );

    const ready = reaching.filter((each) => each.online && relays.ready(each));

    if (ready.length === 0) {
      throw new Unreachable(
        to.host,
        reaching.length === 0
          ? `no ${owner === "team" ? "team Environment" : "Environment of yours"} reaches it`
          : "the runners that reach it are offline",
      );
    }

    return ready;
  };

  const confirm = async (
    runner: RelayRunner,
    to: HostPort,
    ca: string | null,
    plugin: string,
    owner: Owner,
  ): Promise<void> => {
    if (confirmed.has(keyOf(runner, to))) {
      return;
    }

    const { stream } = await relays.open(runner, to, { plugin, owner });

    await new Promise<void>((resolve, reject) => {
      const socket = tlsConnect({
        socket: stream,
        servername: to.host,
        ...(ca !== null && { ca }),
        timeout: confirmMs,
      });

      socket.once("secureConnect", () => {
        socket.destroy();
        resolve();
      });

      socket.once("timeout", () => {
        socket.destroy();
        reject(new Unreachable(to.host, "it didn't answer through the relay"));
      });

      socket.once("error", (error) => {
        socket.destroy();

        reject(
          new Unreachable(
            to.host,
            `its certificate didn't check out: ${error.message}`,
          ),
        );
      });
    });

    confirmed.add(keyOf(runner, to));
    log("private host confirmed", { ...runner, host: to.host, port: to.port });
  };

  const proxy: Server = createServer((client) => {
    void accept(
      client,
      (token, to) => {
        const ticket = tickets.get(token);

        return ticket !== undefined &&
          ticket.until >= Date.now() &&
          ticket.to.host === to.host &&
          ticket.to.port === to.port &&
          privateHosts.find(to) !== undefined
          ? ticket
          : undefined;
      },
      async (ticket) =>
        (await relays.open(ticket.runner, ticket.to, ticket)).stream,
      log,
    );
  });

  proxy.listen(0, "127.0.0.1");

  const proxyUrl = (): string => {
    const address = proxy.address();

    if (address === null || typeof address === "string") {
      throw new Error("the network proxy isn't listening");
    }

    return `http://127.0.0.1:${String(address.port)}`;
  };

  // A ticket through a confirmed route, or undefined for a public host.
  const ticketFor = async (
    url: URL,
    plugin: string,
    owner: Owner | undefined,
  ): Promise<
    { readonly token: string; readonly ca: string | null } | undefined
  > => {
    const to = hostPortOfUrl(url);
    const listed = privateHosts.find(to);

    if (listed === undefined) {
      return undefined;
    }

    if (url.protocol !== "https:") {
      throw new Unreachable(to.host, "is reached over https only");
    }

    if (owner === undefined) {
      throw new Unreachable(
        to.host,
        "this call isn't for anyone it could go through",
      );
    }

    const [runner] = routes(owner, to);

    if (runner === undefined) {
      throw new Unreachable(to.host, "no Environment reaches it");
    }

    await confirm(runner, to, listed.ca, plugin, owner);

    const token = randomBytes(24).toString("base64url");

    tickets.set(token, {
      owner,
      plugin,
      to,
      runner,
      until: Date.now() + ticketMs,
    });

    return { token, ca: listed.ca };
  };

  const routedFetch = async (
    plugin: string,
    url: URL,
    init: RequestInit,
    owner: Owner | undefined,
  ): Promise<Response> => {
    let at = url;

    for (let hop = 0; hop <= maxHops; hop++) {
      const ticket = await ticketFor(at, plugin, owner);

      if (ticket === undefined) {
        return fetch(at, init);
      }

      const response = await fetch(at, {
        ...init,
        redirect: "manual",
        keepalive: false,
        proxy: {
          url: proxyUrl(),
          headers: { "proxy-authorization": `Bearer ${ticket.token}` },
        },
        ...(ticket.ca !== null && { tls: { ca: ticket.ca } }),
      })
        .catch((error: unknown) => {
          throw new Unreachable(
            at.hostname,
            `the call through its relay failed: ${String(error)}`,
          );
        })
        .finally(() => tickets.delete(ticket.token));

      const location = response.headers.get("location");

      if (
        init.redirect === "manual" ||
        response.status < 300 ||
        response.status >= 400 ||
        location === null
      ) {
        return response;
      }

      const next = new URL(location, at);

      if (next.host !== at.host || next.protocol !== at.protocol) {
        throw new Unreachable(
          at.hostname,
          `sent a redirect to ${next.host}, which isn't followed`,
        );
      }

      at = next;
    }

    throw new Unreachable(url.hostname, "redirected too many times");
  };

  return {
    of: (plugin) => ({
      privateHost: (url) => {
        const listed = privateHosts.find(hostPortOfUrl(new URL(url)));

        return listed && { teamWatch: listed.teamWatch };
      },
      fetch: async (url, init = {}, owner) =>
        routedFetch(plugin, new URL(url), init, owner),
      env: async (url, owner): Promise<NetworkEnv> => {
        const at = new URL(url);
        const ticket = await ticketFor(at, plugin, owner);

        if (ticket === undefined) {
          return { env: {}, done: () => undefined };
        }

        const proxied = new URL(proxyUrl());
        proxied.username = "ticket";
        proxied.password = ticket.token;

        const ca = ticket.ca === null ? undefined : caFolder(ticket.ca);

        // GIT_SSL_CAINFO wins over any config, and the process talks to
        // this host only.
        // After any entries the server's own environment has.
        const count = Number(process.env["GIT_CONFIG_COUNT"] ?? 0);

        const first = String(
          Number.isSafeInteger(count) && count > 0 ? count : 0,
        );

        return {
          env: {
            GIT_CONFIG_COUNT: String(Number(first) + 1),
            [`GIT_CONFIG_KEY_${first}`]: `http.https://${at.host}/.proxy`,
            [`GIT_CONFIG_VALUE_${first}`]: proxied.href,
            ...(ca !== undefined && { GIT_SSL_CAINFO: join(ca, "ca.pem") }),
          },
          done: () => {
            tickets.delete(ticket.token);

            if (ca !== undefined) {
              rmSync(ca, { recursive: true, force: true });
            }
          },
        };
      },
    }),
    confirmed: (runner) =>
      [...confirmed].flatMap((key) => {
        const [environment, name, host, port] = JSON.parse(key) as [
          string,
          string,
          string,
          number,
        ];

        return environment === runner.environment && name === runner.runner
          ? [{ host, port }]
          : [];
      }),
    recent: (environment) => relays.recent(environment),
    sweep: () => {
      const providers = new Set(
        environments.all().map(({ provider }) => provider),
      );

      const gone = (each: RelayRunner & { readonly host: string }): boolean =>
        !providers.has(each.environment) ||
        (each.host !== "" && !privateHosts.lists(each.host));

      for (const key of confirmed) {
        const [environment, runner, host] = JSON.parse(key) as [
          string,
          string,
          string,
        ];

        if (gone({ environment, runner, host })) {
          confirmed.delete(key);
        }
      }

      relays.closeWhere(gone);
    },
    close: () => {
      proxy.close();
    },
  };
}

function hostPortOfUrl(url: URL): HostPort {
  return {
    host: url.hostname,
    port: Number(url.port || (url.protocol === "http:" ? 80 : 443)),
  };
}

// A folder only this process reads, holding the host's CA for git.
function caFolder(ca: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pipoca-ca-"));

  writeFileSync(join(dir, "ca.pem"), ca, { mode: 0o600 });

  return dir;
}

// Answers one CONNECT with a tunnel through a relay, when its ticket fits.
async function accept(
  client: Socket,
  ticketOf: (token: string, to: HostPort) => Ticket | undefined,
  tunnelFor: (ticket: Ticket) => Promise<Duplex>,
  log: Log,
): Promise<void> {
  const refuse = (status: string): void => {
    client.end(`HTTP/1.1 ${status}\r\n\r\n`);
  };

  const head = await headOf(client);
  const [line = "", ...headers] = head?.text.split("\r\n") ?? [];
  const [method, target] = line.split(" ");
  const to = target === undefined ? undefined : hostPortOfTarget(target);
  const token = tokenOf(headers);

  const ticket =
    to === undefined || token === undefined ? undefined : ticketOf(token, to);

  if (head === undefined || method !== "CONNECT" || ticket === undefined) {
    refuse("407 Proxy Authentication Required");

    return;
  }

  try {
    const tunnel = await tunnelFor(ticket);

    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");

    if (head.rest.length > 0) {
      tunnel.write(head.rest);
    }

    client.pipe(tunnel).pipe(client);
    client.on("error", () => tunnel.destroy());
    client.on("close", () => tunnel.destroy());
    tunnel.on("close", () => client.destroy());
  } catch (error) {
    log("private host call refused", {
      host: ticket.to.host,
      error: String(error),
    });

    refuse("502 Bad Gateway");
  }
}

async function headOf(
  client: Socket,
): Promise<{ readonly text: string; readonly rest: Buffer } | undefined> {
  return new Promise((resolve) => {
    let seen = Buffer.alloc(0);

    const onData = (chunk: Buffer): void => {
      seen = Buffer.concat([seen, chunk]);

      const end = seen.indexOf("\r\n\r\n");

      if (end !== -1) {
        client.off("data", onData);
        client.pause();

        resolve({
          text: seen.subarray(0, end).toString("latin1"),
          rest: seen.subarray(end + 4),
        });
      } else if (seen.length > 16_384) {
        client.off("data", onData);
        resolve(undefined);
      }
    };

    client.on("data", onData);

    client.once("error", () => {
      resolve(undefined);
    });
  });
}

function hostPortOfTarget(target: string): HostPort | undefined {
  const match = /^([a-z0-9.-]+):(\d{1,5})$/i.exec(target);

  return match?.[1] === undefined || match[2] === undefined
    ? undefined
    : { host: match[1].toLowerCase(), port: Number(match[2]) };
}

// Bearer from fetch, Basic from git, whose password is the ticket.
function tokenOf(headers: readonly string[]): string | undefined {
  const value = headers
    .find((each) => each.toLowerCase().startsWith("proxy-authorization:"))
    ?.slice("proxy-authorization:".length)
    .trim();

  const [scheme, credential] = value?.split(" ") ?? [];

  if (credential === undefined) {
    return undefined;
  }

  if (scheme?.toLowerCase() === "bearer") {
    return credential;
  }

  if (scheme?.toLowerCase() === "basic") {
    const decoded = Buffer.from(credential, "base64").toString();

    return decoded.slice(decoded.indexOf(":") + 1);
  }

  return undefined;
}
