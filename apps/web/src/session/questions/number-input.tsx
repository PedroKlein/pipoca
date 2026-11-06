import { Button, cn, fieldClass } from "@pipoca/ui";
import type { ReactElement } from "react";
import { type QuestionState, setNumber, typeNumber } from "./questions";
import type { NumberQuestion } from "./question-parts";

export function NumberInput({
  question,
  state,
  onChange,
}: {
  readonly question: NumberQuestion;
  readonly state: QuestionState;
  readonly onChange: (state: QuestionState) => void;
}): ReactElement {
  const unit = question.unit === null ? "" : ` ${question.unit}`;

  const set = (value: number): void => {
    onChange(setNumber(question, state, value));
  };

  const bounds = {
    min: question.min,
    max: question.max,
    step: question.step,
    value: state.value,
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3 text-caption text-fg-dim">
        <span className="whitespace-nowrap">
          {question.min}
          {unit}
        </span>
        <input
          type="range"
          aria-label={question.prompt}
          {...bounds}
          onChange={(event) => {
            set(Number(event.target.value));
          }}
          className="w-full accent-accent"
        />
        <span className="whitespace-nowrap">
          {question.max}
          {unit}
        </span>
      </div>
      <label className="flex items-center gap-2 text-ui">
        <input
          type="number"
          aria-label={`${question.prompt} (value)`}
          {...bounds}
          value={state.text}
          onChange={(event) => {
            onChange(typeNumber(question, state, event.target.value));
          }}
          onBlur={() => {
            onChange({ ...state, text: String(state.value) });
          }}
          className={cn(fieldClass, "w-28")}
        />
        {unit}
      </label>
      {question.recommended !== null && (
        <div>
          <Button
            variant="ghost"
            onClick={() => {
              if (question.recommended !== null) {
                set(question.recommended);
              }
            }}
          >
            ★ Recommended: {question.recommended}
            {unit}
          </Button>
        </div>
      )}
    </div>
  );
}
