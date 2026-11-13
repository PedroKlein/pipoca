import {
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  useId,
  useRef,
  useState,
} from "react";
import { Badge } from "./badge";
import { Button } from "./button";
import { useAnchored } from "./anchored";
import { cn } from "./cn";
import { Icon } from "./icon";

export interface RepoOption {
  // What is picked: a repository URL or a folder's path.
  readonly value: string;
  readonly name: string;
  // The host it is on, for the host filters; none for a folder.
  readonly host?: string | undefined;
  // Such as when it was last pushed.
  readonly meta?: string | undefined;
  readonly private?: boolean | undefined;
}

// How many matches a host lists before asking for more typing.
const perHost = 5;

type Filter = "all" | "folders" | { readonly host: string };

// Picks repositories, and folders on the Environment, for new work: the
// recent ones first, the rest by host, with the picked ones as chips.
export function RepoPicker({
  label,
  children,
  selected,
  repositories,
  recent,
  folders,
  placeholder,
  footer,
  hint,
  onSearch,
  onChange,
}: {
  readonly label: string;
  readonly children: ReactNode;
  readonly selected: readonly string[];
  readonly repositories: readonly RepoOption[];
  // What the person and their Projects used last, newest first.
  readonly recent: readonly RepoOption[];
  // The folders on the chosen Environment, under a filter of their own.
  readonly folders?:
    | { readonly label: string; readonly options: readonly RepoOption[] }
    | undefined;
  readonly placeholder: string;
  // Under the list, such as a choice that applies to what was picked.
  readonly footer?: ReactNode;
  // Says where the repositories come from.
  readonly hint?: ReactNode;
  // Hears what is typed, for the repositories a search elsewhere finds.
  readonly onSearch: (query: string) => void;
  readonly onChange: (values: readonly string[]) => void;
}): ReactElement {
  const listId = useId();
  const wrapper = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [filter, setFilter] = useState<Filter>("all");

  const anchored = useAnchored(trigger, panel, open);

  const typed = query.trim();
  const words = typed.toLowerCase().split(/\s+/).filter(Boolean);

  const matches = (option: RepoOption): boolean =>
    words.every((word) =>
      [option.name, option.value, option.host].some(
        (text) => text?.toLowerCase().includes(word) ?? false,
      ),
    );

  const known = new Map(
    [...(folders?.options ?? []), ...recent, ...repositories].map(
      (option) => [option.value, option] as const,
    ),
  );

  const hosts = [
    ...new Set(
      [...recent, ...repositories].flatMap(({ host }) =>
        host === undefined ? [] : [host],
      ),
    ),
  ];

  const inFilter = (option: RepoOption): boolean => {
    if (filter === "all") {
      return option.host !== undefined || recent.includes(option);
    }

    if (filter === "folders") {
      return option.host === undefined;
    }

    return option.host === filter.host;
  };

  const recentShown = recent.filter(
    (option) => inFilter(option) && matches(option),
  );

  const groups: { readonly title: string; readonly options: RepoOption[] }[] =
    [];

  if (filter === "folders") {
    groups.push({
      title: folders?.label ?? "Folders",
      options: (folders?.options ?? []).filter(
        (option) =>
          matches(option) &&
          !recentShown.some(({ value }) => value === option.value),
      ),
    });
  } else {
    for (const host of filter === "all" ? hosts : [filter.host]) {
      const found = repositories.filter(
        (option) =>
          option.host === host &&
          matches(option) &&
          !recentShown.some(({ value }) => value === option.value),
      );

      if (found.length > 0) {
        groups.push({
          title: `${typed === "" ? "On" : "Matches on"} ${host} · ${String(found.length)}`,
          options: found,
        });
      }
    }
  }

  // A folder listed only under its own filter can still be typed.
  const listed = [...recentShown, ...groups.flatMap(({ options }) => options)];

  const made: RepoOption | undefined =
    typed !== "" && !listed.some(({ value }) => value === typed)
      ? {
          value: typed,
          name: `Use ${typed}`,
          meta: /:\/\/|^[\w.-]+@[\w.-]+:/.test(typed) ? "clone" : "folder",
        }
      : undefined;

  // A path or URL is what the person means; a word is a search, so what it
  // matches comes first.
  const madeFirst = listed.length === 0 || /[/:~]|^\./.test(typed);
  const typedSection = made ? [{ title: "", options: [made], more: 0 }] : [];

  const sections = [
    ...(madeFirst ? typedSection : []),
    ...(recentShown.length > 0
      ? [{ title: "Recent", options: recentShown, more: 0 }]
      : []),
    ...groups.map(({ title, options }) => ({
      title,
      options: options.slice(0, perHost),
      more: Math.max(0, options.length - perHost),
    })),
    ...(madeFirst ? [] : typedSection),
  ];

  const rows = sections.flatMap(({ options }) => options);

  const close = (): void => {
    setOpen(false);
    setQuery("");
    setActive(0);
    setFilter("all");
    onSearch("");
  };

  const toggle = (value: string): void => {
    onChange(
      selected.includes(value)
        ? selected.filter((each) => each !== value)
        : [...selected, value],
    );

    if (value === typed) {
      setQuery("");
      onSearch("");
    }
  };

  const keys = (event: KeyboardEvent): void => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setActive((index) => Math.min(index + 1, rows.length - 1));
        break;
      case "ArrowUp":
        event.preventDefault();
        setActive((index) => Math.max(index - 1, 0));
        break;
      case "Enter": {
        event.preventDefault();
        const row = rows[active];
        if (row !== undefined) {
          toggle(row.value);
        }

        break;
      }
    }
  };

  const filterButton = (
    key: string,
    pressed: boolean,
    text: string,
    to: Filter,
  ): ReactElement => (
    <button
      key={key}
      type="button"
      aria-pressed={pressed}
      onClick={() => {
        setFilter(to);
        setActive(0);
      }}
      className="h-7 shrink-0 cursor-pointer rounded-full border border-line px-3 text-caption text-fg-dim transition-colors hover:text-fg aria-pressed:border-transparent aria-pressed:bg-fg-strong aria-pressed:text-bg"
    >
      {text}
    </button>
  );

  const optionId = (index: number): string => `${listId}-${String(index)}`;
  let index = -1;

  return (
    <div
      ref={wrapper}
      className="relative inline-flex"
      onKeyDown={(event) => {
        if (open && event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          close();
          trigger.current?.focus();
        }
      }}
      onBlur={(event) => {
        if (!(wrapper.current?.contains(event.relatedTarget) ?? false)) {
          close();
        }
      }}
    >
      <button
        ref={trigger}
        type="button"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          if (open) {
            close();

            return;
          }

          setOpen(true);
        }}
        className="inline-flex h-8 max-w-80 cursor-pointer items-center gap-1.5 rounded-full border border-line bg-elevated px-3 text-label text-fg shadow-xs transition-colors duration-150 hover:border-line-strong hover:bg-hover aria-expanded:border-line-focus aria-expanded:bg-hover"
      >
        <span className="truncate">{children}</span>
        <Icon name="chevron-down" className="size-3 shrink-0 text-fg-dim" />
      </button>
      {open && (
        <div
          ref={panel}
          role="dialog"
          aria-label={label}
          style={{ ...anchored.style, maxHeight: anchored.room }}
          className={cn(
            "z-30 flex w-[720px] max-w-[calc(100vw-32px)] animate-pop-in flex-col overflow-hidden rounded-2xl border border-line bg-elevated shadow-pop",
          )}
        >
          <div className="flex shrink-0 flex-col gap-2.5 border-b border-line px-4 pt-1 pb-3">
            <div className="flex items-center gap-2.5">
              <Icon name="search" className="size-4 text-fg-dim" />
              <input
                autoFocus
                role="combobox"
                aria-label={label}
                aria-controls={listId}
                aria-expanded
                aria-activedescendant={
                  rows[active] === undefined ? undefined : optionId(active)
                }
                value={query}
                placeholder={placeholder}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActive(0);
                  onSearch(event.target.value.trim());
                }}
                onKeyDown={keys}
                className="h-11 min-w-0 flex-1 border-0 bg-transparent text-ui text-fg placeholder:text-fg-dim focus:outline-none"
              />
            </div>
            {selected.length > 0 && (
              <ul
                aria-label="Picked"
                className="flex max-h-24 flex-wrap gap-1.5 overflow-y-auto"
              >
                {selected.map((value) => {
                  const name = known.get(value)?.name ?? value;

                  return (
                    <li
                      key={value}
                      className="inline-flex h-7 max-w-full items-center gap-1 rounded-full bg-hover pr-1 pl-3 font-mono text-mono-sm text-fg"
                    >
                      <span className="truncate">{name}</span>
                      <button
                        type="button"
                        aria-label={`Remove ${name}`}
                        onClick={() => {
                          toggle(value);
                        }}
                        className="flex size-5 cursor-pointer items-center justify-center rounded-full text-fg-dim hover:bg-elevated hover:text-fg"
                      >
                        <Icon name="x" className="size-3" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            {(hosts.length > 1 || folders !== undefined) && (
              <div
                role="group"
                aria-label="Filter"
                className="flex gap-1.5 overflow-x-auto"
              >
                {filterButton("all", filter === "all", "All hosts", "all")}
                {hosts.length > 1 &&
                  hosts.map((host) =>
                    filterButton(
                      host,
                      typeof filter === "object" && filter.host === host,
                      host,
                      { host },
                    ),
                  )}
                <span className="flex-1" />
                {folders !== undefined &&
                  filterButton(
                    "folders",
                    filter === "folders",
                    folders.label,
                    "folders",
                  )}
              </div>
            )}
          </div>
          <div className="flex max-h-[min(420px,50vh)] min-h-0 flex-col overflow-y-auto p-2">
            <ul
              id={listId}
              role="listbox"
              aria-label={label}
              aria-multiselectable
              className="flex flex-col gap-0.5"
            >
              {sections.map(({ title, options, more }) => (
                <li key={title === "" ? "typed" : title} className="contents">
                  {title !== "" && (
                    <span
                      aria-hidden
                      className="block px-2.5 pt-2.5 pb-1 text-caption tracking-wide text-fg-dim uppercase"
                    >
                      {title}
                    </span>
                  )}
                  {options.map((option) => {
                    index += 1;
                    const at = index;
                    const picked = selected.includes(option.value);

                    return (
                      <div
                        key={option.value}
                        id={optionId(at)}
                        role="option"
                        aria-selected={picked}
                        aria-label={option.name}
                        onMouseDown={(event) => {
                          event.preventDefault();
                        }}
                        onMouseEnter={() => {
                          setActive(at);
                        }}
                        onClick={() => {
                          toggle(option.value);
                        }}
                        className={cn(
                          "flex cursor-pointer items-center gap-3 rounded-[10px] px-2.5 py-2 transition-colors duration-100",
                          at === active && "bg-hover",
                        )}
                      >
                        <span
                          className={cn(
                            "flex size-4 shrink-0 items-center justify-center rounded-sm border border-line-strong",
                            picked && "border-accent bg-accent text-bg",
                          )}
                        >
                          {picked && <Icon name="check" className="size-3" />}
                        </span>
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate font-mono text-mono-sm text-fg-strong">
                            {option.name}
                          </span>
                          {option.meta !== undefined && (
                            <span className="truncate text-caption text-fg-dim">
                              {option.meta}
                            </span>
                          )}
                        </span>
                        {option.private === true && <Badge>Private host</Badge>}
                      </div>
                    );
                  })}
                  {more > 0 && (
                    <span className="block px-2.5 py-1.5 text-caption text-fg-dim">
                      + {String(more)} more · keep typing to narrow
                    </span>
                  )}
                </li>
              ))}
            </ul>
            {rows.length === 0 && (
              <p className="px-2.5 py-2 text-caption text-fg-dim">
                {typed === "" ? "Type to search." : "Nothing matches."}
              </p>
            )}
          </div>
          {footer !== undefined && (
            <div className="shrink-0 border-t border-line px-4 py-2 text-caption text-fg-dim">
              {footer}
            </div>
          )}
          <div className="flex shrink-0 flex-wrap items-center gap-3 border-t border-line px-4 py-3 text-caption text-fg-dim">
            {selected.length > 1 && (
              <span>
                {String(selected.length)} picked · each gets its own worktree
              </span>
            )}
            <span className="flex-1" />
            {hint}
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                close();
                trigger.current?.focus();
              }}
            >
              Done
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
