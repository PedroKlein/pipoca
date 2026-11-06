import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { BadRequest } from "@pipoca/plugins";
import type { PluginHost } from "@pipoca/pluginhost";
import type { CloneOptions } from "@pipoca/repositories";

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

// The addresses a host name or address reaches. A host on a private,
// loopback or link-local address, such as a cluster's own Services, is one a
// fetch the server makes for someone stays away from unless an admin allows
// the host.
async function addressesOf(
  host: string,
): Promise<readonly { readonly address: string; readonly family: number }[]> {
  const bare = host.replace(/^\[(.*)\]$/, "$1");

  return isIP(bare) === 0
    ? lookup(bare, { all: true }).catch(() => {
        throw new BadRequest(`The server couldn't look up ${bare}.`);
      })
    : [{ address: bare, family: isIP(bare) }];
}

// A repository the server clones for a person: on a host they have a git
// login for, or on no private address, and then only from the address it
// checked, and with none of the server's own ssh keys or git setup. A URL
// that doesn't parse is left to the clone to refuse.
export async function checkFetchable(
  url: string,
  person: string,
  plugins: Pick<PluginHost, "gitLogins">,
): Promise<CloneOptions> {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    return { anonymous: true };
  }

  const logins = plugins.gitLogins(`person:${person}`, {
    actsAs: null,
    workspace: { kind: "clone", repository: url, branch: "" },
  });

  if (logins.some(({ host }) => host === parsed.host)) {
    return { anonymous: true };
  }

  const addresses = await addressesOf(parsed.hostname);

  if (
    addresses.some(({ address, family }) =>
      privateRanges.check(address, family === 6 ? "ipv6" : "ipv4"),
    )
  ) {
    throw new BadRequest(
      "The server clones from a private address only on a host you have a git login for.",
    );
  }

  const [first] = addresses;

  if (first === undefined || parsed.protocol !== "https:") {
    return { anonymous: true };
  }

  const address = first.family === 6 ? `[${first.address}]` : first.address;

  return {
    anonymous: true,
    resolve: `${parsed.hostname}:${parsed.port || "443"}:${address}`,
  };
}
