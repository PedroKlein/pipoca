import type { ReactElement } from "react";
import { cn } from "./cn";

const tones = {
  working: "bg-working",
  waiting: "bg-waiting",
  done: "bg-done",
  failed: "bg-failed",
  accent: "bg-accent",
  offline: "border border-fg-dim",
} as const;

export type DotTone = keyof typeof tones;

// A small dot for how something stands beside its name, such as a thread in
// a list. Without a tone it is a quiet placeholder while that is unknown.
export function StatusDot({
  tone,
  label,
  className,
}: {
  readonly tone?: DotTone | undefined;
  // Names the dot for screen readers; without one it is hidden from them.
  readonly label?: string;
  readonly className?: string;
}): ReactElement {
  return (
    <span
      {...(label === undefined
        ? { "aria-hidden": true }
        : { role: "img", "aria-label": label })}
      className={cn(
        "size-2 shrink-0 rounded-full",
        tone === undefined ? "bg-line" : tones[tone],
        className,
      )}
    />
  );
}
