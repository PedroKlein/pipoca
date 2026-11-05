import type { ReactElement, ReactNode } from "react";
import { cn } from "./cn";
import { Icon, type IconName } from "./icon";

// Why something failed, next to the control that failed. Renders nothing
// until there is an error.
export function ErrorText({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}): ReactElement | null {
  if (children === undefined || children === null || children === "") {
    return null;
  }

  return (
    <p role="alert" className={cn("text-label text-failed", className)}>
      {children}
    </p>
  );
}

const tones = {
  quiet: ["bg-accent-tint text-fg", "info"],
  working: ["bg-working-tint text-fg", "info"],
  waiting: ["bg-waiting-tint text-fg", "clock"],
  done: ["bg-done-tint text-fg", "check"],
  failed: ["bg-failed-tint text-fg", "x"],
} as const satisfies Record<string, readonly [string, IconName]>;

const iconTones = {
  quiet: "text-fg-dim",
  working: "text-working",
  waiting: "text-waiting",
  done: "text-done",
  failed: "text-failed",
} as const;

// A short message on a tinted panel, with at most one action.
export function Notice({
  tone = "quiet",
  title,
  icon,
  action,
  role,
  className,
  children,
}: {
  readonly tone?: keyof typeof tones;
  readonly title?: ReactNode;
  readonly icon?: IconName;
  readonly action?: ReactNode;
  readonly role?: "alert" | "status" | "note";
  readonly className?: string;
  readonly children?: ReactNode;
}): ReactElement {
  const [colours, fallback] = tones[tone];

  return (
    <div
      role={role ?? (tone === "failed" ? "alert" : "note")}
      className={cn(
        "flex items-start gap-2.5 rounded-[12px] px-3.5 py-3 text-label",
        colours,
        className,
      )}
    >
      <Icon
        name={icon ?? fallback}
        className={cn("mt-px shrink-0", iconTones[tone])}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {title !== undefined && (
          <span className="font-medium text-fg-strong">{title}</span>
        )}
        {children !== undefined && <div className="min-w-0">{children}</div>}
      </div>
      {action !== undefined && <div className="shrink-0">{action}</div>}
    </div>
  );
}

// What goes in an empty list and how to add the first one.
export function EmptyState({
  action,
  className,
  children,
}: {
  readonly action?: ReactNode;
  readonly className?: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <div
      className={cn(
        "flex animate-rise-in flex-col items-start gap-3 rounded-lg border border-dashed border-line-strong p-5 text-ui text-fg-dim",
        className,
      )}
    >
      <div>{children}</div>
      {action}
    </div>
  );
}

// Something is on its way. With a label it says what.
export function Spinner({
  label,
  className,
}: {
  readonly label?: string;
  readonly className?: string;
}): ReactElement {
  const ring = (
    <span
      aria-hidden={label === undefined ? true : undefined}
      className={cn(
        "size-3.5 shrink-0 animate-spin rounded-full border-2 border-working-tint border-t-working",
        label === undefined && className,
      )}
    />
  );

  if (label === undefined) {
    return ring;
  }

  return (
    <span
      role="status"
      className={cn(
        "inline-flex items-center gap-2 text-label text-fg-dim",
        className,
      )}
    >
      {ring}
      {label}
    </span>
  );
}
