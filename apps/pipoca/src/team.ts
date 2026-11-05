import type { PluginConfig } from "@pipoca/plugins";
import { type TeamName, teamNameChange } from "@pipoca/protocol";
import { Value } from "typebox/value";

export interface Team {
  readonly get: () => TeamName;
  readonly set: (team: TeamName) => void;
}

// The team's name in pipoca.json, under "team".
export function teamSettings(config: PluginConfig): Team {
  return {
    get: () => {
      const value = config.get() ?? {};

      return Value.Check(teamNameChange, value)
        ? teamOf(value)
        : { name: null };
    },
    set: (team) => {
      config.set(team);
    },
  };
}

export function teamOf({ name }: { readonly name?: string | null }): TeamName {
  const trimmed = name?.trim() ?? "";

  return { name: trimmed === "" ? null : trimmed };
}
