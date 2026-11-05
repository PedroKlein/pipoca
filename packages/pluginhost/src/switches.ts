import { isObject, type PluginConfig } from "@pipoca/plugins";

// The kernel's own keys in pipoca.json, which no plugin id may take.
export const kernelKeys: readonly string[] = [
  "server",
  "team",
  "plugins",
  "hub",
  "newcomers",
  "templates",
];

// Whether a plugin loads at all, and whether its parts load in team work
// (ADR 0067). What is left out takes the plugin's default.
export interface PluginSwitch {
  readonly personal?: boolean;
  readonly team?: boolean;
}

export interface PluginSwitches {
  readonly get: (id: string) => PluginSwitch;
  // Merges the change into the plugin's switch; undefined removes it.
  readonly set: (id: string, change: PluginSwitch | undefined) => void;
}

// Every plugin's switch, by id, under "plugins" in pipoca.json.
export function pluginSwitches(config: PluginConfig): PluginSwitches {
  const all = (): Readonly<Record<string, unknown>> => {
    const value = config.get();

    return isObject(value) ? value : {};
  };

  const get = (id: string): PluginSwitch => {
    const saved = Object.hasOwn(all(), id) ? all()[id] : undefined;

    if (!isObject(saved)) {
      return {};
    }

    const { personal, team } = saved;

    return {
      ...(typeof personal === "boolean" && { personal }),
      ...(typeof team === "boolean" && { team }),
    };
  };

  return {
    get,
    set: (id, change) => {
      const others = Object.fromEntries(
        Object.entries(all()).filter(([key]) => key !== id),
      );

      const next =
        change === undefined
          ? others
          : { ...others, [id]: { ...get(id), ...change } };

      config.set(Object.keys(next).length === 0 ? undefined : next);
    },
  };
}
