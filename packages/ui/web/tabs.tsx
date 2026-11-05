import type { ReactElement, ReactNode } from "react";
import { cn } from "./cn";

export interface Tab<T extends string> {
  readonly value: T;
  readonly label: ReactNode;
  // A tab with an address is a link, so it can be opened and shared.
  readonly href?: string;
}

const tabClass =
  "-mb-px shrink-0 cursor-pointer border-b-2 border-transparent px-3 py-2 text-ui text-fg-dim transition-colors hover:text-fg aria-[current=page]:border-accent aria-[current=page]:font-medium aria-[current=page]:text-fg-strong aria-selected:border-accent aria-selected:font-medium aria-selected:text-fg-strong";

// Pages of one thing, side by side over a line. Link tabs are a navigation
// that marks the current page; others are a tablist that calls onSelect.
export function Tabs<T extends string>({
  label,
  tabs,
  value,
  onSelect,
  className,
}: {
  readonly label: string;
  readonly tabs: readonly Tab<T>[];
  readonly value: T | undefined;
  readonly onSelect?: (value: T) => void;
  readonly className?: string;
}): ReactElement {
  const boxClass = cn(
    "flex gap-0.5 overflow-x-auto border-b border-line",
    className,
  );

  if (onSelect === undefined) {
    return (
      <nav aria-label={label} className={boxClass}>
        {tabs.map((tab) => (
          <a
            key={tab.value}
            href={tab.href}
            aria-current={tab.value === value ? "page" : undefined}
            className={tabClass}
          >
            {tab.label}
          </a>
        ))}
      </nav>
    );
  }

  return (
    <div role="tablist" aria-label={label} className={boxClass}>
      {tabs.map((tab) => (
        <button
          key={tab.value}
          type="button"
          role="tab"
          aria-selected={tab.value === value}
          onClick={() => {
            onSelect(tab.value);
          }}
          className={tabClass}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
