import type { ReactElement, ReactNode } from "react";
import { Avatar } from "./avatar";
import { cardClass } from "./card";
import { cn } from "./cn";

// A card of rows, each one a setting or an item with its controls on the
// right, as Settings draws them.
export function Rows({
  label,
  children,
  className,
}: {
  readonly label?: string;
  readonly children: ReactNode;
  readonly className?: string;
}): ReactElement {
  return (
    <ul
      aria-label={label}
      className={cn("flex flex-col", cardClass, className)}
    >
      {children}
    </ul>
  );
}

export function Row({
  title,
  description,
  initials,
  round = false,
  leading,
  children,
  className,
}: {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  // A short mark for the item, such as "Gh" for GitHub.
  readonly initials?: string;
  // Draws the mark as a person's avatar.
  readonly round?: boolean;
  // Anything else before the title, such as a status mark.
  readonly leading?: ReactNode;
  readonly children?: ReactNode;
  readonly className?: string;
}): ReactElement {
  return (
    <li
      className={cn(
        "flex min-h-15 flex-wrap items-center gap-x-3.5 gap-y-2 border-t border-line px-4 py-3.5 first:border-t-0",
        className,
      )}
    >
      {initials !== undefined && (
        <Avatar name={initials} square={!round} size={round ? "lg" : "md"}>
          {initials}
        </Avatar>
      )}
      {leading}
      <div className="flex min-w-0 flex-1 basis-48 flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-2 text-ui font-medium text-fg-strong">
          {title}
        </span>
        {description !== undefined && (
          <span className="text-label text-fg-dim">{description}</span>
        )}
      </div>
      {children}
    </li>
  );
}
