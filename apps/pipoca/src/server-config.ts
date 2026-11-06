import { Config, type Static, Type } from "@pipoca/plugins";
import { type ConfigKey, kernelConfig } from "@pipoca/plugins/host";
import type { Log } from "@pipoca/protocol";

const serverOptions = Config.object({
  sessionDays: Type.Number({ exclusiveMinimum: 0, default: 30 }),
  runnerTokenDays: Type.Number({ exclusiveMinimum: 0, default: 30 }),
  repositorySyncMinutes: Type.Number({ exclusiveMinimum: 0, default: 15 }),
});

type ServerConfig = Static<typeof serverOptions>;

// The server's own options under "server" in pipoca.json, read again when the
// file changes.
export function serverConfig(config: ConfigKey, log: Log): () => ServerConfig {
  return kernelConfig(config, serverOptions, log);
}
