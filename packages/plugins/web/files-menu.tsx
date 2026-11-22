import { Icon, type IconName, SearchInput } from "@pipoca/ui";
import {
  Children,
  createContext,
  type ReactElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { SessionSection } from "./session-panel";

interface Section {
  readonly name: string;
  readonly order: number;
  readonly title: string | undefined;
  readonly count: number;
  readonly acts: boolean;
}

interface Menu {
  readonly filter: string;
  readonly bodies: ReadonlyMap<string, HTMLElement>;
  readonly add: (section: Section) => () => void;
}

const MenuContext = createContext<Menu | undefined>(undefined);

interface Host {
  readonly sections: readonly Section[];
  readonly menu: Menu;
  readonly setFilter: (filter: string) => void;
  readonly setBody: (key: string, body: HTMLElement | null) => void;
}

const HostContext = createContext<Host | undefined>(undefined);

// How many rows of each part the panel's summary shows.
const summaryRows = 2;

// The Files section of a Session's panel, whose parts plugins fill, such as
// artifacts, what Pi made, uploads and the Project folder (ADR 0081, ADR
// 0084). The app draws the host around a Session's view and FilesMenu in
// its panel.
export function FilesMenuHost({
  children,
}: {
  readonly children: ReactNode;
}): ReactElement {
  const [sections, setSections] = useState<readonly Section[]>([]);
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

  const menu = useMemo(() => ({ filter, bodies, add }), [filter, bodies, add]);

  const host = useMemo(
    () => ({ sections, menu, setFilter, setBody }),
    [sections, menu, setBody],
  );

  return (
    <HostContext value={host}>
      <MenuContext value={menu}>{children}</MenuContext>
    </HostContext>
  );
}

// The panel's Files section, which shows once a part has something to list.
export function FilesMenu(): ReactElement | null {
  const host = useContext(HostContext);
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

  if (host === undefined || count === 0) {
    return null;
  }

  const parts = (prefix: string): ReactNode =>
    sections.map((section) => (
      <section
        key={section.name}
        ref={body}
        data-body={`${prefix}${section.name}`}
        aria-label={section.title}
        className="flex flex-col empty:hidden"
      />
    ));

  return (
    <SessionSection
      name="files"
      order={10}
      label="Files"
      icon="file"
      button={`Files, ${String(count)}`}
      badge={String(count)}
      detail={
        <div className="flex flex-col gap-3">
          <ClearsFilter clear={host.setFilter} />
          <div className="flex gap-2">
            <SearchInput
              aria-label="Filter files"
              placeholder="Filter"
              className="flex-1"
              value={host.menu.filter}
              onChange={(event) => {
                host.setFilter(event.target.value);
              }}
            />
            {sections
              .filter(({ acts }) => acts)
              .map(({ name }) => (
                <span
                  key={name}
                  ref={body}
                  data-body={`action:${name}`}
                  className="flex"
                />
              ))}
          </div>
          <div className="flex flex-col gap-3">
            {parts("")}
            <p className="hidden px-1 py-2 text-label text-fg-dim [div:not(:has(>section:not(:empty)))>&]:block">
              {`Nothing matches “${host.menu.filter.trim()}”.`}
            </p>
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-2">{parts("summary:")}</div>
    </SessionSection>
  );
}

// The filter starts empty each time the Files detail opens.
function ClearsFilter({
  clear,
}: {
  readonly clear: (filter: string) => void;
}): null {
  useEffect(
    () => () => {
      clear("");
    },
    [clear],
  );

  return null;
}

// A plugin's part of the Files section: a few rows in the panel's summary,
// and all of them in its detail, which the filter narrows.
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
  // Its heading; without one, a note under the parts.
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

  if (menu === undefined) {
    return null;
  }

  const body = menu.bodies.get(name);
  const summary = menu.bodies.get(`summary:${name}`);
  const actionBody = menu.bodies.get(`action:${name}`);

  return (
    <>
      {body !== undefined &&
        createPortal(
          <Rows title={title}>
            {children(menu.filter.trim().toLowerCase())}
          </Rows>,
          body,
        )}
      {summary !== undefined &&
        createPortal(
          <Rows title={title} limit={summaryRows}>
            {children("")}
          </Rows>,
          summary,
        )}
      {actionBody !== undefined && createPortal(action, actionBody)}
    </>
  );
}

function Rows({
  title,
  limit,
  children,
}: {
  readonly title: string | undefined;
  readonly limit?: number;
  readonly children: ReactNode;
}): ReactElement | null {
  const rows = Children.toArray(children);

  if (rows.length === 0) {
    return null;
  }

  const shown = limit === undefined ? rows : rows.slice(0, limit);
  const more = rows.length - shown.length;

  return (
    <>
      {title !== undefined && (
        <h3 className="px-1 pb-1 text-caption font-semibold text-fg-strong">
          {title}
        </h3>
      )}
      {shown}
      {more > 0 && (
        <p className="px-1 text-caption text-fg-dim">{`${String(more)} more`}</p>
      )}
    </>
  );
}

// One line of a part, which opens what it names.
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
  return (
    <button
      type="button"
      className="flex min-h-8 items-center gap-2.5 rounded-md px-1 py-1 text-left text-label text-fg hover:bg-hover focus-visible:bg-hover focus-visible:outline-none"
      onClick={onOpen}
    >
      <Icon name={icon} className="size-3.5 shrink-0 text-fg-dim" />
      <span className="min-w-0 flex-1 truncate">{name}</span>
      {detail !== undefined && (
        <span className="shrink-0 text-caption text-fg-dim">{detail}</span>
      )}
    </button>
  );
}
