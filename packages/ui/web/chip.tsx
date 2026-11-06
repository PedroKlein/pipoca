import type { ReactElement, ReactNode } from "react";
import { cn } from "./cn";
import { Icon } from "./icon";

// A small round-ended label for a value in a list, such as a folder or an
// email address. With onRemove it carries its own remove button.
export function Chip({
  mono = false,
  onRemove,
  removeLabel,
  className,
  children,
}: {
  // For paths, commands and other code.
  readonly mono?: boolean;
  readonly onRemove?: () => void;
  // Names the remove button, such as "Remove bea@example.com".
  readonly removeLabel?: string;
  readonly className?: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <span
      className={cn(
        "inline-flex h-7 max-w-full items-center gap-1 rounded-full border border-line bg-elevated text-fg",
        mono ? "font-mono text-mono-sm" : "text-label",
        onRemove ? "pr-1 pl-2.5" : "px-2.5",
        className,
      )}
    >
      <span className="truncate">{children}</span>
      {onRemove && (
        <button
          type="button"
          aria-label={removeLabel ?? "Remove"}
          className="grid size-5 shrink-0 cursor-pointer place-items-center rounded-full text-fg-dim hover:bg-hover"
          onClick={onRemove}
        >
          <Icon name="x" />
        </button>
      )}
    </span>
  );
}
