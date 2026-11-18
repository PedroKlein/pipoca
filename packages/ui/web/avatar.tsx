import type { ReactElement, ReactNode } from "react";
import { cn } from "./cn";
import { initialsOf, personInitials } from "./initials";

const sizes = {
  xs: "size-6 text-caption",
  sm: "size-7 text-caption",
  md: "size-8.5 text-label",
  lg: "size-11 text-prose",
} as const;

// A person's round mark, or with square an item's logo, such as "Gh" for
// GitHub. It shows the name's initials unless given something else.
export function Avatar({
  name,
  size = "sm",
  square = false,
  pi = false,
  children,
  className,
}: {
  readonly name: string;
  // Pi's own mark, in its colour.
  readonly pi?: boolean;
  readonly size?: keyof typeof sizes;
  readonly square?: boolean;
  readonly children?: ReactNode;
  readonly className?: string;
}): ReactElement {
  const initials = square ? initialsOf(name) : personInitials(name);

  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid shrink-0 place-items-center font-semibold",
        pi ? "bg-butter text-on-butter" : "bg-hover text-fg-strong",
        sizes[size],
        square
          ? cn(
              "border border-line",
              size === "lg" ? "rounded-lg" : "rounded-md",
            )
          : "rounded-full",
        className,
      )}
    >
      {children ?? (pi ? "Pi" : initials)}
    </span>
  );
}
