import type { HTMLAttributes, ReactElement } from "react";
import { cn } from "./cn";

// Grouped content on a page: elevated, with a border and a light shadow.
export const cardClass = "rounded-lg border border-line bg-elevated shadow-xs";

// A card that stands out from the page, such as a welcome form.
export const raisedCardClass =
  "rounded-lg border border-line bg-elevated shadow-card";

// A card that a click opens, such as an Environment in a list.
export const linkCardClass = cn(
  cardClass,
  "transition-colors duration-150 hover:border-line-strong",
);

const paddings = {
  none: "",
  sm: "p-3",
  md: "p-4",
  lg: "p-5",
} as const;

export function Card({
  padding = "md",
  raised = false,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  readonly padding?: keyof typeof paddings;
  // Stands out from the page, such as a welcome form.
  readonly raised?: boolean;
}): ReactElement {
  return (
    <div
      className={cn(
        raised ? raisedCardClass : cardClass,
        paddings[padding],
        className,
      )}
      {...props}
    />
  );
}
