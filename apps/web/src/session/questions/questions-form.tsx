import type { Answer, Prompt, Question } from "@pipoca/protocol";
import { Button, Icon, TextArea } from "@pipoca/ui";
import { type ReactElement, useState } from "react";
import type { Explanation } from "../feed";
import {
  answered,
  answerOf,
  answersOf,
  initialState,
  type QuestionState,
  summary,
} from "./questions";
import { type Asking, explanationKey, Explanations } from "./question-parts";
import { Choices } from "./choices";
import { Scale } from "./scale";
import { Rank } from "./rank";
import { NumberInput } from "./number-input";

type QuestionsPrompt = Extract<Prompt, { kind: "questions" }>;

export function QuestionsForm({
  prompt,
  explanations,
  onAnswer,
  onExplain,
}: {
  readonly prompt: QuestionsPrompt;
  readonly explanations: readonly Explanation[];
  readonly onAnswer: (value: Answer) => void;
  readonly onExplain: (
    questionId: string,
    value: string,
    question: string | null,
  ) => void;
}): ReactElement {
  const { questions } = prompt;
  const [current, setCurrent] = useState(0);
  const [note, setNote] = useState("");

  const [states, setStates] = useState<Readonly<Record<string, QuestionState>>>(
    () => Object.fromEntries(questions.map((q) => [q.id, initialState(q)])),
  );

  const [waiting, setWaiting] = useState<Readonly<Record<string, number>>>({});
  const question = questions[current];
  const reviewing = current === questions.length;

  const stateOf = (q: Question): QuestionState =>
    states[q.id] ?? initialState(q);

  const change = (q: Question, next: QuestionState): void => {
    setStates({ ...states, [q.id]: next });
  };

  const asking: Asking = {
    enabled: prompt.explain,
    explanations,
    waiting,
    ask: (questionId, value, text) => {
      const key = explanationKey(questionId, value);

      setWaiting({
        ...waiting,
        [key]: explanations.filter(
          (e) => explanationKey(e.questionId, e.value) === key,
        ).length,
      });

      onExplain(questionId, value, text === "" ? null : text);
    },
  };

  return (
    <div className="flex flex-col gap-4">
      <nav aria-label="Questions" className="flex flex-wrap gap-1">
        {[...questions, undefined].map((q, index) => (
          <button
            key={q?.id ?? "review"}
            type="button"
            aria-current={index === current ? "step" : undefined}
            onClick={() => {
              setCurrent(index);
            }}
            className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-full border border-line px-3 text-label text-fg-dim hover:bg-hover aria-[current=step]:border-accent aria-[current=step]:bg-accent-tint aria-[current=step]:text-fg-strong"
          >
            {q && answered(q, stateOf(q)) && (
              <Icon name="check" className="size-3.5 text-done" />
            )}
            {q?.label ?? "Review"}
          </button>
        ))}
      </nav>

      {question ? (
        <QuestionBody
          key={question.id}
          question={question}
          state={stateOf(question)}
          onChange={(next) => {
            change(question, next);
          }}
          asking={asking}
        />
      ) : (
        <Review
          questions={questions}
          stateOf={stateOf}
          note={note}
          onNote={setNote}
          onOpen={setCurrent}
        />
      )}

      <div className="flex flex-wrap gap-2">
        {current > 0 && (
          <Button
            onClick={() => {
              setCurrent(current - 1);
            }}
          >
            Back
          </Button>
        )}
        {reviewing ? (
          <Button
            variant="primary"
            onClick={() => {
              onAnswer(answersOf(questions, states, note));
            }}
          >
            Submit
          </Button>
        ) : (
          <Button
            variant="primary"
            onClick={() => {
              setCurrent(current + 1);
            }}
          >
            {current === questions.length - 1 ? "Review answers" : "Next"}
          </Button>
        )}
        <Button
          variant="ghost"
          onClick={() => {
            onAnswer(null);
          }}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

function QuestionBody({
  question,
  state,
  onChange,
  asking,
}: {
  readonly question: Question;
  readonly state: QuestionState;
  readonly onChange: (state: QuestionState) => void;
  readonly asking: Asking;
}): ReactElement {
  const [explaining, setExplaining] = useState(false);

  const explained = asking.explanations.some(
    (e) => e.questionId === question.id && e.value === "",
  );

  const input = (): ReactElement => {
    switch (question.type) {
      case "single":
      case "multi":
        return (
          <Choices
            question={question}
            state={state}
            onChange={onChange}
            asking={asking}
          />
        );
      case "scale":
        return (
          <Scale
            question={question}
            state={state}
            onChange={onChange}
            asking={asking}
          />
        );
      case "rank":
        return (
          <Rank
            question={question}
            state={state}
            onChange={onChange}
            asking={asking}
          />
        );
      case "number":
        return (
          <NumberInput question={question} state={state} onChange={onChange} />
        );
      case "text":
        return (
          <TextArea
            aria-label={question.prompt}
            rows={4}
            placeholder={question.placeholder ?? ""}
            value={state.text}
            onChange={(event) => {
              onChange({ ...state, text: event.target.value });
            }}
          />
        );
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-title font-semibold text-fg-strong">
          {question.prompt}
        </h2>
        {asking.enabled && (
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={explaining}
            onClick={() => {
              if (!explaining && !explained) {
                asking.ask(question.id, "", "");
              }

              setExplaining(!explaining);
            }}
            className="shrink-0"
          >
            {explaining ? "Hide explanation" : "Explain this question"}
          </Button>
        )}
      </div>
      {question.context !== null && (
        <p className="text-ui whitespace-pre-wrap text-fg-dim">
          {question.context}
        </p>
      )}
      {explaining && (
        <div className="flex flex-col gap-2 rounded-md border border-line p-3 text-ui">
          <Explanations
            questionId={question.id}
            value=""
            asking={asking}
            placeholder="Ask about this question"
          />
        </div>
      )}
      {input()}
    </div>
  );
}

function Review({
  questions,
  stateOf,
  note,
  onNote,
  onOpen,
}: {
  readonly questions: readonly Question[];
  readonly stateOf: (question: Question) => QuestionState;
  readonly note: string;
  readonly onNote: (note: string) => void;
  readonly onOpen: (index: number) => void;
}): ReactElement {
  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-title font-semibold text-fg-strong">
        Review your answers
      </h2>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-ui">
        {questions.map((question, index) => (
          <div key={question.id} className="contents">
            <dt>
              <button
                type="button"
                onClick={() => {
                  onOpen(index);
                }}
                className="cursor-pointer text-fg-dim hover:text-fg hover:underline"
              >
                {question.label}
              </button>
            </dt>
            <dd>{summary(question, answerOf(question, stateOf(question)))}</dd>
          </div>
        ))}
      </dl>
      <TextArea
        aria-label="Note for the agent"
        rows={3}
        placeholder="Anything else the agent should know?"
        value={note}
        onChange={(event) => {
          onNote(event.target.value);
        }}
      />
    </div>
  );
}
