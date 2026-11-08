import { type Static, Type } from "@pipoca/plugins";
import { type ConfigKey, fieldsOf, kernelConfig } from "@pipoca/plugins/host";
import type { Log } from "@pipoca/protocol";

// The kernel's own keys in pipoca.json, which no plugin id may take.
export const kernelKeys: readonly string[] = [
  "server",
  "team",
  "plugins",
  "hub",
  "newcomers",
  "templates",
];

const pluginSwitch = Type.Object({
  personal: Type.Optional(Type.Boolean()),
  team: Type.Optional(Type.Boolean()),
});

// Whether a plugin loads at all, and whether its parts load in team work
// (ADR 0067). What is left out takes the plugin's default.
type PluginSwitch = Static<typeof pluginSwitch>;

export interface PluginSwitches {
  readonly get: (id: string) => PluginSwitch;
  // Merges the change into the plugin's switch; undefined removes it.
  readonly set: (id: string, change: PluginSwitch | undefined) => void;
  // The file that sets every switch, such as one Helm mounts, while set
  // throws (ADR 0063).
  readonly lockedIn: () => string | undefined;
}

const switches = Type.Record(Type.String(), pluginSwitch, { default: {} });

// Every plugin's switch, by id, under "plugins" in pipoca.json.
export function pluginSwitches(config: ConfigKey, log: Log): PluginSwitches {
  const read = kernelConfig(config, switches, log);

  const get = (id: string): PluginSwitch => {
    const all = read();

    return (Object.hasOwn(all, id) ? all[id] : undefined) ?? {};
  };

  return {
    get,
    set: (id, change) => {
      const others = Object.fromEntries(
        Object.entries(fieldsOf(config.get())).filter(([key]) => key !== id),
      );

      const next =
        change === undefined
          ? others
          : { ...others, [id]: { ...get(id), ...change } };

      config.set(Object.keys(next).length === 0 ? undefined : next);
    },
    lockedIn: config.lockedIn,
  };
}
