import { BadRequest, fieldsOf, type PluginConfig } from "@pipoca/plugins";
import type { Newcomers } from "@pipoca/protocol";
import { listOf, textOf } from "./requests";

const noNewcomers: Newcomers = { template: null, profiles: [], required: [] };
const maxProfiles = 20;

export interface NewcomerSetup {
  readonly get: () => Newcomers;
  readonly set: (newcomers: Newcomers) => void;
}

// What admins set up for the people who join, in pipoca.json under
// "newcomers" (ADR 0063).
export function newcomerSetup(config: PluginConfig): NewcomerSetup {
  return {
    get: () => {
      const value = config.get();

      if (value === undefined) {
        return noNewcomers;
      }

      try {
        return newcomersOf(value);
      } catch {
        return noNewcomers;
      }
    },
    set: (newcomers) => {
      config.set(newcomers);
    },
  };
}

export function newcomersOf(value: unknown): Newcomers {
  const { template, profiles, required } = fieldsOf(value);

  const offered = listOf("profiles", profiles ?? [], (profile) =>
    textOf("profile", profile),
  );

  if (offered.length > maxProfiles) {
    throw new BadRequest(
      `new people are offered at most ${String(maxProfiles)} Profiles`,
    );
  }

  return {
    template:
      template === null || template === undefined
        ? null
        : textOf("template", template),
    profiles: [...new Set(offered)],
    required: [
      ...new Set(
        listOf("required", required ?? [], (step) => textOf("step", step)),
      ),
    ],
  };
}
