import type { Environment } from "@pipoca/protocol";
import { type IconName, isIconName } from "@pipoca/ui";

type Kind = Pick<Environment, "runnersFrom" | "isolation">;

// What an Environment is (ADR 0063): runners a plugin starts, a Docker image
// on a machine someone connects, or the machines themselves.
export function kindName({ runnersFrom, isolation }: Kind): string {
  if (runnersFrom !== null) {
    return runnersFrom.label;
  }

  return isolation === "container" ? "Docker image" : "Machines";
}

export function kindAbout({ runnersFrom, isolation }: Kind): string {
  if (runnersFrom !== null) {
    return `Its runners come from ${runnersFrom.label}: the server starts one when a Session needs it and stops it when it goes idle.`;
  }

  return isolation === "container"
    ? "One container from its image on a machine that joins it, shared by its Sessions."
    : "Sessions run on the machines that join it, with what's installed there.";
}

export function kindIcon({ runnersFrom, isolation }: Kind): IconName {
  if (runnersFrom !== null) {
    return isIconName(runnersFrom.icon) ? runnersFrom.icon : "cloud";
  }

  return isolation === "container" ? "cloud" : "monitor";
}
