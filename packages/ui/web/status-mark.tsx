import type { ReactElement } from "react";
import { cn } from "./cn";
import { Icon } from "./icon";

export type MarkStatus = "running" | "done" | "failed" | "stopped" | "pending";

const names = {
  running: "Running",
  done: "Done",
  failed: "Failed",
  stopped: "Stopped",
  pending: "Not started",
} as const satisfies Record<MarkStatus, string>;

// How a step or run stands, in one 16px mark: a pulsing dot while it runs,
// then a check, a cross or a stop.
export function StatusMark({
  status,
  label = names[status],
  className,
}: {
  readonly status: MarkStatus;
  // Names the mark for screen readers; an empty label hides it from them.
  readonly label?: string;
  readonly className?: string;
}): ReactElement {
  const box = cn("grid size-4 shrink-0 place-items-center", className);

  const named =
    label === ""
      ? { "aria-hidden": true }
      : { role: "img", "aria-label": label };

  switch (status) {
    case "running":
      return (
        <span {...named} className={box}>
          <span className="size-1.5 animate-pulse rounded-full bg-working" />
        </span>
      );
    case "pending":
      return (
        <span {...named} className={box}>
          <span className="size-2.5 rounded-full border border-line-strong" />
        </span>
      );
    case "done":
      return (
        <span {...named} className={cn(box, "text-done")}>
          <Icon name="check" />
        </span>
      );
    case "failed":
      return (
        <span {...named} className={cn(box, "text-failed")}>
          <Icon name="x" />
        </span>
      );
    case "stopped":
      return (
        <span {...named} className={cn(box, "text-fg-dim")}>
          <Icon name="stop" />
        </span>
      );
  }
}
