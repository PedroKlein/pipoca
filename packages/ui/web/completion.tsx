import {
  type KeyboardEvent,
  type ReactElement,
  type SyntheticEvent,
  useId,
  useRef,
  useState,
} from "react";
import { cn } from "./cn";
import { popClass } from "./menu";

const shown = 8;

// The word being completed: what's typed after its trigger character, where
// it starts (the trigger included) and what the list is called.
export interface Typed {
  readonly query: string;
  readonly from: number;
  readonly label: string;
}

export interface Completion {
  // What goes in the text, and what the list shows beside it.
  readonly value: string;
  readonly detail: string | null;
}

interface Completing {
  readonly menu: ReactElement | null;
  // Props for the textarea the menu completes.
  readonly box: {
    readonly "aria-autocomplete": "list";
    readonly "aria-controls": string | undefined;
    readonly "aria-activedescendant": string | undefined;
    readonly onInput: (event: SyntheticEvent<HTMLTextAreaElement>) => void;
    readonly onSelect: (event: SyntheticEvent<HTMLTextAreaElement>) => void;
    readonly onBlur: () => void;
  };
  // Handles a key when the menu is open and says whether it did.
  readonly keyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
}

// A list above a textarea's caret that completes the word being typed, such
// as a command, a file or a person. Arrows move, Enter or Tab picks, Escape
// closes it until another word starts. Picking sets the textarea's value
// directly, so onChange hears the input event it fires.
export function useCompletion<T extends Typed>({
  find,
  options,
  mono = false,
}: {
  readonly find: (text: string, caret: number) => T | undefined;
  readonly options: (typed: T) => readonly Completion[];
  // Values are code, such as commands and paths.
  readonly mono?: boolean;
}): Completing {
  const listId = useId();
  const text = useRef<HTMLTextAreaElement>(null);
  const [typed, setTyped] = useState<T>();
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<number>();

  const listed =
    typed === undefined || typed.from === dismissed
      ? []
      : options(typed).slice(0, shown);

  const open = listed.length > 0;
  const current = Math.min(active, listed.length - 1);

  const refresh = (event: SyntheticEvent<HTMLTextAreaElement>): void => {
    const box = event.currentTarget;
    text.current = box;
    const next = find(box.value, box.selectionStart);

    if (next?.query !== typed?.query || next?.from !== typed?.from) {
      setActive(0);
    }

    if (next === undefined) {
      setDismissed(undefined);
    }

    setTyped(next);
  };

  const pick = (option: Completion): void => {
    const box = text.current;

    if (!box || typed === undefined) {
      return;
    }

    const rest = box.value.slice(box.selectionStart);
    const inserted = rest.startsWith(" ") ? option.value : `${option.value} `;
    const caret = typed.from + inserted.length + (rest.startsWith(" ") ? 1 : 0);

    // Past React's own value property, so a controlled field's onChange
    // hears it.
    Reflect.set(
      Object.getPrototypeOf(box) as object,
      "value",
      box.value.slice(0, typed.from) + inserted + rest,
      box,
    );

    box.dispatchEvent(new Event("input", { bubbles: true }));
    box.setSelectionRange(caret, caret);
    box.focus();
    setTyped(undefined);
  };

  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open) {
      return false;
    }

    switch (event.key) {
      case "ArrowDown":
        setActive((current + 1) % listed.length);
        break;
      case "ArrowUp":
        setActive((current - 1 + listed.length) % listed.length);
        break;
      case "Enter":
      case "Tab": {
        if (
          event.key === "Enter" &&
          (event.shiftKey || event.ctrlKey || event.metaKey)
        ) {
          return false;
        }

        const option = listed[current];

        if (option) {
          pick(option);
        }

        break;
      }

      case "Escape":
        setDismissed(typed?.from);
        break;
      default:
        return false;
    }

    event.preventDefault();
    event.stopPropagation();

    return true;
  };

  return {
    menu: open ? (
      <ul
        id={listId}
        role="listbox"
        aria-label={typed?.label}
        className={cn(
          popClass,
          "absolute inset-x-0 bottom-full z-20 mb-2 max-h-72 overflow-y-auto",
        )}
      >
        {listed.map((option, index) => (
          <li
            key={index}
            id={`${listId}-${String(index)}`}
            role="option"
            aria-selected={index === current}
            onMouseDown={(event) => {
              event.preventDefault();
              pick(option);
            }}
            onMouseEnter={() => {
              setActive(index);
            }}
            className={cn(
              "flex cursor-pointer items-baseline gap-3 rounded-md px-3 py-1.5",
              index === current && "bg-fg/10",
            )}
          >
            <span
              className={cn(
                "shrink-0 text-fg-strong",
                mono ? "font-mono text-mono-sm" : "text-label",
              )}
            >
              {option.value}
            </span>
            {option.detail !== null && (
              <span className="truncate text-label text-fg-dim">
                {option.detail}
              </span>
            )}
          </li>
        ))}
      </ul>
    ) : null,
    box: {
      "aria-autocomplete": "list",
      "aria-controls": open ? listId : undefined,
      "aria-activedescendant": open
        ? `${listId}-${String(current)}`
        : undefined,
      onInput: refresh,
      onSelect: refresh,
      onBlur: () => {
        setTyped(undefined);
      },
    },
    keyDown,
  };
}
