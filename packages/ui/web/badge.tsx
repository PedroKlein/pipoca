import type { ReactElement, ReactNode } from "react";
import { cn } from "./cn";

const states = {
  working: "bg-working-tint text-working before:animate-pulse",
  waiting: "bg-waiting-tint text-waiting",
  done: "bg-done-tint text-done",
  failed: "bg-failed-tint text-failed",
  offline: "bg-hover text-fg-dim before:border before:bg-transparent",
} as const;

export type BadgeState = keyof typeof states;

// A state with a dot, or without a state a plain pill such as "Admin".
export function Badge({
  state,
  title,
  children,
}: {
  readonly state?: BadgeState | undefined;
  readonly title?: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full px-2 text-caption font-medium whitespace-nowrap",
        state === undefined
          ? "bg-hover text-fg-dim"
          : cn(
              "before:size-1.5 before:rounded-full before:bg-current",
              states[state],
            ),
      )}
    >
      {children}
    </span>
  );
}
