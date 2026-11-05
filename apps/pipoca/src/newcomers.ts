import { Config, kernelConfig, type ConfigKey } from "@pipoca/plugins";
import { type Log, type Newcomers, newcomersChange } from "@pipoca/protocol";

export interface NewcomerSetup {
  readonly get: () => Newcomers;
  readonly set: (newcomers: Newcomers) => void;
}

// What admins set up for the people who join, in pipoca.json under
// "newcomers" (ADR 0063).
export function newcomerSetup(config: ConfigKey, log: Log): NewcomerSetup {
  const read = kernelConfig(
    config,
    Config.object(newcomersChange.properties),
    log,
  );

  return {
    get: () => newcomersOf(read()),
    set: (newcomers) => {
      config.set(newcomers);
    },
  };
}

export function newcomersOf({
  template,
  profiles = [],
  required = [],
}: Partial<Newcomers>): Newcomers {
  return {
    template: template ?? null,
    profiles: [...new Set(profiles)],
    required: [...new Set(required)],
  };
}
