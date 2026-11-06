import type { SetupStep, WebContext } from "@pipoca/plugins/web";
import type { Environment, Profile } from "@pipoca/protocol";
import { useState } from "react";
import { useLoad } from "../data/hooks";

export interface WizardStep {
  readonly id: string;
  readonly step: SetupStep;
  readonly context: WebContext;
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
export function useDone({
  id,
  step,
  context,
}: WizardStep): boolean | undefined {
  const [waiting, setWaiting] = useState(true);

  const { data } = useLoad(`setup ${id}`, async () => step.done(context), {
    topics: step.topics ?? [],
    ...(waiting && { everyMs: 2000 }),
  });

  if (waiting !== (data !== true)) {
    setWaiting(data !== true);
  }

  return data;
}
