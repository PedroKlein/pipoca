import type { ReactElement, ReactNode } from "react";
import { cn } from "./cn";

const pickedClass =
  "has-checked:border-accent has-checked:ring-3 has-checked:ring-focus";

// One option among a few, as a card with its own description, that can
// show more once picked. A radio picks one; a checkbox may pick several.
export function ChoiceCard({
  type = "radio",
  name,
  value,
  checked,
  disabled,
  onChange,
  title,
  badge,
  description,
  as: Root = "div",
  children,
}: {
  readonly type?: "radio" | "checkbox";
  readonly name?: string;
  readonly value?: string;
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly onChange?: (checked: boolean) => void;
  readonly title: ReactNode;
  readonly badge?: ReactNode;
  readonly description?: ReactNode;
  // A list item, for a list of choices.
  readonly as?: "div" | "li";
  // Shown under the description while the choice is picked.
  readonly children?: ReactNode;
}): ReactElement {
  return (
    <Root
      className={cn(
        "flex flex-col gap-3 rounded-lg border border-line bg-elevated p-4 transition-[border-color,box-shadow] duration-150 hover:border-line-strong",
        pickedClass,
      )}
    >
      <label className="flex cursor-pointer items-start gap-3 has-disabled:cursor-default">
        <input
          type={type}
          name={name}
          value={value}
          checked={checked}
          disabled={disabled ?? onChange === undefined}
          onChange={(event) => {
            onChange?.(event.target.checked);
          }}
          className="mt-0.5 size-4.5 shrink-0 cursor-pointer accent-(--accent) disabled:cursor-default"
        />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="flex flex-wrap items-center gap-2 text-ui font-medium text-fg-strong">
            {title}
            {badge}
          </span>
          {description !== undefined && (
            <span className="text-label text-fg-dim">{description}</span>
          )}
        </span>
      </label>
      {checked && children !== undefined && (
        <div className="pl-7.5">{children}</div>
      )}
    </Root>
  );
}

export interface Tile<T extends string> {
  readonly value: T;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  // A mark above the title, such as a logo.
  readonly leading?: ReactNode;
}

const columnClasses = {
  2: "grid-cols-1 sm:grid-cols-2",
  3: "grid-cols-1 sm:grid-cols-3",
  4: "grid-cols-2 md:grid-cols-4",
} as const;

// A grid of tiles to pick one from, such as how each Session runs. Each
// tile is a radio, so a form reads the choice by name.
export function ChoiceTiles<T extends string>({
  label,
  name,
  tiles,
  value,
  columns = 2,
  onChange,
  children,
}: {
  readonly label: string;
  readonly name: string;
  readonly tiles: readonly Tile<T>[];
  readonly value: T | undefined;
  readonly columns?: keyof typeof columnClasses;
  readonly onChange: (value: T) => void;
  // More cells after the tiles, such as a search for the rest.
  readonly children?: ReactNode;
}): ReactElement {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn("grid gap-2.5", columnClasses[columns])}
    >
      {tiles.map((tile) => (
        <label
          key={tile.value}
          className={cn(
            "flex cursor-pointer flex-col items-start gap-2 rounded-lg border border-line bg-elevated p-3.5 transition-[border-color,box-shadow] duration-150 hover:border-line-strong has-focus-visible:border-line-focus",
            pickedClass,
          )}
        >
          <input
            type="radio"
            name={name}
            value={tile.value}
            checked={tile.value === value}
            onChange={() => {
              onChange(tile.value);
            }}
            className="sr-only"
          />
          {tile.leading}
          <span className="text-ui font-medium text-fg-strong">
            {tile.title}
          </span>
          {tile.description !== undefined && (
            <span className="text-label text-fg-dim">{tile.description}</span>
          )}
        </label>
      ))}
      {children}
    </div>
  );
}
