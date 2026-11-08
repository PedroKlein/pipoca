import { type ReactElement, type ReactNode, useEffect } from "react";
import { Button } from "./button";
import { cn } from "./cn";
import { Icon } from "./icon";

const sizes = {
  md: "w-[min(640px,100vw)]",
  lg: "w-[min(760px,100vw)]",
} as const;

// A panel over the right edge that leaves the page usable, such as a
// Session's changes. Escape closes it.
export function SidePanel({
  open,
  onClose,
  title,
  closeLabel = "Close",
  size = "md",
  docked = false,
  className,
  children,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title: string;
  readonly closeLabel?: string;
  readonly size?: keyof typeof sizes;
  // On a wide screen, beside what comes before it in a flex row instead of
  // over it, so both stay in view.
  readonly docked?: boolean;
  // For the scrolling body, such as the gap between its items.
  readonly className?: string;
  readonly children: ReactNode;
}): ReactElement {
  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const close = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    document.addEventListener("keydown", close);

    return () => {
      document.removeEventListener("keydown", close);
    };
  }, [open, onClose]);

  return (
    <section
      role="dialog"
      aria-label={title}
      hidden={!open}
      className={cn(
        "fixed inset-y-0 right-0 z-40 flex flex-col border-l border-line bg-panel text-ui text-fg shadow-pop",
        sizes[size],
        docked &&
          "lg:relative lg:inset-auto lg:z-auto lg:w-[min(720px,50%)] lg:shrink-0 lg:shadow-none",
      )}
    >
      <header className="flex min-h-14 items-center gap-2 border-b border-line px-4">
        <h2 className="flex-1 font-semibold text-fg-strong">{title}</h2>
        <Button
          variant="ghost"
          iconOnly
          aria-label={closeLabel}
          onClick={onClose}
        >
          <Icon name="x" />
        </Button>
      </header>
      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col overflow-auto p-4",
          className,
        )}
      >
        {children}
      </div>
    </section>
  );
}
