import {
  Button,
  cn,
  Dialog,
  FileButton,
  Icon,
  type IconName,
  popClass,
  TextInput,
  useDismiss,
} from "@pipoca/ui";
import {
  createContext,
  type ReactElement,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

// Something a plugin attaches to the next message without a copy, such as
// a file of the Project folder or an artifact: the composer shows it as a
// card and sends text that tells Pi where to read it.
export interface Attachment {
  readonly key: string;
  readonly icon: IconName;
  readonly title: string;
  readonly detail: string;
  readonly text: string;
  // Goes only with the person's own work, not the team's, such as their
  // own template.
  readonly personal?: boolean;
}

interface Menu {
  readonly rows: HTMLElement | null;
  readonly close: () => void;
  // Back to the message once a picker closes, as the row it opened from is
  // gone with the menu.
  readonly done: () => void;
}

const MenuContext = createContext<Menu | undefined>(undefined);

const rowClass =
  "flex min-h-9 w-full cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-label text-fg hover:bg-hover focus-visible:bg-hover focus-visible:outline-none";

// The composer's + button: upload from the computer, then the plugins'
// rows, such as the Project folder and an artifact (ADR 0081). children
// stay drawn while the menu is closed, so a picker a row opens stays open.
export function AttachMenu({
  label,
  accept,
  onFiles,
  children,
}: {
  readonly label: string;
  readonly accept?: string;
  readonly onFiles: (files: readonly File[]) => void;
  readonly children: ReactNode;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<HTMLElement | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const popId = useId();

  const close = (): void => {
    setOpen(false);
  };

  useDismiss(box, open, close);

  useEffect(() => {
    const element = box.current;

    if (!open || element === null) {
      return undefined;
    }

    const left = (event: FocusEvent): void => {
      if (
        event.relatedTarget instanceof Node &&
        !element.contains(event.relatedTarget)
      ) {
        setOpen(false);
      }
    };

    element.addEventListener("focusout", left);

    return () => {
      element.removeEventListener("focusout", left);
    };
  }, [open]);

  // Plugins' rows are portals, whose React events skip the popover, so it
  // hears the keys in the page.
  useEffect(() => {
    const element = pop.current;

    if (!open || element === null) {
      return undefined;
    }

    focusable(element)[0]?.focus();

    const move = (event: KeyboardEvent): void => {
      const all = focusable(element);
      const at = all.indexOf(document.activeElement as HTMLElement);

      const to = {
        ArrowDown: all[(at + 1) % all.length],
        ArrowUp: all[(at - 1 + all.length) % all.length],
        Home: all[0],
        End: all.at(-1),
      }[event.key];

      if (to !== undefined) {
        event.preventDefault();
        to.focus();
      }
    };

    element.addEventListener("keydown", move);

    return () => {
      element.removeEventListener("keydown", move);
    };
  }, [open]);

  return (
    <MenuContext
      value={{
        rows: open ? rows : null,
        close,
        done: () => {
          setTimeout(() => {
            box.current?.closest("form")?.querySelector("textarea")?.focus();
          });
        },
      }}
    >
      <div ref={box} className="relative -ml-2">
        <Button
          variant="ghost"
          iconOnly
          title={label}
          aria-label={label}
          aria-expanded={open}
          aria-controls={popId}
          className="aria-expanded:bg-hover"
          onClick={() => {
            setOpen(!open);
          }}
        >
          <Icon name="plus" />
        </Button>
        <div
          ref={pop}
          id={popId}
          role="group"
          aria-label={label}
          hidden={!open}
          className={cn(
            popClass,
            "absolute bottom-full left-0 z-30 mb-2 flex w-72 flex-col gap-0.5 p-1.5",
          )}
        >
          <FileButton
            bare
            icon="upload"
            multiple
            {...(accept !== undefined && { accept })}
            className={cn(rowClass, "has-focus-visible:bg-hover")}
            onFiles={(files) => {
              close();
              onFiles(files);
            }}
          >
            Upload from computer
          </FileButton>
          <div ref={setRows} className="flex flex-col gap-0.5 empty:hidden" />
          <p className="border-t border-line px-2 pt-2 pb-1 text-caption text-fg-dim">
            Or drop files anywhere, or paste a screenshot.
          </p>
        </div>
      </div>
      {children}
    </MenuContext>
  );
}

function focusable(within: HTMLElement | null): HTMLElement[] {
  return [...(within?.querySelectorAll<HTMLElement>("input, button") ?? [])];
}

// A plugin's row in the composer's + menu, drawn while the menu is open.
export function AttachRow({
  icon,
  label,
  onPick,
}: {
  readonly icon: IconName;
  readonly label: string;
  readonly onPick: () => void;
}): ReactElement | null {
  const menu = useContext(MenuContext);

  if (menu === undefined || menu.rows === null) {
    return null;
  }

  return createPortal(
    <button
      type="button"
      className={rowClass}
      onClick={() => {
        menu.close();
        onPick();
      }}
    >
      <Icon name={icon} className="size-4 shrink-0 text-fg-dim" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>,
    menu.rows,
  );
}

// What a row's picker offers, such as the folder's files.
export interface Pickable {
  readonly key: string;
  readonly title: string;
  readonly detail: string;
}

// The picker a plugin's row opens: a search over what it offers, and the
// one picked attaches.
export function AttachPicker({
  open,
  title,
  items,
  empty,
  onPick,
  onClose,
}: {
  readonly open: boolean;
  readonly title: string;
  // Undefined while loading.
  readonly items: readonly Pickable[] | undefined;
  readonly empty: string;
  readonly onPick: (key: string) => void;
  readonly onClose: () => void;
}): ReactElement {
  const menu = useContext(MenuContext);
  const list = useRef<HTMLUListElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const rowId = useId();
  const [search, setSearch] = useState("");
  const [searching, setSearching] = useState(false);
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);

  const shown = (items ?? []).filter((each) =>
    words.every((word) =>
      `${each.title} ${each.detail}`.toLowerCase().includes(word),
    ),
  );

  const close = (): void => {
    setSearch("");
    onClose();
    menu?.done();
  };

  const pick = (key: string): void => {
    close();
    onPick(key);
  };

  const rowsOf = (): HTMLButtonElement[] => [
    ...(list.current?.querySelectorAll("button") ?? []),
  ];

  return (
    <Dialog
      open={open}
      onClose={close}
      title={title}
      size="sm"
      initialFocus='input[type="search"]'
    >
      <div className="flex flex-col gap-3 px-6 pb-6">
        <TextInput
          ref={field}
          type="search"
          aria-label="Search"
          placeholder="Search"
          {...(searching &&
            shown.length > 0 && { "aria-activedescendant": `${rowId}-0` })}
          value={search}
          onFocus={() => {
            setSearching(true);
          }}
          onBlur={() => {
            setSearching(false);
          }}
          onChange={(event) => {
            setSearch(event.target.value);
          }}
          onKeyDown={(event) => {
            const [first] = shown;

            if (event.key === "Enter" && first !== undefined) {
              event.preventDefault();
              pick(first.key);
            } else if (event.key === "ArrowDown") {
              event.preventDefault();
              rowsOf()[0]?.focus();
            }
          }}
        />
        <ul
          ref={list}
          aria-label={title}
          className="flex max-h-80 flex-col gap-0.5 overflow-y-auto"
          onKeyDown={(event) => {
            const rows = rowsOf();

            const at = rows.indexOf(
              document.activeElement as HTMLButtonElement,
            );

            const to = { ArrowDown: at + 1, ArrowUp: at - 1 }[event.key];

            if (to === -1) {
              event.preventDefault();
              field.current?.focus();
            } else if (to !== undefined) {
              event.preventDefault();
              rows[Math.min(to, rows.length - 1)]?.focus();
            }
          }}
        >
          {shown.map((each, at) => (
            <li key={each.key}>
              <button
                id={`${rowId}-${String(at)}`}
                type="button"
                className={cn(rowClass, searching && at === 0 && "bg-hover")}
                onClick={() => {
                  pick(each.key);
                }}
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{each.title}</span>
                  <span className="truncate text-caption text-fg-dim">
                    {each.detail}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
        {items !== undefined && shown.length === 0 && (
          <p className="text-label text-fg-dim">
            {words.length > 0 ? "Nothing matches." : empty}
          </p>
        )}
        {items === undefined && (
          <p className="text-label text-fg-dim">Loading…</p>
        )}
      </div>
    </Dialog>
  );
}

// A card in the composer for something attached to the next message, with
// how far its upload got.
export function AttachedCard({
  icon,
  title,
  detail,
  progress,
  failed = false,
  onRemove,
}: {
  readonly icon: IconName;
  readonly title: string;
  readonly detail: string;
  // From 0 to 1 while it uploads.
  readonly progress?: number;
  readonly failed?: boolean;
  readonly onRemove: () => void;
}): ReactElement {
  return (
    <span className="relative flex h-16 max-w-60 min-w-0 items-center gap-2.5 rounded-lg border border-line bg-elevated px-3">
      <Icon name={icon} className="size-4 shrink-0 text-fg-dim" />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate text-label text-fg-strong">{title}</span>
        {progress !== undefined && (
          <span
            role="progressbar"
            aria-label={`Saving ${title}`}
            aria-valuenow={Math.round(progress * 100)}
            className="h-1 w-36 overflow-hidden rounded-full bg-hover"
          >
            <span
              className="block h-full rounded-full bg-working"
              style={{ width: `${String(progress * 100)}%` }}
            />
          </span>
        )}
        <span
          title={detail}
          className={cn(
            "truncate text-caption",
            failed ? "text-failed" : "text-fg-dim",
          )}
        >
          {detail}
        </span>
      </span>
      <button
        type="button"
        aria-label={`Remove ${title}`}
        onClick={onRemove}
        className="absolute -top-1.5 -right-1.5 flex size-5 cursor-pointer items-center justify-center rounded-full border border-line bg-panel text-fg-dim before:absolute before:-inset-3 before:content-[''] hover:text-fg focus-visible:ring-4 focus-visible:ring-focus focus-visible:outline-none"
      >
        <Icon name="x" className="size-3" />
      </button>
    </span>
  );
}
