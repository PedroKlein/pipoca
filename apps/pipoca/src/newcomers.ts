import type { PluginConfig } from "@pipoca/plugins";
import { type Newcomers, newcomersChange } from "@pipoca/protocol";
import { Value } from "typebox/value";

export interface NewcomerSetup {
  readonly get: () => Newcomers;
  readonly set: (newcomers: Newcomers) => void;
}

// What admins set up for the people who join, in pipoca.json under
// "newcomers" (ADR 0063).
export function newcomerSetup(config: PluginConfig): NewcomerSetup {
  return {
    get: () => {
      const value = config.get() ?? {};

      return newcomersOf(Value.Check(newcomersChange, value) ? value : {});
    },
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
