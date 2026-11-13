import { availability, type Environment } from "@pipoca/protocol";
import { Badge } from "@pipoca/ui";
import type { ReactElement } from "react";

export function AvailabilityBadge({
  environment,
}: {
  readonly environment: Pick<Environment, "online" | "onDemand">;
}): ReactElement {
  const status = availability(environment);

  return (
    <Badge state={status === "Offline" ? "offline" : "done"}>{status}</Badge>
  );
}
