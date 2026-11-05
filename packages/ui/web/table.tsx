import type { ReactElement, ReactNode, TdHTMLAttributes } from "react";
import { cardClass } from "./card";
import { cn } from "./cn";

// A table on a card that scrolls sideways on a phone. Rows are Cell rows.
export function Table({
  label,
  columns,
  minWidth = true,
  bare = false,
  className,
  children,
}: {
  readonly label?: string;
  // Header cells; a string names a column, and an empty one stays unnamed.
  readonly columns: readonly ReactNode[];
  // Keeps the columns wide enough to read and scrolls instead.
  readonly minWidth?: boolean;
  // Leaves out the card, for a table inside one.
  readonly bare?: boolean;
  readonly className?: string;
  readonly children: ReactNode;
}): ReactElement {
  const table = (
    <table
      aria-label={label}
      className={cn("w-full border-collapse text-ui", minWidth && "min-w-xl")}
    >
      <thead>
        <tr>
          {columns.map((column, index) => (
            <th
              // Columns never move, so their place is their identity.
              key={index}
              className="px-4 py-2.5 text-left text-caption font-medium text-fg-dim"
            >
              {column}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );

  return bare ? (
    table
  ) : (
    <div className={cn("overflow-x-auto", cardClass, className)}>{table}</div>
  );
}

export function Cell({
  className,
  ...props
}: TdHTMLAttributes<HTMLTableCellElement>): ReactElement {
  return (
    <td
      className={cn("border-t border-line px-4 py-3 align-middle", className)}
      {...props}
    />
  );
}
