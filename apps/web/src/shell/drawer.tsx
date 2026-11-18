import { cn } from "@pipoca/ui";
import { type ReactElement, type ReactNode, useEffect, useRef } from "react";

// The sidebar, which on a phone slides in over a scrim while open. It takes
// focus, keeps it from what sits behind, gives it back on closing, and
// closes on Escape, on following a link, or once the window has room to
// show it beside the page.
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

    // The page and whatever is docked beside it.
    const behind = [...(aside.current?.parentElement?.children ?? [])].filter(
      (each): each is HTMLElement =>
        each instanceof HTMLElement &&
        each !== aside.current &&
        each.getAttribute("aria-hidden") !== "true" &&
        !each.inert,
    );

    for (const each of behind) {
      each.inert = true;
    }

    const shut = (): void => {
      close.current();
    };

    // A docked artifact also makes it a drawer, so the window's width alone
    // doesn't say when it sits beside the page again.
    const beside = (): void => {
      if (
        aside.current !== null &&
        getComputedStyle(aside.current).position !== "fixed"
      ) {
        shut();
      }
    };

    const shutOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        shut();
      }
    };

    addEventListener("resize", beside);
    document.addEventListener("keydown", shutOnEscape);

    return () => {
      removeEventListener("resize", beside);
      document.removeEventListener("keydown", shutOnEscape);

      for (const each of behind) {
        each.inert = false;
      }

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
          "fixed inset-0 z-10 hidden bg-scrim backdrop-blur-scrim",
          open && "drawer:block",
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
          "z-20 w-sidebar shrink-0 border-r border-line drawer:fixed drawer:inset-y-0 drawer:left-0 drawer:w-[min(320px,85vw)] drawer:shadow-pop",
          // Showing it at once lets focus move in; hiding it after the slide keeps the slide visible.
          open
            ? "drawer:motion-safe:transition-[translate]"
            : "drawer:invisible drawer:-translate-x-full drawer:motion-safe:transition-[translate,visibility]",
        )}
      >
        {children}
      </aside>
    </>
  );
}
