import {
  Button,
  cn,
  Icon,
  type IconName,
  Menu as ActionMenu,
  type MenuItem,
  plural,
  SearchInput,
  Select,
} from "@pipoca/ui";
import {
  Children,
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
import type { FileActionsProps } from "./index";
import { SessionSection, useShowSection } from "./session-panel";

interface Section {
  readonly name: string;
  readonly order: number;
  readonly title: string | undefined;
  readonly count: number;
  readonly acts: boolean;
  readonly covers: readonly string[];
}

type FileItem = (file: FileActionsProps) => MenuItem | undefined;

// A Session the Files section lists, such as a Project's thread.
export interface FilesSession {
  readonly id: string;
  readonly title: string;
}

interface Menu {
  readonly filter: string;
  readonly bodies: ReadonlyMap<string, HTMLElement>;
  readonly add: (section: Section) => () => void;
  readonly covered: ReadonlySet<string>;
  readonly fileItems: readonly FileItem[];
  readonly addFileItem: (item: FileItem) => () => void;
  // Every Session it lists beside its own, and the one the filter picks.
  readonly scope: readonly FilesSession[];
  readonly setScope: (scope: readonly FilesSession[]) => void;
  readonly picked: string | undefined;
}

const MenuContext = createContext<Menu | undefined>(undefined);

interface Host {
  readonly sections: readonly Section[];
  readonly menu: Menu;
  readonly setFilter: (filter: string) => void;
  readonly setBody: (key: string, body: HTMLElement | null) => void;
  readonly setPicked: (picked: string | undefined) => void;
}

const HostContext = createContext<Host | undefined>(undefined);

// How many rows of each part the panel's summary shows, and how many
// cards; the detail shows that many cards before "more".
const summaryRows = 2;
const summaryCards = 3;
const detailCards = 8;

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
  const [fileItems, setFileItems] = useState<readonly FileItem[]>([]);
  const [scope, setScope] = useState<readonly FilesSession[]>([]);
  const [picked, setPicked] = useState<string>();

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

  const addFileItem = useCallback((item: FileItem) => {
    setFileItems((now) => [...now, item]);

    return () => {
      setFileItems((now) => now.filter((each) => each !== item));
    };
  }, []);

  const covered = useMemo(
    () => new Set(sections.flatMap(({ covers }) => covers)),
    [sections],
  );

  const menu = useMemo(
    () => ({
      filter,
      bodies,
      add,
      covered,
      fileItems,
      addFileItem,
      scope,
      setScope,
      picked,
    }),
    [filter, bodies, add, covered, fileItems, addFileItem, scope, picked],
  );

  const host = useMemo(
    () => ({ sections, menu, setFilter, setBody, setPicked }),
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
            {host.menu.scope.length > 1 && (
              <Select
                aria-label="Thread"
                className="max-w-56"
                value={host.menu.picked ?? ""}
                onChange={(event) => {
                  host.setPicked(event.target.value || undefined);
                }}
              >
                <option value="">All threads</option>
                {host.menu.scope.map((each) => (
                  <option key={each.id} value={each.id}>
                    {each.title}
                  </option>
                ))}
              </Select>
            )}
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
      <div className="flex flex-col gap-2">
        {parts("summary:")}
        <OpenAll count={count} />
      </div>
    </SessionSection>
  );
}

function OpenAll({ count }: { readonly count: number }): ReactElement {
  const show = useShowSection();

  return (
    <Button
      size="sm"
      className="mt-1"
      onClick={() => {
        show?.("files");
      }}
    >
      {`Open the gallery · ${plural(count, "file")}`}
    </Button>
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
  cards = false,
  covers = none,
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
  // Its rows are cards, such as artifacts with a picture of each, laid out
  // in a grid.
  readonly cards?: boolean;
  // The hashes of files it shows already, which other parts may leave out,
  // such as the files an artifact was published from.
  readonly covers?: readonly string[];
  readonly children: (filter: string) => ReactNode;
}): ReactElement | null {
  const menu = useContext(MenuContext);
  const add = menu?.add;
  const acts = action !== undefined;
  const show = useShowSection();
  const covering = covers.join(" ");

  useEffect(
    () =>
      add?.({
        name,
        order,
        title,
        count,
        acts,
        covers: covering === "" ? [] : covering.split(" "),
      }),
    [add, name, order, title, count, acts, covering],
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
          <Rows
            title={title}
            cards={cards}
            {...(cards && { limit: detailCards, expands: true })}
          >
            {children(menu.filter.trim().toLowerCase())}
          </Rows>,
          body,
        )}
      {summary !== undefined &&
        createPortal(
          <Rows
            title={title}
            cards={cards}
            limit={cards ? summaryCards : summaryRows}
            onMore={() => {
              show?.("files");
            }}
          >
            {children("")}
          </Rows>,
          summary,
        )}
      {actionBody !== undefined && createPortal(action, actionBody)}
    </>
  );
}

const none: readonly string[] = [];

function Rows({
  title,
  cards,
  limit,
  expands = false,
  onMore,
  children,
}: {
  readonly title: string | undefined;
  readonly cards: boolean;
  readonly limit?: number;
  // "more" shows the rest in place.
  readonly expands?: boolean;
  readonly onMore?: () => void;
  readonly children: ReactNode;
}): ReactElement | null {
  const rows = Children.toArray(children);
  const [all, setAll] = useState(false);

  if (rows.length === 0) {
    return null;
  }

  const shown = limit === undefined || all ? rows : rows.slice(0, limit);
  const more = rows.length - shown.length;

  return (
    <>
      {title !== undefined && (
        <h3 className="px-1 pb-1 text-caption font-semibold text-fg-strong">
          {title}
        </h3>
      )}
      {cards ? (
        <div
          className={cn(
            "grid gap-2",
            expands
              ? "grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-3"
              : "grid-cols-3",
          )}
        >
          {shown}
        </div>
      ) : (
        shown
      )}
      {more > 0 && (
        <button
          type="button"
          className={cn(
            "self-start rounded-md px-1 text-caption text-fg-dim hover:text-fg-strong focus-visible:ring-4 focus-visible:ring-focus focus-visible:outline-none",
            cards && "mt-1",
          )}
          onClick={
            expands
              ? () => {
                  setAll(true);
                }
              : onMore
          }
        >{`${String(more)} more`}</button>
      )}
    </>
  );
}

// One line of a part, which opens what it names, with a menu of what else
// it does.
export function FilesRow({
  icon = "file",
  name,
  detail,
  actions = [],
  onOpen,
}: {
  readonly icon?: IconName;
  readonly name: string;
  readonly detail?: string;
  readonly actions?: readonly MenuItem[];
  readonly onOpen: () => void;
}): ReactElement {
  const row = (
    <button
      type="button"
      className="flex min-h-8 min-w-0 flex-1 items-center gap-2.5 rounded-md px-1 py-1 text-left text-label text-fg hover:bg-hover focus-visible:bg-hover focus-visible:outline-none"
      onClick={onOpen}
    >
      <Icon name={icon} className="size-3.5 shrink-0 text-fg-dim" />
      <span className="min-w-0 flex-1 truncate">{name}</span>
      {detail !== undefined && (
        <span className="shrink-0 text-caption text-fg-dim">{detail}</span>
      )}
    </button>
  );

  if (actions.length === 0) {
    return row;
  }

  return (
    <div className="flex items-center gap-1">
      {row}
      <ActionMenu label={`More for ${name}`} size="sm" items={actions} />
    </div>
  );
}

// What other plugins do with a Session's file, for its row's menu, such as
// publishing it as an artifact.
export function useFileItems(): (file: FileActionsProps) => MenuItem[] {
  const items = useContext(MenuContext)?.fileItems;

  return useCallback(
    (file) =>
      (items ?? []).flatMap((item) => {
        const made = item(file);

        return made === undefined ? [] : [made];
      }),
    [items],
  );
}

// Adds an item to every file row's menu while the caller is drawn.
export function useFileItem(item: FileItem): void {
  const add = useContext(MenuContext)?.addFileItem;
  const latest = useRef(item);

  useEffect(() => {
    latest.current = item;
  });

  useEffect(() => add?.((file) => latest.current(file)), [add]);
}

// The Sessions whose files the section lists: the Session alone, or with
// the others a plugin adds, such as a Project coordinator's threads,
// narrowed to the one the person picks.
export function useFilesSessions(own: string): readonly FilesSession[] {
  const menu = useContext(MenuContext);
  const scope = menu?.scope;
  const picked = menu?.picked;

  return useMemo(() => {
    const listed = scope ?? [];

    const all = listed.some(({ id }) => id === own)
      ? listed
      : [{ id: own, title: "" }, ...listed];

    return picked === undefined ? all : all.filter(({ id }) => id === picked);
  }, [scope, picked, own]);
}

// Lists these Sessions' files too while the caller is drawn.
export function useAddFilesSessions(sessions: readonly FilesSession[]): void {
  const setScope = useContext(MenuContext)?.setScope;
  const key = JSON.stringify(sessions);

  useEffect(() => {
    if (setScope === undefined) {
      return undefined;
    }

    setScope(JSON.parse(key) as FilesSession[]);

    return () => {
      setScope([]);
    };
  }, [setScope, key]);
}

// The hashes of files that a part shows already.
export function useCoveredFiles(): ReadonlySet<string> {
  return useContext(MenuContext)?.covered ?? noneCovered;
}

const noneCovered: ReadonlySet<string> = new Set();
