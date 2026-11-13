import {
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
  useId,
  useRef,
  useState,
} from "react";
import { Badge } from "./badge";
import { useAnchored } from "./anchored";
import { cn } from "./cn";
import { Icon } from "./icon";
import { Segmented } from "./segmented";

export interface PickerModel {
  // `provider/id`.
  readonly value: string;
  readonly provider: string;
  readonly providerName: string;
  readonly id: string;
  readonly name?: string | undefined;
  readonly contextWindow?: number | undefined;
  readonly reasoning?: boolean | undefined;
  // Why it failed recently.
  readonly unavailable?: string | undefined;
}

type View = "favorites" | "recent" | { readonly provider: string };

const viewNames = { favorites: "Favorites", recent: "Recent" } as const;

const emptyViews = {
  favorites: "Star a model to keep it here.",
  recent: "The models you pick show up here.",
} as const;

// Picks one of many models, like the composer's: a rail of favorites, recent
// picks and providers beside the list, a search over every model, stars and
// a person's own hidden models.
export function ModelPicker({
  label,
  children,
  models,
  selected,
  favorites,
  recent,
  hidden,
  none,
  create = false,
  reasoning,
  quiet = false,
  trigger: given,
  onPick,
  onStar,
  onHide,
  onLogin,
}: {
  readonly label: string;
  readonly children: ReactNode;
  readonly models: readonly PickerModel[];
  // The picked `provider/id`, or "" for none.
  readonly selected: string;
  readonly favorites: readonly string[];
  // Newest first.
  readonly recent: readonly string[];
  readonly hidden: readonly string[];
  // A first option for no model, such as the Environment's default.
  readonly none?: string;
  // Offers a typed `provider/id` the list doesn't have.
  readonly create?: boolean;
  readonly reasoning?:
    | {
        readonly levels: readonly {
          readonly value: string;
          readonly label: string;
        }[];
        readonly value: string;
        readonly onChange: (level: string) => void;
      }
    | undefined;
  readonly quiet?: boolean;
  // Lets a command such as /model open the list.
  readonly trigger?: RefObject<HTMLButtonElement | null>;
  readonly onPick: (value: string) => void;
  readonly onStar: (value: string, starred: boolean) => void;
  readonly onHide: (hidden: readonly string[]) => void;
  // Team work runs on the team's keys and takes no logins.
  readonly onLogin?: (() => void) | undefined;
}): ReactElement {
  const listId = useId();
  const wrapper = useRef<HTMLDivElement>(null);
  const own = useRef<HTMLButtonElement>(null);
  const trigger = given ?? own;
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [hiding, setHiding] = useState(false);
  const [view, setView] = useState<View>();

  const anchored = useAnchored(trigger, panel, open);

  const shown = models.filter(
    ({ value }) => value === selected || !hidden.includes(value),
  );

  const providers = [
    ...new Map(
      shown.map(({ provider, providerName }) => [provider, providerName]),
    ),
  ].map(([provider, name]) => ({
    provider,
    name,
    count: shown.filter((model) => model.provider === provider).length,
  }));

  const byValue = new Map(shown.map((model) => [model.value, model]));
  const starred = favorites.flatMap((value) => byValue.get(value) ?? []);
  const lately = recent.flatMap((value) => byValue.get(value) ?? []);
  const current = byValue.get(selected);

  const viewing: View =
    view ??
    (current === undefined && starred.length > 0
      ? "favorites"
      : { provider: current?.provider ?? providers[0]?.provider ?? "" });

  const needle = query.trim().toLowerCase();
  const words = needle.split(/\s+/).filter((word) => word !== "");

  const matches = (model: PickerModel): boolean =>
    words.every((word) =>
      [
        model.name,
        model.value,
        model.provider,
        model.providerName,
        model.reasoning === true ? "reasoning" : undefined,
      ].some((text) => text?.toLowerCase().includes(word) ?? false),
    );

  const inView = (all: readonly PickerModel[]): readonly PickerModel[] => {
    if (viewing === "favorites") {
      return starred;
    }

    if (viewing === "recent") {
      return lately;
    }

    return all.filter(({ provider }) => provider === viewing.provider);
  };

  const searching = needle !== "" && !hiding;

  const listed = searching
    ? shown.filter(matches)
    : inView(hiding ? models : shown);

  const typed =
    create &&
    needle !== "" &&
    /^[^/\s]+\/\S+$/.test(query.trim()) &&
    !models.some(({ value }) => value === query.trim())
      ? query.trim()
      : undefined;

  const options = [
    ...(none !== undefined && needle === "" && !hiding ? [""] : []),
    ...(typed === undefined ? [] : [typed]),
    ...listed.map(({ value }) => value),
  ];

  const viewName =
    typeof viewing === "object"
      ? (providers.find(({ provider }) => provider === viewing.provider)
          ?.name ?? "")
      : viewNames[viewing];

  const viewEmpty =
    typeof viewing === "object" ? "No models." : emptyViews[viewing];

  const empty = searching ? "Nothing matches." : viewEmpty;

  const close = (): void => {
    setOpen(false);
    setQuery("");
    setActive(0);
    setHiding(false);
    setView(undefined);
  };

  const choose = (value: string): void => {
    if (hiding) {
      onHide(
        hidden.includes(value)
          ? hidden.filter((known) => known !== value)
          : [...hidden, value],
      );

      return;
    }

    onPick(value);
    close();
    trigger.current?.focus();
  };

  const keys = (event: KeyboardEvent): void => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setActive((index) => Math.min(index + 1, options.length - 1));
        break;
      case "ArrowUp":
        event.preventDefault();
        setActive((index) => Math.max(index - 1, 0));
        break;
      case "Enter": {
        event.preventDefault();
        const value = options[active];
        if (value !== undefined) {
          choose(value);
        }

        break;
      }
    }
  };

  const optionId = (index: number): string => `${listId}-${String(index)}`;

  const railButton = (
    key: string,
    pressed: boolean,
    content: ReactNode,
    count: number,
    pick: View,
  ): ReactElement => (
    <button
      key={key}
      type="button"
      aria-pressed={pressed}
      onClick={() => {
        setView(pick);
        setQuery("");
        setActive(0);
      }}
      className="flex h-8 shrink-0 cursor-pointer items-center gap-2 rounded-md px-2.5 text-left text-label text-fg transition-colors hover:bg-hover aria-pressed:bg-elevated aria-pressed:font-medium aria-pressed:text-fg-strong aria-pressed:shadow-xs"
    >
      <span className="min-w-0 flex-1 truncate">{content}</span>
      <span className="text-caption font-normal text-fg-dim">
        {String(count)}
      </span>
    </button>
  );

  const row = (value: string, index: number): ReactElement => {
    const model = listed.find((each) => each.value === value);
    const picked = value === selected;
    const star = favorites.includes(value);

    const before =
      needle !== "" && model !== undefined
        ? listed[listed.indexOf(model) - 1]
        : undefined;

    const heading =
      needle !== "" &&
      model !== undefined &&
      before?.provider !== model.provider;

    return (
      <li key={value === "" ? "none" : value} className="contents">
        {heading && (
          <span
            aria-hidden
            className="block px-2.5 pt-2.5 pb-1 text-caption tracking-wide text-fg-dim uppercase"
          >
            {model.providerName}
          </span>
        )}
        <div
          id={optionId(index)}
          role="option"
          aria-selected={hiding ? !hidden.includes(value) : picked}
          aria-label={model?.name ?? model?.id ?? optionLabel(value, none)}
          onMouseDown={(event) => {
            event.preventDefault();
          }}
          onMouseEnter={() => {
            setActive(index);
          }}
          onClick={() => {
            choose(value);
          }}
          className={cn(
            "group flex cursor-pointer items-center gap-3 rounded-[10px] px-2.5 py-2 transition-colors duration-100",
            (index === active || (picked && !hiding)) && "bg-hover",
          )}
        >
          {hiding ? (
            <span
              className={cn(
                "flex size-4 shrink-0 items-center justify-center rounded-sm border border-line-strong",
                !hidden.includes(value) && "border-accent bg-accent text-bg",
              )}
            >
              {!hidden.includes(value) && (
                <Icon name="check" className="size-3" />
              )}
            </span>
          ) : (
            <Icon
              name="check"
              className={cn(
                "size-3.5 shrink-0 text-accent",
                !picked && "invisible",
              )}
            />
          )}
          {model === undefined ? (
            <span className="min-w-0 flex-1 truncate text-ui text-fg">
              {optionLabel(value, none)}
            </span>
          ) : (
            <>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-ui font-medium text-fg-strong">
                  {model.name ?? model.id}
                </span>
                <span className="truncate font-mono text-caption text-fg-dim">
                  {model.id}
                  {model.unavailable !== undefined &&
                    ` · last failed: ${model.unavailable}`}
                </span>
              </span>
              {model.contextWindow !== undefined && (
                <Tag>{contextSize(model.contextWindow)}</Tag>
              )}
              {model.reasoning === true && <Tag>reasoning</Tag>}
              {model.unavailable !== undefined && (
                <Badge state="failed" title={model.unavailable}>
                  Unavailable
                </Badge>
              )}
              {!hiding && (
                <button
                  type="button"
                  aria-label={star ? `Unstar ${model.id}` : `Star ${model.id}`}
                  aria-pressed={star}
                  onMouseDown={(event) => {
                    event.preventDefault();
                  }}
                  onClick={(event) => {
                    event.stopPropagation();
                    onStar(value, !star);
                  }}
                  className={cn(
                    "flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-waiting hover:bg-elevated",
                    !star &&
                      "text-fg-dim opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100",
                  )}
                >
                  <Icon
                    name="star"
                    className={cn("size-3.5", star && "fill-current")}
                  />
                </button>
              )}
            </>
          )}
        </div>
      </li>
    );
  };

  return (
    <div
      ref={wrapper}
      className="relative inline-flex"
      onKeyDown={(event) => {
        if (open && event.key === "Escape") {
          // Closes the list, not the dialog around it.
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
        className={cn(
          "inline-flex max-w-64 cursor-pointer items-center gap-1.5 transition-colors duration-150 hover:bg-hover aria-expanded:bg-hover",
          quiet
            ? "h-7 rounded-md px-2 text-caption text-fg-dim hover:text-fg aria-expanded:text-fg"
            : "h-8 rounded-full border border-line bg-elevated px-3 text-label text-fg shadow-xs hover:border-line-strong aria-expanded:border-line-focus",
        )}
      >
        <span className="truncate">{children}</span>
        <Icon name="chevron-down" className="size-3 shrink-0 text-fg-dim" />
      </button>
      {open && (
        <div
          ref={panel}
          style={anchored.style}
          role="dialog"
          aria-label={`Pick a ${label.toLowerCase()}`}
          className={cn(
            "z-30 flex w-[680px] max-w-[calc(100vw-32px)] animate-pop-in flex-col overflow-hidden rounded-2xl border border-line bg-elevated shadow-pop",
          )}
        >
          <div className="flex items-center gap-2.5 border-b border-line px-4">
            <Icon name="search" className="size-4 text-fg-dim" />
            <input
              autoFocus
              role="combobox"
              aria-label={label}
              aria-controls={listId}
              aria-expanded
              aria-activedescendant={
                options[active] === undefined ? undefined : optionId(active)
              }
              value={query}
              placeholder={`Search ${String(shown.length)} models by name, provider or “reasoning”`}
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(0);
                setHiding(false);
              }}
              onKeyDown={keys}
              className="h-12 min-w-0 flex-1 border-0 bg-transparent text-ui text-fg placeholder:text-fg-dim focus:outline-none"
            />
          </div>
          <div className="flex min-h-0 flex-col sm:h-[420px] sm:flex-row">
            <div
              role="group"
              aria-label="Providers"
              className="flex shrink-0 gap-0.5 overflow-x-auto border-b border-line bg-panel p-2 sm:w-48 sm:flex-col sm:overflow-y-auto sm:border-r sm:border-b-0"
            >
              {railButton(
                "favorites",
                viewing === "favorites" && needle === "",
                <span className="inline-flex items-center gap-2">
                  <Icon
                    name="star"
                    className="size-3.5 fill-current text-waiting"
                  />
                  Favorites
                </span>,
                starred.length,
                "favorites",
              )}
              {railButton(
                "recent",
                viewing === "recent" && needle === "",
                "Recent",
                lately.length,
                "recent",
              )}
              <span className="hidden px-2.5 pt-2 pb-1 text-caption tracking-wide text-fg-dim uppercase sm:block">
                Providers
              </span>
              {providers.map(({ provider, name, count }) =>
                railButton(
                  provider,
                  needle === "" &&
                    typeof viewing === "object" &&
                    viewing.provider === provider,
                  name,
                  count,
                  { provider },
                ),
              )}
              <span className="hidden flex-1 sm:block" />
              <button
                type="button"
                aria-pressed={hiding}
                onClick={() => {
                  setHiding(!hiding);
                  setQuery("");
                  setActive(0);
                }}
                className="shrink-0 cursor-pointer rounded-md px-2.5 py-2 text-left text-label text-fg-dim hover:text-fg aria-pressed:text-fg-strong"
              >
                {hiding ? "Done hiding" : "Hide models…"}
              </button>
            </div>
            <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto p-2 max-sm:max-h-80">
              {needle === "" && (
                <span className="px-2.5 pt-2 pb-1 text-caption tracking-wide text-fg-dim uppercase">
                  {hiding ? `Shown in your pickers · ${viewName}` : viewName}
                </span>
              )}
              <ul
                id={listId}
                role="listbox"
                aria-label={hiding ? `Models to show` : `${viewName} models`}
                className="flex flex-col gap-0.5"
              >
                {options.map(row)}
              </ul>
              {options.length === 0 && (
                <p className="px-2.5 py-2 text-caption text-fg-dim">{empty}</p>
              )}
            </div>
          </div>
          {(reasoning !== undefined || onLogin !== undefined) && (
            <div className="flex flex-wrap items-center gap-4 border-t border-line px-4 py-3">
              {reasoning !== undefined && reasoning.levels.length > 1 && (
                <>
                  <span className="text-label text-fg-dim">Reasoning</span>
                  <Segmented
                    label="Reasoning"
                    options={reasoning.levels}
                    value={reasoning.value}
                    onChange={reasoning.onChange}
                  />
                </>
              )}
              <span className="flex-1" />
              {onLogin !== undefined && (
                <button
                  type="button"
                  onClick={() => {
                    close();
                    trigger.current?.focus();
                    onLogin();
                  }}
                  className="cursor-pointer text-label text-fg-dim hover:text-fg"
                >
                  Log in to a provider…
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Tag({ children }: { readonly children: ReactNode }): ReactElement {
  return (
    <span className="shrink-0 rounded-full border border-line px-1.75 py-0.5 text-[11px] whitespace-nowrap text-fg-dim max-sm:hidden">
      {children}
    </span>
  );
}

function contextSize(tokens: number): string {
  return tokens >= 1_000_000
    ? `${String(Math.round(tokens / 100_000) / 10)}M`
    : `${String(Math.round(tokens / 1000))}k`;
}

function optionLabel(value: string, none: string | undefined): string {
  return value === "" ? (none ?? "") : `Use ${value}`;
}
