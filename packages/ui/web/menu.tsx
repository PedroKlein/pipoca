import {
  Fragment,
  type ReactElement,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Button, type ButtonSize, type ButtonVariant } from "./button";
import { cn } from "./cn";
import { Icon, type IconName } from "./icon";

export interface MenuItem {
  readonly label: string;
  // A word beside the label, such as latest.
  readonly badge?: string;
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
  readonly disabled?: boolean;
  readonly run: () => void;
}

// The look of a popover: an elevated card with the pop shadow.
export const popClass =
  "rounded-lg border border-line bg-elevated p-1 shadow-pop animate-pop-in";

// Closes what opened in box on Escape, giving its button focus again, or on
// a press outside it.
export function useDismiss(
  box: RefObject<HTMLElement | null>,
  open: boolean,
  close: () => void,
): void {
  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const dismiss = (event: Event): void => {
      if (event instanceof KeyboardEvent && event.key === "Escape") {
        // Inside a dialog, Escape closes only this.
        event.preventDefault();
        close();
        box.current?.querySelector("button")?.focus();
      } else if (
        !(event instanceof KeyboardEvent) &&
        box.current?.contains(event.target as Node) !== true
      ) {
        close();
      }
    };

    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", dismiss);

    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", dismiss);
    };
  }, [box, open, close]);
}

// A button that opens a short list of actions. A click outside or Escape
// closes it.
export function Menu({
  label,
  heading,
  items,
  icon = "more",
  trigger,
  align = "end",
  side = "below",
  className,
  variant = "ghost",
  size,
  triggerClassName,
}: {
  readonly label: string;
  // A line above the items on what they are.
  readonly heading?: string;
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
  // The button's look, a quiet icon unless the menu says otherwise.
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly triggerClassName?: string;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  const shut = useCallback(() => {
    setOpen(false);
  }, []);

  useDismiss(box, open, shut);

  return (
    <div ref={box} className={cn("relative", className)}>
      <Button
        variant={variant}
        {...(size !== undefined && { size })}
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
              ? "w-max max-w-[min(22rem,calc(100vw-2rem))] min-w-64"
              : "min-w-48",
            side === "below" ? "top-full mt-1" : "bottom-full mb-1",
            { start: "left-0", end: "right-0", stretch: "inset-x-0" }[align],
            popClass,
          )}
        >
          {heading !== undefined && (
            <p className="px-2.5 pt-1.5 pb-1 text-caption font-medium text-fg">
              {heading}
            </p>
          )}
          {items.map((item, at) => (
            // Two items may read the same, such as edits by one person.
            <Fragment key={`${String(at)}:${item.label}`}>
              {item.divided === true && <hr className="my-1 border-line" />}
              <button
                type="button"
                role={item.checked === undefined ? "menuitem" : "menuitemradio"}
                aria-checked={item.checked}
                aria-disabled={item.disabled}
                onClick={() => {
                  if (item.disabled === true) {
                    return;
                  }

                  setOpen(false);
                  item.run();
                }}
                className={cn(
                  "flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-ui",
                  item.disabled === true
                    ? "cursor-default text-fg-dim"
                    : "cursor-pointer hover:bg-hover",
                  item.disabled !== true &&
                    (item.danger === true ? "text-failed" : "text-fg"),
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
                  <Label item={item} />
                ) : (
                  <span className="flex flex-1 flex-col py-0.5">
                    <Label item={item} />
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

function Label({ item }: { readonly item: MenuItem }): ReactNode {
  return item.badge === undefined ? (
    item.label
  ) : (
    <span className="flex items-center gap-2">
      {item.label}{" "}
      <span className="rounded-sm bg-hover px-1.5 text-caption text-fg-dim">
        {item.badge}
      </span>
    </span>
  );
}
