import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { BadRequest } from "@pipoca/plugins";
import type { PluginHost } from "@pipoca/pluginhost";

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

// Whether a host name or address reaches a private, loopback or link-local
// address, such as a cluster's own Services, which a fetch the server makes
// for someone stays away from unless an admin allows the host.
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

// A repository the server clones for a person: on a host they have a git
// login for, or on no private address. A URL that doesn't parse is left to
// the clone to refuse.
export async function checkFetchable(
  url: string,
  person: string,
  plugins: Pick<PluginHost, "gitLogins">,
): Promise<void> {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    return;
  }

  const logins = plugins.gitLogins(`person:${person}`, {
    actsAs: null,
    workspace: { kind: "clone", repository: url, branch: "" },
  });

  if (logins.some(({ host }) => host === parsed.host)) {
    return;
  }

  if (await privateAddress(parsed.hostname)) {
    throw new BadRequest(
      "The server clones from a private address only on a host you have a git login for.",
    );
  }
}
