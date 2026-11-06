import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

const privateRanges = new BlockList();

for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
] as const) {
  privateRanges.addSubnet(network, prefix, "ipv4");
}

for (const [network, prefix] of [
  ["::", 127],
  ["fc00::", 7],
  ["fe80::", 10],
] as const) {
  privateRanges.addSubnet(network, prefix, "ipv6");
}

// A fetch that keeps away from private, loopback and link-local addresses,
// such as a cluster's own Services, on every redirect too, unless an admin
// allows the host.
export function publicFetch(
  allowed: readonly string[],
): (input: string | URL, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    let url = new URL(input);

    for (let hop = 0; hop < 5; hop++) {
      if (!allowed.includes(url.host) && (await privateAddress(url.hostname))) {
        throw new Error(
          `${url.host} is on a private address, which an admin allows in the logins plugin's privateHosts`,
        );
      }

      const response = await fetch(url, { ...init, redirect: "manual" });
      const location = response.headers.get("location");

      if (response.status < 300 || response.status > 399 || location === null) {
        return response;
      }

      url = new URL(location, url);
    }

    throw new Error(`${url.host} redirected too many times`);
  };
}

async function privateAddress(host: string): Promise<boolean> {
  const bare = host.replace(/^\[(.*)\]$/, "$1");

  const addresses =
    isIP(bare) === 0
      ? await lookup(bare, { all: true }).catch(() => [])
      : [{ address: bare, family: isIP(bare) }];

  return addresses.some(({ address, family }) =>
    privateRanges.check(address, family === 6 ? "ipv6" : "ipv4"),
  );
}
