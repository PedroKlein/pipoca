import type { MountedSession } from "@pipoca/plugins/web";
import type { Answer, Prompt } from "@pipoca/protocol";
import { Button, TextArea, TextInput } from "@pipoca/ui";
import { type ReactElement, useState } from "react";
import { PluginBoundary } from "../../plugin-boundary";
import { permissionRenderer } from "../../plugins";
import type { OpenPrompt } from "../feed";
import { QuestionsForm } from "./questions-form";

export interface PromptHandlers {
  readonly answer: (id: string, value: Answer) => void;
  readonly explain: (
    id: string,
    questionId: string,
    value: string,
    question: string | null,
  ) => void;
}

export function PromptCard({
  open,
  handlers,
  session,
}: {
  readonly open: OpenPrompt;
  readonly handlers: PromptHandlers;
  readonly session: MountedSession;
}): ReactElement {
  const { prompt } = open;

  const answer = (value: Answer): void => {
    handlers.answer(prompt.id, value);
  };

  const tool = prompt.kind === "permission" ? prompt.tool : undefined;
  const drawn = tool && permissionRenderer(tool.name);

  if (tool && drawn) {
    const { plugin, Component } = drawn;

    return (
      <section data-role="prompt" aria-label={prompt.title}>
        <PluginBoundary name={plugin}>
          <Component
            session={session}
            title={prompt.title}
            input={tool.input}
            onAnswer={answer}
          />
        </PluginBoundary>
      </section>
    );
  }

  const body = (): ReactElement => {
    switch (prompt.kind) {
      case "permission":
        return <PermissionPrompt prompt={prompt} onAnswer={answer} />;
      case "questions":
        return (
          <QuestionsForm
            prompt={prompt}
            explanations={open.explanations}
            onAnswer={answer}
            onExplain={(questionId, value, question) => {
              handlers.explain(prompt.id, questionId, value, question);
            }}
          />
        );
      case "confirm":
      case "select":
      case "input":
      case "secret":
      case "editor":
        return <SimplePrompt prompt={prompt} onAnswer={answer} />;
    }
  };

  return (
    <section
      data-role="prompt"
      aria-label={prompt.title}
      className="flex flex-col gap-3 rounded-xl border border-line-strong border-t-3 border-t-waiting bg-elevated p-4 shadow-card"
    >
      <strong className="text-label font-semibold text-waiting">
        {prompt.kind === "permission" ? "Permission needed" : prompt.title}
      </strong>
      {prompt.kind === "questions" && prompt.for !== undefined && (
        <p data-role="asked" className="-mt-2 text-caption text-fg-dim">
          For {prompt.for}. Anyone on the team can answer for them.
        </p>
      )}
      {body()}
    </section>
  );
}

function PermissionPrompt({
  prompt,
  onAnswer,
}: {
  readonly prompt: Extract<Prompt, { kind: "permission" }>;
  readonly onAnswer: (value: Answer) => void;
}): ReactElement {
  return (
    <>
      <h2 className="text-title font-semibold text-fg-strong">
        {prompt.title}
      </h2>
      {prompt.details.length > 0 && (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-ui">
          {prompt.details.map(({ label, value }) => (
            <div key={label} className="contents">
              <dt className="text-fg-dim">{label}</dt>
              <dd className="max-h-48 overflow-auto break-words whitespace-pre-wrap">
                {value}
              </dd>
            </div>
          ))}
        </dl>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          onClick={() => {
            onAnswer("once");
          }}
        >
          Allow
        </Button>
        <Button
          onClick={() => {
            onAnswer("session");
          }}
        >
          Allow for this session
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            onAnswer("deny");
          }}
        >
          Deny
        </Button>
      </div>
    </>
  );
}

function SimplePrompt({
  prompt,
  onAnswer,
}: {
  readonly prompt: Exclude<Prompt, { kind: "questions" | "permission" }>;
  readonly onAnswer: (value: Answer) => void;
}): ReactElement {
  const [text, setText] = useState(
    prompt.kind === "editor" ? (prompt.prefill ?? "") : "",
  );

  const cancel = (
    <Button
      variant="ghost"
      onClick={() => {
        onAnswer(null);
      }}
    >
      Cancel
    </Button>
  );

  switch (prompt.kind) {
    case "confirm":
      return (
        <>
          <p className="text-prose whitespace-pre-wrap">{prompt.message}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              onClick={() => {
                onAnswer(true);
              }}
            >
              Yes
            </Button>
            <Button
              onClick={() => {
                onAnswer(false);
              }}
            >
              No
            </Button>
          </div>
        </>
      );
    case "select":
      return (
        <div className="flex flex-wrap gap-2">
          {prompt.options.map((option) => (
            <Button
              key={option}
              onClick={() => {
                onAnswer(option);
              }}
            >
              {option}
            </Button>
          ))}
          {cancel}
        </div>
      );
    case "input":
    case "secret":
    case "editor":
      return (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onAnswer(text);
          }}
          className="flex flex-col gap-3"
        >
          {prompt.kind === "editor" ? (
            <TextArea
              aria-label={prompt.title}
              rows={8}
              value={text}
              onChange={(event) => {
                setText(event.target.value);
              }}
            />
          ) : (
            <TextInput
              type={prompt.kind === "secret" ? "password" : "text"}
              aria-label={prompt.title}
              autoComplete="off"
              placeholder={prompt.placeholder ?? ""}
              value={text}
              onChange={(event) => {
                setText(event.target.value);
              }}
            />
          )}
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" type="submit">
              Submit
            </Button>
            {cancel}
          </div>
        </form>
      );
  }
}
