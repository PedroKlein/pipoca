import type { ReactElement, ReactNode } from "react";
import { cn } from "./cn";
import { Icon } from "./icon";

export type StepState = "done" | "current" | "next";

// Numbered steps down a line, for a flow done in order, such as connecting
// a machine or setting up an OAuth app.
export function Stepper({
  label,
  className,
  children,
}: {
  readonly label?: string;
  readonly className?: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <ol aria-label={label} className={cn("flex flex-col", className)}>
      {children}
    </ol>
  );
}

const numbers = {
  done: "border-done bg-done text-on-accent",
  current: "border-accent bg-elevated text-fg-strong",
  next: "border-line-strong bg-elevated text-fg-dim",
} as const satisfies Record<StepState, string>;

export function Step({
  number,
  state,
  title,
  description,
  children,
}: {
  readonly number: number;
  readonly state: StepState;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly children?: ReactNode;
}): ReactElement {
  return (
    <li
      aria-current={state === "current" ? "step" : undefined}
      className="relative flex gap-3.5 pb-5.5 before:absolute before:top-7 before:bottom-1 before:left-[11px] before:w-[1.5px] before:bg-line last:pb-0 last:before:hidden"
    >
      <span
        className={cn(
          "grid size-6 shrink-0 place-items-center rounded-full border-[1.5px] text-caption font-semibold",
          numbers[state],
        )}
      >
        {state === "done" ? <Icon name="check" className="size-3.5" /> : number}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 pt-0.5">
        <span className="text-ui font-medium text-fg-strong">{title}</span>
        {description !== undefined && (
          <span className="text-label text-fg-dim">{description}</span>
        )}
        {children !== undefined && (
          <div className="flex flex-col text-label text-fg-dim">{children}</div>
        )}
      </div>
    </li>
  );
}
