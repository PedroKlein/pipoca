import type { ReactElement, ReactNode } from "react";
import { cn } from "./cn";

// The popped kernel (ADR 0042). Butter shows only here and in the team's
// mark, so it never reads as a state colour; the hull follows the text.
export function Mark({
  className,
}: {
  readonly className?: string;
}): ReactElement {
  return (
    <svg
      viewBox="10 15 100 100"
      aria-hidden="true"
      className={cn("size-6 shrink-0 text-fg-strong", className)}
    >
      <g className="fill-butter">
        <circle cx="44" cy="42" r="21" />
        <circle cx="77" cy="42" r="21" />
        <circle cx="31" cy="68" r="19" />
        <circle cx="89" cy="68" r="19" />
        <circle cx="60" cy="66" r="28" />
        <circle cx="60" cy="86" r="20" />
      </g>
      <path
        d="M49 99 C52 110 68 110 71 99 C66 95 54 95 49 99 Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function Wordmark({
  size = "md",
}: {
  readonly size?: "md" | "lg";
}): ReactElement {
  return (
    <span className="flex items-center gap-2 font-serif text-wordmark font-light text-fg-strong">
      <Mark className={size === "lg" ? "size-8" : "size-7"} />
      pipoca
    </span>
  );
}

// The frame of first-run setup, sign-in and joining: the wordmark, the
// step bars when there are steps, and what goes on the right.
export function SetupShell({
  steps,
  aside,
  children,
}: {
  readonly steps?: { readonly total: number; readonly at: number };
  readonly aside?: ReactNode;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <div className="flex min-h-dvh flex-col bg-bg font-sans text-ui text-fg">
      <header className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 px-4 py-5 sm:px-7">
        <Wordmark />
        {steps === undefined ? (
          <span />
        ) : (
          <ol aria-label="Setup steps" className="flex gap-1.5">
            {Array.from({ length: steps.total }, (_, index) => (
              <li
                key={index}
                aria-current={index === steps.at ? "step" : undefined}
                className={cn(
                  "h-1 w-5 rounded-full sm:w-9",
                  index <= steps.at ? "bg-accent" : "bg-line",
                )}
              />
            ))}
          </ol>
        )}
        <span className="justify-self-end text-label whitespace-nowrap text-fg-dim">
          {aside}
        </span>
      </header>
      {children}
    </div>
  );
}

// The large serif question a setup page asks, with a line under it.
export function Hero({
  title,
  centered = false,
  children,
}: {
  readonly title: ReactNode;
  readonly centered?: boolean;
  readonly children?: ReactNode;
}): ReactElement {
  return (
    <div className={cn("flex flex-col gap-2.5", centered && "text-center")}>
      <h1 className="font-serif text-hero font-light text-fg-strong">
        {title}
      </h1>
      {children !== undefined && (
        <p
          className={cn(
            "max-w-130 text-prose text-fg-dim",
            centered && "mx-auto",
          )}
        >
          {children}
        </p>
      )}
    </div>
  );
}
