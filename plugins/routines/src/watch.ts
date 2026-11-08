import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import type { Owner } from "@pipoca/plugins";
import type { Watch } from "./routine";

const timeoutMs = 30_000;
const maxBytes = 1024 * 1024;
const maxValueLength = 4000;

// What the plugin's schedule keeps for each watch trigger between fetches
// (ADR 0075): what it saw last, by its hash and as the value, and how the
// last fetch went.
export interface Watching {
  readonly owner: Owner;
  readonly name: string;
  readonly trigger: number;
  readonly url: string;
  readonly path?: string;
  readonly seen?: string;
  readonly previous?: unknown;
  readonly checkedAt?: number;
  readonly error?: string;
}

export interface Looked {
  readonly status: number;
  readonly value: unknown;
  readonly seen: string;
}

// Fetches the watch's address and takes the value at its path in the JSON,
// or else the whole text, with a hash to tell whether it changed.
export async function look(watch: Watch): Promise<Looked> {
  const response = await publicFetch(watch.url, {
    headers: { accept: "application/json, text/plain;q=0.9, */*;q=0.5" },
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    throw new Error(`${watch.url} answered ${String(response.status)}`);
  }

  const text = await response.text();

  if (text.length > maxBytes) {
    throw new Error(`${watch.url} answered more than 1 MB`);
  }

  let value: unknown = text;

  if (watch.path !== undefined) {
    try {
      value = valueAt(JSON.parse(text), watch.path) ?? null;
    } catch (error) {
      throw new Error(`${watch.url} didn't answer JSON`, { cause: error });
    }
  }

  const json = JSON.stringify(value);

  return {
    status: response.status,
    value:
      typeof value === "string" && value.length > maxValueLength
        ? `${value.slice(0, maxValueLength)}…`
        : value,
    seen: createHash("sha256").update(json).digest("hex"),
  };
}

// A dotted path such as items.0.version, with an optional leading $.
function valueAt(value: unknown, path: string): unknown {
  let found = value;

  for (const part of path.replace(/^\$\.?/, "").split(".")) {
    if (part === "") {
      continue;
    }

    found =
      typeof found === "object" && found !== null && part in found
        ? (found as Record<string, unknown>)[part]
        : undefined;
  }

  return found;
}

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
// such as the server's own, on every redirect too, and connects only to the
// address it checked, as the logins plugin's does.
async function publicFetch(
  input: string,
  init: RequestInit,
): Promise<Response> {
  let url = new URL(input);

  for (let hop = 0; hop < 5; hop++) {
    if (url.protocol !== "https:") {
      throw new Error(`${url.href} isn't an https address`);
    }

    const response = await pinnedFetch(url, init);
    const location = response.headers.get("location");

    if (response.status < 300 || response.status > 399 || location === null) {
      return response;
    }

    url = new URL(location, url);
  }

  throw new Error(`${url.host} redirected too many times`);
}

async function pinnedFetch(url: URL, init: RequestInit): Promise<Response> {
  const bare = url.hostname.replace(/^\[(.*)\]$/, "$1");

  const addresses =
    isIP(bare) === 0
      ? await lookup(bare, { all: true }).catch(() => [])
      : [{ address: bare, family: isIP(bare) }];

  const [first] = addresses;

  if (
    first === undefined ||
    addresses.some(({ address, family }) =>
      privateRanges.check(address, family === 6 ? "ipv6" : "ipv4"),
    )
  ) {
    throw new Error(
      first === undefined
        ? `${url.host} has no address`
        : `${url.host} is on a private address, which a watch doesn't fetch`,
    );
  }

  const pinned = new URL(url);
  pinned.hostname = first.family === 6 ? `[${first.address}]` : first.address;

  const headers = new Headers(init.headers);
  headers.set("host", url.host);

  return fetch(pinned, {
    ...init,
    headers,
    redirect: "manual",
    ...(isIP(bare) === 0 && { tls: { serverName: bare } }),
  });
}
