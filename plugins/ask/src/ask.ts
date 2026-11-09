import type {
  Question,
  QuestionAnswer,
  QuestionsAnswer,
} from "@pipoca/protocol";
import {
  type Explain,
  type SessionContext,
  type SessionTool,
  type SessionToolCall,
  type Static,
  StringEnum,
  ToolError,
  Type,
} from "@pipoca/plugins";
import {
  type Asked,
  type Defaults,
  durationMs,
  durationPattern,
  timedOut,
} from "./waiting";

const OptionSchema = Type.Object({
  value: Type.String({ description: "Value identifier for this option" }),
  label: Type.String({ description: "Display label" }),
  description: Type.Optional(
    Type.String({
      description:
        "Shown in the detail panel when the option is highlighted. Always provide this.",
    }),
  ),
  recommended: Type.Optional(
    Type.Boolean({ description: "Mark as recommended (shows a ★ badge)" }),
  ),
});

const QuestionSchema = Type.Object({
  id: Type.String({ description: "Unique question identifier" }),
  label: Type.Optional(
    Type.String({
      description: "Short tab label (2-3 words), defaults to Q1, Q2...",
    }),
  ),
  prompt: Type.String({ description: "Full question text" }),
  type: StringEnum(
    ["single", "multi", "scale", "rank", "text", "number"] as const,
    {
      description:
        "single=pick one, multi=pick many, scale=pick one point on an ordered range, rank=put options in order, text=free input, number=pick a number on a slider",
    },
  ),
  context: Type.Optional(
    Type.String({ description: "Help text shown below the question" }),
  ),
  options: Type.Optional(
    Type.Array(OptionSchema, {
      description:
        "Choices for single, multi, scale (in order, low to high) and rank. Omit for text and number.",
    }),
  ),
  placeholder: Type.Optional(
    Type.String({ description: "Placeholder for text questions" }),
  ),
  min: Type.Optional(Type.Number({ description: "Lowest number (number)" })),
  max: Type.Optional(Type.Number({ description: "Highest number (number)" })),
  step: Type.Optional(
    Type.Number({ description: "Slider step (number), defaults to 1" }),
  ),
  unit: Type.Optional(
    Type.String({ description: "Unit shown next to the number, like GB" }),
  ),
  recommendedValue: Type.Optional(
    Type.Number({ description: "Recommended number (number)" }),
  ),
  default: Type.Optional(
    Type.String({
      description:
        "The answer taken when nobody answers before the timeout: an option's value (values split by commas for multi and rank), a number, or text. Without one, a timeout leaves the question unanswered.",
    }),
  ),
});

const AskUserParams = Type.Object({
  questions: Type.Array(QuestionSchema, {
    description: "One or more questions to present to the user",
  }),
  for: Type.Optional(
    Type.String({
      description:
        "In team work, the name of the person to ask, such as whoever started the work or asked for this part of it. Anyone on the team may answer for them.",
    }),
  ),
  timeout: Type.Optional(
    Type.String({
      pattern: durationPattern,
      description:
        "How long to wait for an answer, such as 30m, 24h or 2d. Once it passes, the questions take their defaults.",
    }),
  ),
});

type RawQuestion = Static<typeof QuestionSchema>;

export function askUser(
  s: Pick<SessionContext, "askQuestions" | "api" | "timer">,
): SessionTool<typeof AskUserParams> {
  return {
    name: "ask_user",
    label: "Ask User",
    description:
      "Present structured questions to the user as an interactive form. " +
      "Use this tool whenever you need the user to choose between options, confirm decisions, or provide input. " +
      "Supports single choice, multiple choice, a point on an ordered scale, ranking, free text and numbers on a slider. " +
      "Users can annotate their choices, add their own option, and ask about an option before answering. " +
      "Always provide a description for each option: it is shown in the detail panel when the option is highlighted.",
    // Asking changes nothing, so a meta-session never asks before it.
    annotations: { readOnly: true },
    prompt: {
      snippet:
        "Ask the user structured questions in a form (single/multi choice, scale, rank, text, number)",
      guidelines: [
        "ALWAYS use ask_user when you need user input on choices or decisions. Never list options as plain text and ask the user to pick.",
        "Ask the questions you need now together, in one call, and don't ask again about what the user already decided.",
        "Provide a meaningful 'description' for EVERY option, it is shown in a detail panel and helps the user decide.",
        "Use 'recommended: true' on options you think are best, or 'recommendedValue' for numbers, with reasoning in the description or context.",
        "Use 'multi' when several options could apply, 'single' when exactly one must be chosen, 'scale' for a point on an ordered range, 'rank' to order options, 'number' for a quantity, and 'text' for open-ended questions.",
        "For questions that need context or explanation, present the context in your chat message before calling ask_user. Keep the 'prompt' field short (one line).",
        "To ask for approval, ask a 'single' question with the options approve and reject.",
        "When ask_user says the question waits for an answer as a message, end your turn. The answer comes later as a message that names the question's id.",
      ],
    },
    params: AskUserParams,
    sequential: true,
    run: async (params, call) => {
      const questions = params.questions.map(normalize);
      if (questions.length === 0) {
        throw new ToolError("No questions provided.");
      }

      const defaults = defaultsOf(params.questions, questions);

      const timeoutMs =
        params.timeout === undefined ? undefined : durationMs(params.timeout);

      const asked = await s.api.post<Asked>("questions", {
        questions,
        defaults,
        ...(params.for !== undefined && { for: params.for }),
        ...(timeoutMs !== undefined && { timeoutMs }),
      });

      if (asked.wait === "message") {
        return {
          text: `Question ${asked.id} waits for an answer until ${asked.closesAt}. End your turn now. The answer comes as a message that names question ${asked.id}.`,
          details: { questions, question: asked.id, closesAt: asked.closesAt },
          endsTurn: true,
        };
      }

      const late = new AbortController();

      const stop =
        timeoutMs === undefined
          ? undefined
          : s.timer.after(timeoutMs, async () => {
              late.abort();

              return Promise.resolve();
            });

      const answer = await s.askQuestions(
        questions,
        explainer(call, questions),
        call.signal === undefined
          ? late.signal
          : AbortSignal.any([call.signal, late.signal]),
        params.for,
      );

      stop?.();

      if (late.signal.aborted) {
        return {
          text: timedOut(questions, defaults),
          details: { questions, answer: null, defaults },
        };
      }

      return {
        text: describe(questions, answer, params.for),
        details: { questions, answer },
      };
    },
  };
}

function defaultsOf(
  raw: readonly RawQuestion[],
  questions: readonly Question[],
): Defaults {
  return Object.fromEntries(
    questions.flatMap((question, index) => {
      const value = raw[index]?.default;

      if (value === undefined) {
        return [];
      }

      if ("options" in question) {
        const values = question.options.map((option) => option.value);

        const picked =
          question.type === "multi" || question.type === "rank"
            ? value.split(",").map((each) => each.trim())
            : [value];

        if (picked.some((each) => !values.includes(each))) {
          throw new ToolError(
            `Question "${question.id}" has default "${value}", which is not one of its options' values.`,
          );
        }
      }

      if (
        question.type === "number" &&
        !(Number(value) >= question.min && Number(value) <= question.max)
      ) {
        throw new ToolError(
          `Question "${question.id}" has default ${value}, outside ${String(question.min)} to ${String(question.max)}.`,
        );
      }

      return [[question.id, value]];
    }),
  );
}

function normalize(raw: RawQuestion, index: number): Question {
  const base = {
    id: raw.id,
    label: raw.label ?? `Q${String(index + 1)}`,
    prompt: raw.prompt,
    context: raw.context ?? null,
  };

  switch (raw.type) {
    case "single":
    case "multi":
    case "scale":
    case "rank": {
      const options = raw.options ?? [];
      if (options.length === 0) {
        throw new ToolError(
          `Question "${raw.id}" is type "${raw.type}" but has no options.`,
        );
      }

      return {
        ...base,
        type: raw.type,
        options: options.map((option) => ({
          value: option.value,
          label: option.label,
          description: option.description ?? null,
          recommended: option.recommended === true,
        })),
      };
    }

    case "text":
      return { ...base, type: "text", placeholder: raw.placeholder ?? null };
    case "number": {
      if (raw.min === undefined || raw.max === undefined) {
        throw new ToolError(
          `Question "${raw.id}" is type "number" but has no min or max.`,
        );
      }

      const step = raw.step ?? 1;

      if (step <= 0) {
        throw new ToolError(
          `Question "${raw.id}" has step ${String(step)}; step must be above 0.`,
        );
      }

      if (raw.min > raw.max) {
        throw new ToolError(
          `Question "${raw.id}" has min ${String(raw.min)} above max ${String(raw.max)}.`,
        );
      }

      return {
        ...base,
        type: "number",
        min: raw.min,
        max: raw.max,
        step,
        unit: raw.unit ?? null,
        recommended: raw.recommendedValue ?? null,
      };
    }
  }
}

// An explanation asked with no option is about the question itself.
const wholeQuestion = "";

function explainer(
  { complete }: SessionToolCall,
  questions: readonly Question[],
): Explain | undefined {
  if (complete === undefined) {
    return undefined;
  }

  return async (questionId, value, question) => {
    const asked = questions.find((q) => q.id === questionId);

    if (!asked) {
      throw new Error(`no question ${questionId}`);
    }

    const options = "options" in asked ? asked.options : [];
    const context = asked.context === null ? [] : [`Context: ${asked.context}`];

    if (value === wholeQuestion) {
      return complete({
        system:
          "You help a person understand a question they were asked, without answering it for them. Be concise and practical, in plain words. No markdown formatting.",
        prompt: [
          `Question: "${asked.prompt}"`,
          ...context,
          ...options.map(
            (o) =>
              `Option: ${o.label}${o.description === null ? "" : ` (${o.description})`}`,
          ),
          "",
          question === null
            ? "Explain what this question decides, why it matters, and any terms the person may not know. Don't pick an option. 2-3 short paragraphs at most."
            : `The person's question about it: ${question}\n\nAnswer concisely in 2-3 short paragraphs, without picking an option for them.`,
        ].join("\n"),
        withConversation: true,
      });
    }

    const option = options.find((o) => o.value === value);
    if (!option) {
      throw new Error(`no option ${value} in question ${questionId}`);
    }

    const others = options
      .filter((o) => o !== option)
      .map((o) => o.label)
      .join(", ");

    const prompt = [
      `Question being answered: "${asked.prompt}"`,
      `Option: "${option.label}"`,
      option.description === null
        ? ""
        : `Option details: ${option.description}`,
      others === "" ? "" : `Other options: ${others}`,
      ...context,
      "",
      question === null
        ? "Explain this option concisely: trade-offs, when it's a good or bad fit, and how it compares to the alternatives. 2-3 short paragraphs at most."
        : `The user's question about this option: ${question}\n\nAnswer concisely in 2-3 short paragraphs.`,
    ]
      .filter((line, i, lines) => line !== "" || lines[i - 1] !== "")
      .join("\n");

    return complete({
      system:
        "You explain options for decision-making. Be concise and practical. No markdown formatting.",
      prompt,
      withConversation: true,
    });
  };
}

function describe(
  questions: readonly Question[],
  answer: QuestionsAnswer | null,
  person: string | undefined,
): string {
  if (answer === null) {
    return "User dismissed the questions without answering. Don't act on them or pick their recommended options: the user may want something else. Ask what they want, in words, before going on.";
  }

  const lines = answer.answers.flatMap((given) => {
    const question = questions.find((q) => q.id === given.id);

    return question ? describeAnswer(question, given) : [];
  });

  if (answer.note !== null && answer.note.trim() !== "") {
    lines.push(`- Additional notes: ${answer.note.trim()}`);
  }

  const who = answerer(answer.by, person);

  return lines.length === 0
    ? `${who} submitted with no answers.`
    : [`${who} answers:`, ...lines].join("\n");
}

// In team work Pi hears who answered, and for whom when it wasn't the person
// it asked.
function answerer(by: string | undefined, person: string | undefined): string {
  if (by === undefined) {
    return "User";
  }

  return person === undefined || by === person
    ? by
    : `${by}, answering for ${person},`;
}

function describeAnswer(question: Question, given: QuestionAnswer): string[] {
  const { label } = question;

  switch (given.type) {
    case "text":
      return given.text.trim() === ""
        ? []
        : [`- ${label}: ${given.text.trim()}`];
    case "number": {
      const unit =
        question.type === "number" && question.unit !== null
          ? ` ${question.unit}`
          : "";

      return [`- ${label}: ${String(given.value)}${unit}`];
    }

    case "choice": {
      const name = (selection: (typeof given.selections)[number]): string =>
        `${selection.label}${selection.custom ? " (custom)" : ""}`;

      const note = (selection: (typeof given.selections)[number]): string[] =>
        selection.annotation === null || selection.annotation.trim() === ""
          ? []
          : [`    → "${selection.annotation.trim()}"`];

      if (question.type === "rank") {
        const order = given.selections
          .map((selection, i) => `${String(i + 1)}. ${name(selection)}`)
          .join(", ");

        return [`- ${label}: ${order}`, ...given.selections.flatMap(note)];
      }

      return given.selections.flatMap((selection) => [
        `- ${label}: ${name(selection)}`,
        ...note(selection),
      ]);
    }
  }
}
