import { Button, cn } from "@pipoca/ui";
import { type ReactElement, useState } from "react";
import { move, type QuestionState } from "./questions";
import {
  type ChoiceQuestion,
  type Asking,
  Split,
  Annotation,
  OptionLabel,
  Detail,
} from "./question-parts";

export function Rank({
  question,
  state,
  onChange,
  asking,
}: {
  readonly question: ChoiceQuestion;
  readonly state: QuestionState;
  readonly onChange: (state: QuestionState) => void;
  readonly asking: Asking;
}): ReactElement {
  const [focused, setFocused] = useState<string>();
  const [dragged, setDragged] = useState<number>();
  const shown = question.options.find((option) => option.value === focused);

  return (
    <Split
      detail={<Detail question={question} option={shown} asking={asking} />}
    >
      <ol className="flex flex-col gap-1.5">
        {state.picked.map((value, at) => {
          const option = question.options.find((o) => o.value === value);
          if (!option) {
            return null;
          }

          return (
            <li
              key={value}
              draggable
              onDragStart={() => {
                setDragged(at);
              }}
              onDragOver={(event) => {
                event.preventDefault();
              }}
              onDrop={(event) => {
                event.preventDefault();
                if (dragged !== undefined && dragged !== at) {
                  onChange(move(state, dragged, at));
                }
              }}
              className={cn(
                "flex cursor-grab flex-col gap-2 rounded-md border px-3 py-1.5",
                focused === value
                  ? "border-accent bg-accent-tint"
                  : "border-line",
              )}
            >
              <div className="flex items-center gap-2">
                <span aria-hidden="true" className="text-fg-dim">
                  ⋮⋮
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setFocused(value);
                  }}
                  className="flex-1 cursor-pointer text-left text-ui"
                >
                  {at + 1}. <OptionLabel option={option} />
                </button>
                <Button
                  variant="ghost"
                  iconOnly
                  aria-label="Move up"
                  disabled={at === 0}
                  onClick={(event) => {
                    onChange(move(state, at, at - 1));
                    setFocused(value);
                    keepFocus(event.currentTarget, "Move down");
                  }}
                >
                  ↑
                </Button>
                <Button
                  variant="ghost"
                  iconOnly
                  aria-label="Move down"
                  disabled={at === state.picked.length - 1}
                  onClick={(event) => {
                    onChange(move(state, at, at + 1));
                    setFocused(value);
                    keepFocus(event.currentTarget, "Move up");
                  }}
                >
                  ↓
                </Button>
              </div>
              {focused === value && (
                <Annotation state={state} value={value} onChange={onChange} />
              )}
            </li>
          );
        })}
      </ol>
    </Split>
  );
}

// React re-inserts a moved row, which drops focus, and the button is
// disabled once the row reaches the end of the list.
function keepFocus(button: HTMLButtonElement, other: string): void {
  requestAnimationFrame(() => {
    const target = button.disabled
      ? button.parentElement?.querySelector<HTMLElement>(
          `[aria-label="${other}"]`,
        )
      : button;

    target?.focus();
  });
}
