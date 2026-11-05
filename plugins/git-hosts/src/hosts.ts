import type { Log } from "@pipoca/protocol";
import {
  BadRequest,
  isObject,
  type PluginConfig,
  type PluginStore,
  type SecretRef,
  secretRefs,
  type Static,
  Type,
} from "@pipoca/plugins";
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
  readonly clientSecretEnv: string | undefined;
}

export interface HostStore {
  readonly list: () => readonly HostConfig[];
  readonly get: (host: string) => HostConfig | undefined;
  readonly create: (input: Static<typeof newHost>) => HostConfig;
  readonly update: (
    host: string,
    input: Static<typeof hostChange>,
  ) => HostConfig | undefined;
  readonly remove: (host: string) => boolean;
}

// A host and its client secret as the file holds them, so a save that keeps
// the secret writes the same ref back.
interface Entry {
  readonly config: HostConfig;
  readonly ref: SecretRef | undefined;
}

const github: HostConfig = {
  host: "github.com",
  label: "GitHub",
  api: "https://api.github.com",
  oauth: undefined,
};

// The hosts live under the plugin's key in pipoca.json, which Settings and
// people both edit (ADR 0039). With no list in the file, github.com is the
// one host (ADR 0043). A list that stops fitting is logged, and the last one
// that fit stays in use.
export function hostStore(
  config: PluginConfig,
  store: PluginStore,
  env: NodeJS.ProcessEnv,
  log: Log,
): HostStore {
  const refs = secretRefs(store, env);

  const parse = (value: unknown): readonly Entry[] =>
    entriesOf(value, (ref, host) => refs.open(ref, host, "oauth.clientSecret"));

  let read = JSON.stringify(config.get());
  let entries = parse(config.get());

  // Why the hosts in the file stopped fitting. A save would write the last
  // ones that fit over what someone wrote there by hand.
  let unfit: string | undefined;

  const current = (): readonly Entry[] => {
    const value = config.get();
    const serialized = JSON.stringify(value);

    if (serialized !== read) {
      read = serialized;

      try {
        entries = parse(value);
        unfit = undefined;
      } catch (failure) {
        unfit = failure instanceof Error ? failure.message : String(failure);

        log("hosts in the config file don't fit", {
          error: unfit,
        });
      }
    }

    return entries;
  };

  const save = (next: readonly Entry[]): void => {
    current();
    if (unfit !== undefined) {
      throw new BadRequest(`fix git-hosts in pipoca.json first: ${unfit}`);
    }

    const value = config.get();

    try {
      config.set({
        ...(isObject(value) ? value : {}),
        hosts: next.map(fileEntry),
      });
    } catch (failure) {
      throw new BadRequest(
        failure instanceof Error ? failure.message : String(failure),
      );
    }

    entries = next;
    read = JSON.stringify(config.get());
  };

  const get = (host: string): Entry | undefined =>
    current().find(({ config: each }) => each.host === host);

  const changed = (
    host: string,
    input: Static<typeof hostChange>,
    before: Entry | undefined,
  ): Entry => {
    const secret = input.clientSecret;
    const label = (input.label ?? "").trim() || host;
    const clientId = input.clientId?.trim() ?? "";
    const base = { ...hostConfig(host, before?.config.api), label };

    if (clientId === "") {
      return { config: { ...base, oauth: undefined }, ref: undefined };
    }

    if (secret !== undefined && secret !== null && secret.trim() !== "") {
      return {
        config: {
          ...base,
          oauth: {
            clientId,
            clientSecret: secret.trim(),
            clientSecretEnv: undefined,
          },
        },
        ref: refs.seal(secret.trim(), host),
      };
    }

    const kept = secret === null ? undefined : before?.config.oauth;

    return {
      config: {
        ...base,
        oauth: {
          clientId,
          clientSecret: kept?.clientSecret,
          clientSecretEnv: kept?.clientSecretEnv,
        },
      },
      ref: secret === null ? undefined : before?.ref,
    };
  };

  return {
    list: () => current().map((entry) => entry.config),
    get: (host) => get(host)?.config,
    create: (input) => {
      const host = hostName(input.host);

      if (get(host) !== undefined) {
        throw new BadRequest(`${host} is already listed`);
      }

      const entry = changed(host, input, undefined);
      save([...current(), entry]);

      return entry.config;
    },
    update: (host, input) => {
      const before = get(host);
      if (before === undefined) {
        return undefined;
      }

      const entry = changed(host, input, before);
      save(current().map((each) => (each === before ? entry : each)));

      return entry.config;
    },
    remove: (host) => {
      const before = get(host);
      if (before === undefined) {
        return false;
      }

      save(current().filter((each) => each !== before));

      return true;
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
    clientSecretEnv: oauth?.clientSecretEnv ?? null,
    connected,
  };
}

type Open = (
  ref: unknown,
  host: string,
) => { readonly ref: SecretRef; readonly secret: string };

function entriesOf(value: unknown, open: Open): readonly Entry[] {
  if (value === undefined) {
    return [{ config: github, ref: undefined }];
  }

  if (!isObject(value)) {
    throw new BadRequest("git-hosts in pipoca.json must be an object");
  }

  const { hosts } = value;

  if (hosts === undefined) {
    return [{ config: github, ref: undefined }];
  }

  if (!Array.isArray(hosts)) {
    throw new BadRequest("git-hosts.hosts must be a list");
  }

  const seen = new Set<string>();

  return hosts.map((item: unknown, index): Entry => {
    try {
      if (!isObject(item)) {
        throw new BadRequest("must be an object");
      }

      const host = hostName(item["host"]);

      if (seen.has(host)) {
        throw new BadRequest(`${host} is listed twice`);
      }

      seen.add(host);

      return entryOf(host, item, open);
    } catch (failure) {
      if (failure instanceof BadRequest) {
        throw new BadRequest(
          `git-hosts.hosts[${String(index)}]: ${failure.message}`,
        );
      }

      throw failure;
    }
  });
}

function entryOf(
  host: string,
  item: Readonly<Record<string, unknown>>,
  open: Open,
): Entry {
  const { api, oauth } = item;

  if (api !== undefined && (typeof api !== "string" || !isHttp(api))) {
    throw new BadRequest("api must be an http or https URL");
  }

  const base = {
    ...hostConfig(host, api),
    label: text(item["label"], "label").trim() || host,
  };

  if (oauth === undefined) {
    return { config: { ...base, oauth: undefined }, ref: undefined };
  }

  if (!isObject(oauth)) {
    throw new BadRequest("oauth must be an object");
  }

  const { clientId, clientSecret } = oauth;

  if (typeof clientId !== "string" || clientId.trim() === "") {
    throw new BadRequest("oauth.clientId must be text");
  }

  if (clientSecret === undefined) {
    return {
      config: {
        ...base,
        oauth: {
          clientId,
          clientSecret: undefined,
          clientSecretEnv: undefined,
        },
      },
      ref: undefined,
    };
  }

  const { ref, secret } = open(clientSecret, host);

  return {
    config: {
      ...base,
      oauth: {
        clientId,
        clientSecret: secret,
        clientSecretEnv: "env" in ref ? ref.env : undefined,
      },
    },
    ref,
  };
}

// What the file holds for a host, leaving out what is default.
function fileEntry({ config, ref }: Entry): Readonly<Record<string, unknown>> {
  const { host, label, api, oauth } = config;

  return {
    host,
    ...(label !== host && { label }),
    ...(api !== defaultApi(host) && { api }),
    ...(oauth && {
      oauth: {
        clientId: oauth.clientId,
        ...(ref !== undefined && { clientSecret: ref }),
      },
    }),
  };
}

function hostConfig(
  host: string,
  api: string | undefined,
): Omit<HostConfig, "label" | "oauth"> {
  return { host, api: (api ?? defaultApi(host)).replace(/\/+$/, "") };
}

function defaultApi(host: string): string {
  return host === "github.com"
    ? "https://api.github.com"
    : `https://${host}/api/v3`;
}

// The host goes into git's config keys and gh's hosts.yml, so it is only a
// name and an optional port.
function hostName(value: unknown): string {
  const host = typeof value === "string" ? value.trim().toLowerCase() : "";

  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/.test(host)) {
    throw new BadRequest("host must be a host name, such as github.com");
  }

  return host;
}

function text(value: unknown, field: string): string {
  if (value === undefined) {
    return "";
  }

  if (typeof value !== "string") {
    throw new BadRequest(`${field} must be text`);
  }

  return value;
}

function isHttp(value: string): boolean {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}
