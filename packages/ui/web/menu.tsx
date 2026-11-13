import {
  Fragment,
  type ReactElement,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { Button } from "./button";
import { cn } from "./cn";
import { Icon, type IconName } from "./icon";

export interface MenuItem {
  readonly label: string;
  // A line under the label on what the item does.
  readonly description?: string;
  readonly icon?: IconName;
  // Drawn before the label in place of an icon, such as an avatar.
  readonly mark?: ReactNode;
  // The keys that do the same, such as ⌘1.
  readonly shortcut?: string;
  readonly danger?: boolean;
  // Makes the item one of a set, checked or not.
  readonly checked?: boolean;
  // Draws a rule above the item.
  readonly divided?: boolean;
  readonly run: () => void;
}

// The look of a popover: an elevated card with the pop shadow.
export const popClass =
  "rounded-lg border border-line bg-elevated p-1 shadow-pop animate-pop-in";

// A button that opens a short list of actions. A click outside or Escape
// closes it.
export function Menu({
  label,
  items,
  icon = "more",
  trigger,
  align = "end",
  side = "below",
  className,
  triggerClassName,
}: {
  readonly label: string;
  readonly items: readonly MenuItem[];
  readonly icon?: IconName;
  // Draws the button with this content instead of the icon alone. The
  // label still names it.
  readonly trigger?: ReactNode;
  // Stretch spans the menu across the button's box.
  readonly align?: "start" | "end" | "stretch";
  // Opens upward, for a button at the bottom of the screen.
  readonly side?: "below" | "above";
  readonly className?: string;
  readonly triggerClassName?: string;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const close = (event: Event): void => {
      if (
        event instanceof KeyboardEvent
          ? event.key === "Escape"
          : box.current?.contains(event.target as Node) !== true
      ) {
        setOpen(false);
      }
    };

    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);

    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  return (
    <div ref={box} className={cn("relative", className)}>
      <Button
        variant="ghost"
        iconOnly={trigger === undefined}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
        }}
        className={triggerClassName}
      >
        {trigger ?? <Icon name={icon} />}
      </Button>
      {open && (
        <div
          role="menu"
          aria-label={label}
          className={cn(
            "absolute z-30 flex flex-col",
            items.some(({ description }) => description !== undefined)
              ? "min-w-64"
              : "min-w-48",
            side === "below" ? "top-full mt-1" : "bottom-full mb-1",
            { start: "left-0", end: "right-0", stretch: "inset-x-0" }[align],
            popClass,
          )}
        >
          {items.map((item) => (
            <Fragment key={item.label}>
              {item.divided === true && <hr className="my-1 border-line" />}
              <button
                type="button"
                role={item.checked === undefined ? "menuitem" : "menuitemradio"}
                aria-checked={item.checked}
                onClick={() => {
                  setOpen(false);
                  item.run();
                }}
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-ui hover:bg-hover",
                  item.danger === true ? "text-failed" : "text-fg",
                )}
              >
                {item.checked !== undefined && (
                  <Icon
                    name="check"
                    className={cn(!item.checked && "invisible")}
                  />
                )}
                {item.icon !== undefined && <Icon name={item.icon} />}
                {item.mark}
                {item.description === undefined ? (
                  item.label
                ) : (
                  <span className="flex flex-1 flex-col py-0.5">
                    {item.label}
                    <span className="text-caption text-fg-dim">
                      {item.description}
                    </span>
                  </span>
                )}
                {item.shortcut !== undefined && (
                  <kbd className="ml-auto pl-3 font-mono text-mono-sm text-fg-dim">
                    {item.shortcut}
                  </kbd>
                )}
              </button>
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}
