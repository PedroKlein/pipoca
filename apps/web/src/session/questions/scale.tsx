import { cn } from "@pipoca/ui";
import type { ReactElement } from "react";
import { pick, type QuestionState } from "./questions";
import {
  type ChoiceQuestion,
  type Asking,
  Split,
  Annotation,
  OptionLabel,
  Detail,
} from "./question-parts";

export function Scale({
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
  const index = Math.max(
    0,
    question.options.findIndex((option) => option.value === state.picked[0]),
  );

  const option = question.options[index];

  const choose = (at: number): void => {
    const picked = question.options[at];
    if (picked) {
      onChange(pick(question, state, picked.value));
    }
  };

  return (
    <Split
      detail={<Detail question={question} option={option} asking={asking} />}
    >
      <div className="flex flex-col gap-3">
        <input
          type="range"
          aria-label={question.prompt}
          min={0}
          max={question.options.length - 1}
          step={1}
          value={index}
          onChange={(event) => {
            choose(Number(event.target.value));
          }}
          className="w-full accent-accent"
        />
        <div className="flex justify-between gap-1">
          {question.options.map((o, at) => (
            <button
              key={o.value}
              type="button"
              onClick={() => {
                choose(at);
              }}
              className={cn(
                "cursor-pointer text-caption",
                at === index ? "font-semibold text-fg-strong" : "text-fg-dim",
              )}
            >
              <OptionLabel option={o} />
            </button>
          ))}
        </div>
        {option && (
          <Annotation state={state} value={option.value} onChange={onChange} />
        )}
      </div>
    </Split>
  );
}
