import type { ReactElement, ReactNode } from "react";
import { Badge, type BadgeState } from "./badge";
import { cn } from "./cn";

// A Session in a list: its title, a state badge, one line of detail, and
// actions that show on hover.
export function SessionRow({
  href,
  title,
  titleHint,
  meta,
  current,
  badge,
  leading,
  actions,
  id,
  label,
}: {
  readonly href: string;
  readonly title: ReactNode;
  // The full name when the title is shortened.
  readonly titleHint?: string;
  readonly meta: ReactNode;
  readonly current: boolean;
  readonly badge?: { readonly state: BadgeState; readonly label: string };
  // A mark before the title, such as a work state's dot.
  readonly leading?: ReactNode;
  readonly actions?: ReactNode;
  readonly id?: string;
  readonly label?: string;
}): ReactElement {
  return (
    <li
      data-id={id}
      aria-label={label}
      className="group relative flex items-center rounded-md hover:bg-hover has-aria-[current=page]:bg-hover"
    >
      <a
        href={href}
        aria-current={current ? "page" : undefined}
        className="grid min-w-0 flex-1 grid-cols-[1fr_auto] items-center gap-x-2 gap-y-0.5 px-3 py-2 text-fg aria-[current=page]:before:absolute aria-[current=page]:before:inset-y-2 aria-[current=page]:before:left-0 aria-[current=page]:before:w-0.5 aria-[current=page]:before:rounded-full aria-[current=page]:before:bg-accent"
      >
        <span className="flex min-w-0 items-center gap-2">
          {leading}
          <span
            title={titleHint}
            className={cn(
              "truncate text-ui font-medium",
              current && "text-fg-strong",
            )}
          >
            {title}
          </span>
        </span>
        {badge ? <Badge state={badge.state}>{badge.label}</Badge> : <span />}
        <span className="col-span-2 truncate text-caption text-fg-dim">
          {meta}
        </span>
      </a>
      {actions}
    </li>
  );
}
