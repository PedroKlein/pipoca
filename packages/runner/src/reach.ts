import { lookup } from "node:dns/promises";
import { BlockList } from "node:net";
import { connect } from "node:tls";
import type { HostPort, Log, ReachedHost } from "@pipoca/protocol";

const probeTimeoutMs = 5000;
const probeEveryMs = 5 * 60_000;

// Loopback and link-local addresses, which a relay must never open: the
// machine's own services and cloud metadata live there (ADR 0080).
const local = new BlockList();
local.addSubnet("127.0.0.0", 8, "ipv4");
local.addSubnet("169.254.0.0", 16, "ipv4");
local.addSubnet("0.0.0.0", 8, "ipv4");
local.addAddress("::1", "ipv6");
local.addSubnet("fe80::", 10, "ipv6");
local.addSubnet("::ffff:127.0.0.0", 104, "ipv6");

// The address to open for a named host, or undefined when it resolves to a
// local one.
export async function relayAddress(host: string): Promise<string | undefined> {
  const { address, family } = await lookup(host);

  return local.check(address, family === 6 ? "ipv6" : "ipv4")
    ? undefined
    : address;
}

// Whether the machine opens a TLS connection to each host its owner named,
// checked now and every few minutes, as the runner reports in its polls.
export function watchReach(
  hosts: readonly HostPort[],
  log: Log,
  signal: AbortSignal,
): () => readonly ReachedHost[] {
  let found: readonly ReachedHost[] = hosts.map((each) => ({
    ...each,
    reached: false,
  }));

  if (hosts.length === 0) {
    return () => found;
  }

  const probeAll = async (): Promise<void> => {
    found = await Promise.all(
      hosts.map(async (each) => ({ ...each, reached: await probe(each) })),
    );

    log("private hosts checked", {
      reached: found.filter(({ reached }) => reached).length,
      hosts: found.length,
    });
  };

  void probeAll();

  const timer = setInterval(() => void probeAll(), probeEveryMs);

  signal.addEventListener("abort", () => {
    clearInterval(timer);
  });

  return () => found;
}

async function probe({ host, port }: HostPort): Promise<boolean> {
  const address = await relayAddress(host).catch(() => undefined);

  if (address === undefined) {
    return false;
  }

  return new Promise((resolve) => {
    // Pipoca checks the certificate itself through the relay; here only
    // whether the host answers counts.
    const socket = connect({
      host: address,
      port,
      servername: host,
      rejectUnauthorized: false,
      timeout: probeTimeoutMs,
    });

    const done = (reached: boolean): void => {
      socket.destroy();
      resolve(reached);
    };

    socket.once("secureConnect", () => {
      done(true);
    });

    socket.once("timeout", () => {
      done(false);
    });

    socket.once("error", () => {
      done(false);
    });
  });
}
