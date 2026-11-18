import {
  Button,
  cn,
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
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

interface Section {
  readonly name: string;
  readonly order: number;
  readonly title: string | undefined;
  readonly count: number;
  readonly acts: boolean;
}

interface Menu {
  readonly open: boolean;
  readonly filter: string;
  readonly bodies: ReadonlyMap<string, HTMLElement>;
  readonly add: (section: Section) => () => void;
  readonly close: () => void;
}

const MenuContext = createContext<Menu | undefined>(undefined);

interface Host {
  readonly sections: readonly Section[];
  readonly menu: Menu;
  readonly setOpen: (open: boolean) => void;
  readonly setFilter: (filter: string) => void;
  readonly setBody: (key: string, body: HTMLElement | null) => void;
}

const HostContext = createContext<Host | undefined>(undefined);

const ignore = (): void => undefined;

// One Files button in a Session's header whose sections plugins fill, such
// as artifacts, what Pi made, uploads and the Project folder (ADR 0081).
// The app draws it around a Session's view, and FilesMenu in its header.
export function FilesMenuHost({
  children,
}: {
  readonly children: ReactNode;
}): ReactElement {
  const [sections, setSections] = useState<readonly Section[]>([]);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");

  const [bodies, setBodies] = useState<ReadonlyMap<string, HTMLElement>>(
    new Map(),
  );

  const add = useCallback((section: Section) => {
    setSections((now) => [
      ...now.filter(({ name }) => name !== section.name),
      section,
    ]);

    return () => {
      setSections((now) => now.filter(({ name }) => name !== section.name));
    };
  }, []);

  const setBody = useCallback((key: string, body: HTMLElement | null) => {
    setBodies((now) => {
      if (now.get(key) === (body ?? undefined)) {
        return now;
      }

      const next = new Map(now);

      if (body === null) {
        next.delete(key);
      } else {
        next.set(key, body);
      }

      return next;
    });
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    setFilter("");
  }, []);

  const menu = useMemo(
    () => ({ open, filter, bodies, add, close }),
    [open, filter, bodies, add, close],
  );

  const host = useMemo(
    () => ({ sections, menu, setOpen, setFilter, setBody }),
    [sections, menu, setBody],
  );

  return (
    <HostContext value={host}>
      <MenuContext value={menu}>{children}</MenuContext>
    </HostContext>
  );
}

// The header's button, which shows once a section has something to list.
export function FilesMenu(): ReactElement | null {
  const host = useContext(HostContext);
  const box = useRef<HTMLDivElement>(null);
  const setBody = host?.setBody;

  const body = useCallback(
    (element: HTMLElement | null) => {
      const key = element?.dataset["body"];

      if (key === undefined || setBody === undefined) {
        return undefined;
      }

      setBody(key, element);

      return () => {
        setBody(key, null);
      };
    },
    [setBody],
  );

  const sections = [...(host?.sections ?? [])].sort(
    (a, b) => a.order - b.order,
  );

  const count = sections.reduce((sum, { count: each }) => sum + each, 0);
  const open = (host?.menu.open ?? false) && count > 0;

  useDismiss(box, open, host?.menu.close ?? ignore);

  if (host === undefined || count === 0) {
    return null;
  }

  return (
    <div ref={box} data-files-menu className="relative">
      <Button
        variant="ghost"
        className="aria-expanded:bg-hover aria-expanded:text-fg-strong"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`Files, ${String(count)}`}
        onClick={() => {
          if (open) {
            host.menu.close();
          } else {
            host.setOpen(true);
          }
        }}
      >
        <Icon name="file" className="size-3.5" />
        {`Files ${String(count)}`}
      </Button>
      <div
        role="dialog"
        aria-label="Files"
        hidden={!open}
        className={cn(
          popClass,
          "absolute top-full right-0 z-30 mt-1 flex max-h-[min(36rem,calc(100dvh-6rem))] w-[min(26rem,calc(100vw-2rem))] flex-col p-0 max-sm:right-auto max-sm:left-0",
        )}
      >
        <div className="flex gap-2 border-b border-line p-3">
          <span className="relative min-w-0 flex-1">
            <Icon
              name="search"
              className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-fg-dim"
            />
            <TextInput
              aria-label="Filter files"
              placeholder="Filter"
              className="w-full pl-8"
              value={host.menu.filter}
              onChange={(event) => {
                host.setFilter(event.target.value);
              }}
            />
          </span>
          {sections
            .filter(({ acts }) => acts)
            .map(({ name }) => (
              <span
                key={name}
                ref={body}
                data-body={`${name}:action`}
                className="flex"
              />
            ))}
        </div>
        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto p-3">
          {sections.map((section) => (
            <section
              key={section.name}
              ref={body}
              data-body={section.name}
              aria-label={section.title}
              className="flex flex-col empty:hidden"
            />
          ))}
          <p className="hidden px-1 py-2 text-label text-fg-dim [div:not(:has(>section:not(:empty)))>&]:block">
            {`Nothing matches “${host.menu.filter.trim()}”.`}
          </p>
        </div>
      </div>
    </div>
  );
}

// A plugin's part of the Files menu, drawn while the menu is open. Its rows
// say how many it lists for the button, and the filter narrows them.
export function FilesSection({
  name,
  order,
  title,
  count,
  action,
  children,
}: {
  readonly name: string;
  // Lowest first.
  readonly order: number;
  // Its heading; without one, a note under the sections.
  readonly title?: string;
  readonly count: number;
  // Beside the filter, such as Upload.
  readonly action?: ReactNode;
  readonly children: (filter: string) => ReactNode;
}): ReactElement | null {
  const menu = useContext(MenuContext);
  const add = menu?.add;
  const acts = action !== undefined;

  useEffect(
    () => add?.({ name, order, title, count, acts }),
    [add, name, order, title, count, acts],
  );

  const body = menu?.bodies.get(name);
  const actionBody = menu?.bodies.get(`${name}:action`);

  if (menu === undefined || !menu.open || body === undefined) {
    return null;
  }

  const rows = children(menu.filter.trim().toLowerCase());
  const empty = rows === null || (Array.isArray(rows) && rows.length === 0);

  return (
    <>
      {!empty &&
        createPortal(
          <>
            {title !== undefined && (
              <h3 className="px-1 pb-1 text-caption font-semibold text-fg-strong">
                {title}
              </h3>
            )}
            {rows}
          </>,
          body,
        )}
      {actionBody !== undefined && createPortal(action, actionBody)}
    </>
  );
}

// One line of a section, which opens what it names and closes the menu.
export function FilesRow({
  icon = "file",
  name,
  detail,
  onOpen,
}: {
  readonly icon?: IconName;
  readonly name: string;
  readonly detail?: string;
  readonly onOpen: () => void;
}): ReactElement {
  const menu = useContext(MenuContext);

  return (
    <button
      type="button"
      className="flex min-h-9 items-center gap-2.5 rounded-md px-1 py-1.5 text-left text-label text-fg hover:bg-hover focus-visible:bg-hover focus-visible:outline-none"
      onClick={(event) => {
        // What it opens gives focus back to the Files button, not to this
        // row, which the closed menu hides.
        event.currentTarget
          .closest("[data-files-menu]")
          ?.querySelector("button")
          ?.focus();

        menu?.close();
        onOpen();
      }}
    >
      <Icon name={icon} className="size-3.5 shrink-0 text-fg-dim" />
      <span className="min-w-0 flex-1 truncate">{name}</span>
      {detail !== undefined && (
        <span className="shrink-0 text-caption text-fg-dim">{detail}</span>
      )}
    </button>
  );
}
