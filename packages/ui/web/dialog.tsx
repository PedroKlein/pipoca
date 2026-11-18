import {
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { Button } from "./button";
import { cn } from "./cn";
import { Icon } from "./icon";

const sizes = {
  sm: "w-[min(480px,calc(100vw-32px))]",
  md: "w-[min(600px,calc(100vw-32px))]",
  lg: "w-[min(720px,calc(100vw-32px))]",
  // Almost the whole window, such as a viewer; all of it on a phone.
  full: "h-[calc(100dvh-56px)] max-h-none w-[calc(100vw-80px)] max-w-none max-sm:h-dvh max-sm:w-screen max-sm:rounded-none",
} as const;

// A modal on the browser's own dialog, which traps focus and closes on
// Escape. Its content mounts only while it is open, so a form inside starts
// fresh each time.
export function Dialog({
  open,
  onClose,
  title,
  description,
  labelledBy,
  size = "md",
  sheet = false,
  initialFocus,
  className,
  children,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  // Draws the heading with a close button. Without it, the content names
  // the dialog through labelledBy.
  readonly title?: ReactNode;
  readonly description?: ReactNode;
  readonly labelledBy?: string;
  readonly size?: keyof typeof sizes;
  // On a phone, a sheet from the bottom edge.
  readonly sheet?: boolean;
  // A selector for what takes focus on opening, instead of the first control.
  readonly initialFocus?: string;
  readonly className?: string;
  readonly children: ReactNode;
}): ReactElement {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  // Focus goes back to what opened the dialog, also when the dialog leaves
  // the page without closing, such as when Back takes it away.
  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const opener = document.activeElement;

    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) {
        opener.focus();
      }
    };
  }, [open]);

  useEffect(() => {
    const element = dialog.current;

    if (element === null) {
      return;
    }

    if (open && !element.open) {
      element.showModal();

      if (initialFocus !== undefined) {
        element.querySelector<HTMLElement>(initialFocus)?.focus();
      }
    } else if (!open && element.open) {
      element.close();
    }
  }, [open, initialFocus]);

  return (
    <dialog
      ref={dialog}
      onClose={(event) => {
        // A dialog opened from this one closes only itself.
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
      aria-labelledby={title === undefined ? labelledBy : titleId}
      className={cn(
        "m-auto overflow-visible rounded-xl border border-line bg-elevated p-0 text-fg shadow-pop backdrop:bg-scrim backdrop:backdrop-blur-scrim open:animate-pop-in",
        sizes[size],
        sheet && "max-sm:mb-0 max-sm:w-full max-sm:rounded-b-none",
        className,
      )}
    >
      {open &&
        (title === undefined ? (
          children
        ) : (
          <div className="flex flex-col">
            <DialogHead
              id={titleId}
              title={title}
              description={description}
              onClose={onClose}
            />
            {children}
          </div>
        ))}
    </dialog>
  );
}

export function DialogHead({
  id,
  title,
  description,
  onClose,
}: {
  readonly id: string;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly onClose?: () => void;
}): ReactElement {
  return (
    <header className="flex items-start gap-3 px-6 pt-5.5 pb-1">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <h2
          id={id}
          className="text-[18px] font-semibold text-balance text-fg-strong"
        >
          {title}
        </h2>
        {description !== undefined && (
          <p className="text-label text-fg-dim">{description}</p>
        )}
      </div>
      {onClose !== undefined && (
        <Button variant="ghost" iconOnly aria-label="Close" onClick={onClose}>
          <Icon name="x" />
        </Button>
      )}
    </header>
  );
}

export function DialogBody({
  className,
  children,
}: {
  readonly className?: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <div className={cn("flex flex-col gap-4.5 px-6 pt-4 pb-5", className)}>
      {children}
    </div>
  );
}

// The dialog's buttons, on a line under a rule. The main one goes last.
export function DialogFoot({
  children,
}: {
  readonly children: ReactNode;
}): ReactElement {
  return (
    <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-6 py-3.5">
      {children}
    </footer>
  );
}

export interface ConfirmOptions {
  readonly title: string;
  readonly description?: ReactNode;
  // Says what happens, such as "Delete".
  readonly confirm?: string | undefined;
  // Draws the confirming button as a deletion.
  readonly danger?: boolean | undefined;
}

// Asks before something that can't be undone, in place of window.confirm.
export function ConfirmDialog({
  open,
  title,
  description,
  confirm = "Continue",
  danger = false,
  onConfirm,
  onCancel,
}: ConfirmOptions & {
  readonly open: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}): ReactElement {
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={title}
      description={description}
      size="sm"
    >
      <DialogFoot>
        <Button onClick={onCancel}>Cancel</Button>
        <Button
          variant={danger ? "danger" : "primary"}
          autoFocus
          onClick={onConfirm}
        >
          {confirm}
        </Button>
      </DialogFoot>
    </Dialog>
  );
}

// confirm() that resolves once the person answers the returned dialog,
// which the caller renders.
export function useConfirm(): readonly [
  (options: ConfirmOptions) => Promise<boolean>,
  ReactElement,
] {
  const [asking, setAsking] = useState<
    ConfirmOptions & {
      readonly asked: number;
      readonly answer: (yes: boolean) => void;
    }
  >();

  const asked = useRef(0);
  const waiting = useRef<(yes: boolean) => void>(undefined);

  // A new question answers the one still open no.
  const ask = useCallback(
    async (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        waiting.current?.(false);
        waiting.current = resolve;
        asked.current++;

        setAsking({
          ...options,
          asked: asked.current,
          answer: (yes) => {
            waiting.current = undefined;
            setAsking(undefined);
            resolve(yes);
          },
        });
      }),
    [],
  );

  // Each question gets its own dialog: Escape closes the last one at once
  // but says so a moment later, by when the next may be asking.
  const dialog = (
    <ConfirmDialog
      key={asking?.asked}
      open={asking !== undefined}
      title={asking?.title ?? ""}
      description={asking?.description}
      confirm={asking?.confirm}
      danger={asking?.danger}
      onConfirm={() => {
        asking?.answer(true);
      }}
      onCancel={() => {
        asking?.answer(false);
      }}
    />
  );

  return [ask, dialog] as const;
}
