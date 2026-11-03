import type { ReactElement, ReactNode } from "react";
import { cn } from "./cn";

// A card of rows, each one a setting or an item with its controls on the
// right, as Settings draws them.
export function Rows({
  label,
  children,
}: {
  readonly label?: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <ul
      aria-label={label}
      className="flex flex-col rounded-lg border border-line bg-elevated shadow-xs"
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
  children,
  className,
}: {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  // A short mark for the item, such as "Gh" for GitHub.
  readonly initials?: string;
  // Draws the mark as a person's avatar.
  readonly round?: boolean;
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
        <span
          aria-hidden="true"
          className={cn(
            "grid shrink-0 place-items-center bg-hover font-semibold text-fg-strong",
            round
              ? "size-11 rounded-full text-prose"
              : "size-8.5 rounded-md border border-line text-label",
          )}
        >
          {initials}
        </span>
      )}
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

// Two letters for a name's mark: its first letter, then the first letter of
// its next word or capital ("GitHub" is Gh), or else its second letter.
export function initialsOf(name: string): string {
  const [first = "", ...rest] =
    name
      .match(/\p{Lu}?[\p{Ll}\p{N}]*|\p{Lu}+/gu)
      ?.filter((part) => part !== "") ?? [];

  const second = rest[0]?.[0] ?? first[1] ?? "";

  return first.slice(0, 1).toUpperCase() + second.toLowerCase();
}

// A choice between a few options, all in view, that saves when picked.
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  readonly label: string;
  readonly options: readonly { readonly value: T; readonly label: string }[];
  readonly value: T;
  readonly onChange: (value: T) => void;
}): ReactElement {
  return (
    <div
      role="group"
      aria-label={label}
      className="inline-flex shrink-0 gap-0.5 rounded-md bg-hover p-0.75"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => {
            onChange(option.value);
          }}
          className="h-7 cursor-pointer rounded-sm px-3 text-label font-medium text-fg-dim transition-colors aria-pressed:bg-elevated aria-pressed:text-fg-strong aria-pressed:shadow-xs"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
