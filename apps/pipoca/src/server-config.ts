import { isObject, type PluginConfig } from "@pipoca/plugins";

export interface ServerConfig {
  readonly sessionDays: number;
  readonly runnerTokenDays: number;
  readonly repositorySyncMinutes: number;
}

export const serverDefaults: ServerConfig = {
  sessionDays: 30,
  runnerTokenDays: 30,
  repositorySyncMinutes: 15,
};

// The server's own options under "server" in pipoca.json, read again when the
// file changes. One left out, or that isn't a positive number, takes its
// default.
export function serverConfig(config: PluginConfig): () => ServerConfig {
  return () => {
    const value = config.get();
    const given = isObject(value) ? value : {};

    return {
      sessionDays: positive(given["sessionDays"], serverDefaults.sessionDays),
      runnerTokenDays: positive(
        given["runnerTokenDays"],
        serverDefaults.runnerTokenDays,
      ),
      repositorySyncMinutes: positive(
        given["repositorySyncMinutes"],
        serverDefaults.repositorySyncMinutes,
      ),
    };
  };
}

export function positive(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}
