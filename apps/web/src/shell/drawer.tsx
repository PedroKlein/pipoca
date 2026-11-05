import { cn } from "@pipoca/ui";
import { type ReactElement, type ReactNode, useEffect, useRef } from "react";

// The sidebar, which on a phone slides in over a scrim while open. It takes
// focus, gives it back on closing, and closes on Escape, on following a
// link, or when the screen grows wide enough to show it beside the page.
export function Drawer({
  open,
  onClose,
  children,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly children: ReactNode;
}): ReactElement {
  const aside = useRef<HTMLElement>(null);
  const close = useRef(onClose);

  useEffect(() => {
    close.current = onClose;
  });

  useEffect(() => {
    if (!open) {
      return;
    }

    const opener = document.activeElement;

    aside.current
      ?.querySelector<HTMLElement>("a[href], button:not(:disabled), input")
      ?.focus();

    const wide = matchMedia("(width >= 48rem)");

    const shut = (): void => {
      close.current();
    };

    const shutOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        shut();
      }
    };

    wide.addEventListener("change", shut);
    document.addEventListener("keydown", shutOnEscape);

    return () => {
      wide.removeEventListener("change", shut);
      document.removeEventListener("keydown", shutOnEscape);

      if (opener instanceof HTMLElement && opener.isConnected) {
        opener.focus();
      }
    };
  }, [open]);

  return (
    <>
      <div
        aria-hidden="true"
        onClick={onClose}
        className={cn(
          "fixed inset-0 z-10 bg-scrim backdrop-blur-[2px] md:hidden",
          !open && "hidden",
        )}
      />
      <aside
        ref={aside}
        onClick={(event) => {
          if (event.target instanceof Element && event.target.closest("a")) {
            onClose();
          }
        }}
        className={cn(
          "z-20 w-sidebar shrink-0 border-r border-line max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:w-[min(320px,85vw)] max-md:shadow-pop",
          // Showing it at once lets focus move in; hiding it after the slide keeps the slide visible.
          open
            ? "max-md:motion-safe:transition-[translate]"
            : "max-md:invisible max-md:-translate-x-full max-md:motion-safe:transition-[translate,visibility]",
        )}
      >
        {children}
      </aside>
    </>
  );
}
