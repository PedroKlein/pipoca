import type { ReactElement } from "react";
import { cn } from "./cn";
import { Icon, type IconName } from "./icon";

// A choice between a few options, all in view, that applies when picked,
// such as the theme or a Session's view.
export function Segmented<T extends string>({
  label,
  options,
  value,
  compact = false,
  onChange,
}: {
  readonly label: string;
  readonly options: readonly {
    readonly value: T;
    readonly label: string;
    readonly icon?: IconName;
  }[];
  readonly value: T;
  // Shows only the icons on a phone.
  readonly compact?: boolean;
  readonly onChange: (value: T) => void;
}): ReactElement {
  return (
    <div
      role="group"
      aria-label={label}
      className="inline-flex shrink-0 gap-0.5 rounded-[10px] bg-hover p-0.75"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => {
            onChange(option.value);
          }}
          className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-[7px] px-3 text-label font-medium text-fg-dim transition-colors hover:text-fg aria-pressed:bg-elevated aria-pressed:text-fg-strong aria-pressed:shadow-xs pointer-coarse:h-9"
        >
          {option.icon !== undefined && (
            <Icon name={option.icon} className="size-3.5" />
          )}
          <span
            className={cn(
              compact && option.icon !== undefined && "max-sm:sr-only",
            )}
          >
            {option.label}
          </span>
        </button>
      ))}
    </div>
  );
}
