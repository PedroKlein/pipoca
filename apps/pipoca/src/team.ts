import { isObject, type PluginConfig } from "@pipoca/plugins";
import {
  type TeamName,
  teamMessagesRead,
  teamNameChange,
} from "@pipoca/protocol";
import { Value } from "typebox/value";
import { positive } from "./server-config";

export interface Team {
  readonly get: () => TeamName;
  readonly set: (team: TeamName) => void;
  // How many of the team's messages since its last turn Pi reads (ADR 0065).
  readonly messagesRead: () => number;
}

// The team's name and options in pipoca.json, under "team".
export function teamSettings(config: PluginConfig): Team {
  const value = (): Readonly<Record<string, unknown>> => {
    const read = config.get();

    return isObject(read) ? read : {};
  };

  return {
    get: () =>
      Value.Check(teamNameChange, value()) ? teamOf(value()) : { name: null },
    set: (team) => {
      config.set({ ...value(), ...team });
    },
    messagesRead: () =>
      Math.max(
        1,
        Math.floor(positive(value()["messagesRead"], teamMessagesRead)),
      ),
  };
}

export function teamOf({ name }: { readonly name?: string | null }): TeamName {
  const trimmed = name?.trim() ?? "";

  return { name: trimmed === "" ? null : trimmed };
}
