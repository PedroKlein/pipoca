import type { SetupStep } from "@pipoca/plugins/web";
import { pluginClient } from "@pipoca/plugins/web/host";
import type { Environment, Profile } from "@pipoca/protocol";
import { useState } from "react";
import { useLoad } from "../data/hooks";

// The server's setup, which an admin does once, or each person's own
// (ADR 0072).
export type Phase = "server" | "person";

export type StepAbout = Omit<SetupStep, "audience" | "after"> & {
  // A kernel step draws its own footer, to say what Continue saves.
  readonly ownFooter?: boolean;
};

export interface WizardStep {
  // The kernel step's id, or the plugin's that adds it.
  readonly id: string;
  readonly phase: Phase;
  readonly step: StepAbout;
}

export const connected = ({ online, onDemand }: Environment): boolean =>
  online || onDemand;

export function hasContent(profile: Profile): boolean {
  return (
    profile.agentsMd !== "" ||
    profile.packages.length > 0 ||
    Object.keys(profile.mcpServers).length > 0
  );
}

// Runners come online and report models without a topic, so a step that
// isn't done yet looks again every few seconds.
export function useDone({ id, phase, step }: WizardStep): boolean | undefined {
  const [waiting, setWaiting] = useState(true);

  const { data } = useLoad(
    `setup ${phase} ${id}`,
    async () => step.done(pluginClient({ id })),
    {
      topics: [
        ...(step.topics ?? []),
        ...(step.changes ?? []).map((name) => `${id}.${name}`),
      ],
      ...(waiting && { everyMs: 2000 }),
    },
  );

  if (waiting !== (data !== true)) {
    setWaiting(data !== true);
  }

  return data;
}
