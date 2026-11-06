import {
  BadRequest,
  type Collection,
  NotFound,
  type Static,
  Type,
} from "@pipoca/plugins";
import { type HostItem, hostPattern } from "../plugin";
import type { HostView } from "./model";

// What Settings sends to change a host. An empty or missing client secret
// keeps the one the host has, and null takes it away.
export const hostChange = Type.Object({
  label: Type.Optional(Type.String()),
  clientId: Type.Optional(Type.String()),
  clientSecret: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

export const newHost = Type.Object({
  ...hostChange.properties,
  host: Type.String(),
});

export interface HostConfig {
  readonly host: string;
  readonly label: string;
  // The REST API's base address.
  readonly api: string;
  readonly oauth: OAuthApp | undefined;
}

export interface OAuthApp {
  readonly clientId: string;
  // GitHub's OAuth apps need a secret, so without one people paste a token.
  readonly clientSecret: string | undefined;
}

export interface Hosts {
  readonly list: () => readonly HostConfig[];
  readonly get: (host: string) => HostConfig | undefined;
  readonly create: (input: Static<typeof newHost>) => HostConfig;
  readonly update: (
    host: string,
    input: Static<typeof hostChange>,
  ) => HostConfig;
  readonly remove: (host: string) => void;
}

// The hosts live in the plugin's config in pipoca.json, which Settings and
// people both edit (ADR 0039).
export function hosts(items: Collection<HostItem>): Hosts {
  const get = (host: string): HostConfig | undefined => {
    const item = items.get(host);

    return item && hostConfig(item);
  };

  const changed = (
    host: string,
    input: Static<typeof hostChange>,
    before: HostItem | undefined,
  ): HostItem => {
    const label = (input.label ?? "").trim();
    const clientId = input.clientId?.trim() ?? "";
    const secret = input.clientSecret?.trim();

    const kept = input.clientSecret === null ? undefined : before?.oauth;

    const clientSecret =
      secret === undefined || secret === "" ? kept?.clientSecret : secret;

    return {
      host,
      ...(label !== "" && label !== host && { label }),
      ...(before?.api !== undefined && { api: before.api }),
      ...(clientId !== "" && {
        oauth: {
          clientId,
          ...(clientSecret !== undefined && { clientSecret }),
        },
      }),
    };
  };

  return {
    list: () => items.list().map(hostConfig),
    get,
    create: (input) => {
      const host = hostName(input.host);

      if (items.get(host) !== undefined) {
        throw new BadRequest(`${host} is already listed`);
      }

      const item = changed(host, input, undefined);
      items.put(item);

      return hostConfig(item);
    },
    update: (host, input) => {
      const before = items.get(host);

      if (before === undefined) {
        throw new NotFound(`no host ${host}`);
      }

      const item = changed(host, input, before);
      items.put(item);

      return hostConfig(item);
    },
    remove: (host) => {
      if (!items.remove(host)) {
        throw new NotFound(`no host ${host}`);
      }
    },
  };
}

// The web never gets a client secret back, only whether one is set.
export function viewOf(
  { host, label, oauth }: HostConfig,
  connected: number,
): HostView {
  return {
    host,
    label,
    clientId: oauth?.clientId ?? "",
    hasClientSecret: oauth?.clientSecret !== undefined,
    connected,
  };
}

function hostConfig({ host, label, api, oauth }: HostItem): HostConfig {
  return {
    host,
    label: label === undefined || label.trim() === "" ? host : label.trim(),
    api: (api ?? defaultApi(host)).replace(/\/+$/, ""),
    oauth: oauth && {
      clientId: oauth.clientId,
      clientSecret: oauth.clientSecret,
    },
  };
}

function defaultApi(host: string): string {
  return host === "github.com"
    ? "https://api.github.com"
    : `https://${host}/api/v3`;
}

function hostName(value: string): string {
  const host = value.trim().toLowerCase();

  if (!new RegExp(hostPattern).test(host)) {
    throw new BadRequest("host must be a host name, such as github.com");
  }

  return host;
}
