import { BadRequest, fieldsOf, type PluginConfig } from "@pipoca/plugins";
import type { TeamName } from "@pipoca/protocol";

const maxName = 60;

export interface Team {
  readonly get: () => TeamName;
  readonly set: (team: TeamName) => void;
}

// The team's name in pipoca.json, under "team".
export function teamSettings(config: PluginConfig): Team {
  return {
    get: () => {
      try {
        return teamOf(config.get() ?? { name: null });
      } catch {
        return { name: null };
      }
    },
    set: (team) => {
      config.set(team);
    },
  };
}

export function teamOf(value: unknown): TeamName {
  const { name } = fieldsOf(value);

  if (name === null || name === undefined) {
    return { name: null };
  }

  if (typeof name !== "string") {
    throw new BadRequest("name must be a string or null");
  }

  const trimmed = name.trim();

  if (trimmed.length > maxName) {
    throw new BadRequest(
      `a team name is at most ${String(maxName)} characters`,
    );
  }

  return { name: trimmed === "" ? null : trimmed };
}
