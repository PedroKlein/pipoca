import { Type } from "typebox";
import { nullable, type Wire } from "./wire";

export interface HostPort {
  readonly host: string;
  readonly port: number;
}

const defaultPort = 443;

// An exact host name with an optional port, such as github.acme.internal or
// jira.acme.internal:8443: no wildcards, IP addresses or localhost, so a
// relay can't be pointed at a machine's own services (ADR 0080).
export function hostPortOf(text: string): HostPort | undefined {
  const match =
    /^([a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+)(?::(\d{1,5}))?$/.exec(
      text.trim().toLowerCase(),
    );

  const host = match?.[1];
  const port = Number(match?.[5] ?? defaultPort);

  if (
    host === undefined ||
    /^[\d.]+$/.test(host) ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    port < 1 ||
    port > 65_535
  ) {
    return undefined;
  }

  return { host, port };
}

export function hostPortText({ host, port }: HostPort): string {
  return port === defaultPort ? host : `${host}:${String(port)}`;
}

// The host a repository URL names, https or ssh, scp-like ones included.
export function repositoryHost(repository: string): string | undefined {
  const url = URL.parse(repository);

  if (url !== null && url.hostname !== "") {
    return url.hostname.toLowerCase();
  }

  return /^[^@/\s]+@([^:/\s]+):/.exec(repository)?.[1]?.toLowerCase();
}

const hostName = Type.Refine(
  Type.String({ minLength: 1, maxLength: 260 }),
  (text) => hostPortOf(text) !== undefined,
  () => "must be an exact host name with an optional port",
);

// A host the server can't reach directly, which Pipoca reaches through an
// Environment that can (ADR 0080).
const privateHost = Type.Object({
  host: hostName,
  // A PEM certificate authority trusted for this host alone.
  ca: nullable(Type.String({ maxLength: 20_000 })),
  // Whether team routines may watch it, since every user can start them.
  teamWatch: Type.Boolean(),
});

export type PrivateHost = Wire<typeof privateHost>;

export const privateHosts = Type.Object({
  hosts: Type.Array(privateHost, { maxItems: 100 }),
});

export type PrivateHosts = Wire<typeof privateHosts>;

// What a runner found of each private host its owner named (ADR 0080).
export const reachedHost = Type.Object({
  host: Type.String(),
  port: Type.Integer({ minimum: 1, maximum: 65_535 }),
  reached: Type.Boolean(),
});

export type ReachedHost = Wire<typeof reachedHost>;

// One tunnel the server opened through a runner, as the Environment page
// lists them.
export const relayed = Type.Object({
  at: Type.Number(),
  runner: Type.String(),
  host: Type.String(),
  port: Type.Integer(),
  plugin: Type.String(),
  owner: Type.String(),
  action: nullable(Type.String()),
  bytes: Type.Integer(),
  ms: Type.Integer(),
});

export type Relayed = Wire<typeof relayed>;

// The hosts the server checked itself through each runner, and its last
// tunnels, newest first.
export const environmentRelays = Type.Object({
  confirmed: Type.Array(
    Type.Object({
      runner: Type.String(),
      host: Type.String(),
      port: Type.Integer(),
    }),
  ),
  recent: Type.Array(relayed),
});

export type EnvironmentRelays = Wire<typeof environmentRelays>;
