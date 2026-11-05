import {
  Config,
  fieldsOf,
  kernelConfig,
  type ConfigKey,
  Type,
} from "@pipoca/plugins";
import {
  type Log,
  type TeamName,
  teamMessagesRead,
  teamNameChange,
} from "@pipoca/protocol";

export interface Team {
  readonly get: () => TeamName;
  readonly set: (team: TeamName) => void;
  // How many of the team's messages since its last turn Pi reads (ADR 0065).
  readonly messagesRead: () => number;
}

const teamOptions = Config.object({
  ...teamNameChange.properties,
  messagesRead: Type.Number({ minimum: 1, default: teamMessagesRead }),
});

// The team's name and options in pipoca.json, under "team".
export function teamSettings(config: ConfigKey, log: Log): Team {
  const read = kernelConfig(config, teamOptions, log);

  return {
    get: () => teamOf(read()),
    set: (team) => {
      config.set({ ...fieldsOf(config.get()), ...team });
    },
    messagesRead: () => Math.floor(read().messagesRead),
  };
}

export function teamOf({ name }: { readonly name?: string | null }): TeamName {
  const trimmed = name?.trim() ?? "";

  return { name: trimmed === "" ? null : trimmed };
}
