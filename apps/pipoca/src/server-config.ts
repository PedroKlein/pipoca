import { Config, type Static, Type } from "@pipoca/plugins";
import { type ConfigKey, fieldsOf, kernelConfig } from "@pipoca/plugins/host";
import type { Log, ServerUse } from "@pipoca/protocol";

const serverOptions = Config.object({
  sessionDays: Type.Number({ exclusiveMinimum: 0, default: 30 }),
  runnerTokenDays: Type.Number({ exclusiveMinimum: 0, default: 30 }),
  repositorySyncMinutes: Type.Number({ exclusiveMinimum: 0, default: 15 }),
  // Who the server is for, which an admin picks in its setup (ADR 0072).
  usedBy: Type.Optional(Type.Enum(["me", "team"])),
});

type ServerConfig = Static<typeof serverOptions>;

// The server's own options under "server" in pipoca.json, read again when the
// file changes.
export function serverConfig(config: ConfigKey, log: Log): () => ServerConfig {
  return kernelConfig(config, serverOptions, log);
}

// Keeps the other options, written by hand or by Helm, as they are.
export function useServerFor(config: ConfigKey, usedBy: ServerUse): void {
  config.set({ ...fieldsOf(config.get()), usedBy });
}
