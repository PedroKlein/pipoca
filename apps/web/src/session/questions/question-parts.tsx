import type { Question, QuestionOption } from "@pipoca/protocol";
import { Button, cn, fieldClass } from "@pipoca/ui";
import { type ReactElement, useState } from "react";
import type { Explanation } from "../feed";
import type { QuestionState } from "./questions";

export type ChoiceQuestion = Extract<Question, { options: unknown }>;
export type NumberQuestion = Extract<Question, { type: "number" }>;

export interface Asking {
  readonly enabled: boolean;
  readonly explanations: readonly Explanation[];
  readonly waiting: Readonly<Record<string, number>>;
  readonly ask: (questionId: string, value: string, text: string) => void;
}

export const explanationKey = (questionId: string, value: string): string =>
  `${questionId}\u0000${value}`;

export function Split({
  children,
  detail,
}: {
  readonly children: ReactElement;
  readonly detail: ReactElement;
}): ReactElement {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {children}
      {detail}
    </div>
  );
}

export function Annotation({
  state,
  value,
  onChange,
}: {
  readonly state: QuestionState;
  readonly value: string;
  readonly onChange: (state: QuestionState) => void;
}): ReactElement {
  return (
    <input
      aria-label="Note for this choice"
      placeholder="Add a note to this choice"
      value={state.annotations[value] ?? ""}
      onChange={(event) => {
        onChange({
          ...state,
          annotations: { ...state.annotations, [value]: event.target.value },
        });
      }}
      className={cn(fieldClass, "py-1 text-label")}
    />
  );
}

export function OptionLabel({
  option,
}: {
  readonly option: QuestionOption;
}): ReactElement {
  return (
    <>
      {option.label}
      {option.recommended && (
        <span className="text-waiting" title="Recommended">
          {" "}
          ★
        </span>
      )}
    </>
  );
}

export function Detail({
  question,
  option,
  asking,
}: {
  readonly question: ChoiceQuestion;
  readonly option: QuestionOption | undefined;
  readonly asking: Asking;
}): ReactElement {
  const [text, setText] = useState("");

  if (!option) {
    return (
      <div className="border-l-3 border-line pl-3 text-label text-fg-dim">
        Pick or hover an option to see its details.
      </div>
    );
  }

  const key = explanationKey(question.id, option.value);

  const found = asking.explanations.filter(
    (e) => explanationKey(e.questionId, e.value) === key,
  );

  const waiting =
    key in asking.waiting && found.length <= (asking.waiting[key] ?? 0);

  return (
    <div className="flex flex-col gap-2 border-l-3 border-line pl-3 text-ui">
      <h3 className="font-semibold text-fg-strong">{option.label}</h3>
      {option.recommended && (
        <p className="text-label font-semibold text-waiting">★ Recommended</p>
      )}
      {option.description !== null && (
        <p className="whitespace-pre-wrap">{option.description}</p>
      )}
      {asking.enabled && (
        <>
          {found.map((entry, at) => (
            <div
              key={`${String(at)}-${entry.question ?? ""}`}
              className="flex flex-col gap-1 rounded-md bg-code p-2"
            >
              <small className="text-caption text-fg-dim">
                {entry.question ?? "Explanation"}
              </small>
              <p
                className={cn(
                  "whitespace-pre-wrap",
                  entry.error !== null && "text-failed",
                )}
              >
                {entry.text ?? entry.error ?? ""}
              </p>
            </div>
          ))}
          {waiting && <p className="text-label text-fg-dim">Thinking…</p>}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              asking.ask(question.id, option.value, text.trim());
              setText("");
            }}
            className="flex gap-2"
          >
            <input
              aria-label="Ask about this option"
              placeholder="Ask about this option (empty explains it)"
              value={text}
              onChange={(event) => {
                setText(event.target.value);
              }}
              className={cn(fieldClass, "min-w-0 flex-1")}
            />
            <Button type="submit">Ask</Button>
          </form>
        </>
      )}
    </div>
  );
}
