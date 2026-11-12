import { Config } from "@pipoca/plugins";
import { type ConfigKey, kernelConfig } from "@pipoca/plugins/host";
import {
  type HostPort,
  hostPortOf,
  type Log,
  type PrivateHost,
  type PrivateHosts,
  privateHosts,
} from "@pipoca/protocol";

export interface PrivateHostList {
  readonly get: () => PrivateHosts;
  readonly set: (hosts: PrivateHosts) => void;
  // The listed host a host:port is, if any.
  readonly find: (to: HostPort) => PrivateHost | undefined;
  // Whether a host name is listed on any port.
  readonly lists: (host: string) => boolean;
}

const options = Config.object({
  hosts: { ...privateHosts.properties.hosts, default: [] },
});

// The hosts the server reaches only through Environments, in pipoca.json
// under "privateHosts" (ADR 0080).
export function privateHostList(config: ConfigKey, log: Log): PrivateHostList {
  const read = kernelConfig(config, options, log);

  const listed = (): readonly (PrivateHost & HostPort)[] =>
    read().hosts.flatMap((entry) => {
      const at = hostPortOf(entry.host);

      return at === undefined ? [] : [{ ...entry, ...at }];
    });

  return {
    get: () => ({ hosts: read().hosts }),
    set: (hosts) => {
      config.set(hosts);
    },
    find: ({ host, port }) =>
      listed().find((each) => each.host === host && each.port === port),
    lists: (host) => listed().some((each) => each.host === host),
  };
}
