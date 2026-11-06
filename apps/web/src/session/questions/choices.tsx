import { cn, fieldClass } from "@pipoca/ui";
import { type ReactElement, useState } from "react";
import { otherValue, pick, type QuestionState, typeOther } from "./questions";
import {
  type ChoiceQuestion,
  type Asking,
  Split,
  Annotation,
  OptionLabel,
  Detail,
} from "./question-parts";

export function Choices({
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
  const [hovered, setHovered] = useState<string>();
  const multi = question.type === "multi";

  const shown = question.options.find(
    (option) =>
      option.value ===
      (hovered ?? state.picked.findLast((value) => value !== otherValue)),
  );

  const otherChosen = state.picked.includes(otherValue);

  return (
    <Split
      detail={<Detail question={question} option={shown} asking={asking} />}
    >
      <ul className="flex flex-col gap-1.5">
        {question.options.map((option) => {
          const chosen = state.picked.includes(option.value);

          return (
            <li
              key={option.value}
              onMouseEnter={() => {
                setHovered(option.value);
              }}
              className={cn(
                "flex flex-col gap-2 rounded-md border px-3 py-2",
                chosen ? "border-accent bg-accent-tint" : "border-line",
              )}
            >
              <label className="flex cursor-pointer items-center gap-2.5 text-ui">
                <input
                  type={multi ? "checkbox" : "radio"}
                  name={question.id}
                  checked={chosen}
                  onChange={() => {
                    setHovered(option.value);
                    onChange(pick(question, state, option.value));
                  }}
                  className="accent-accent"
                />
                <span>
                  <OptionLabel option={option} />
                </span>
              </label>
              {chosen && (
                <Annotation
                  state={state}
                  value={option.value}
                  onChange={onChange}
                />
              )}
            </li>
          );
        })}
        <li
          className={cn(
            "rounded-md border px-3 py-2",
            otherChosen ? "border-accent bg-accent-tint" : "border-line",
          )}
        >
          <input
            aria-label="Other answer"
            placeholder="Other: type your own…"
            value={state.other}
            onChange={(event) => {
              onChange(typeOther(question, state, event.target.value));
            }}
            className={cn(
              fieldClass,
              "w-full border-transparent bg-transparent px-0",
            )}
          />
        </li>
      </ul>
    </Split>
  );
}
