import type { Question } from "@pipoca/protocol";

// Each question's answer when nobody gives one in time, by question id: an
// option's value, a number or text.
export type Defaults = Readonly<Record<string, string>>;

// How a question the Session asked waits: in the Session, holding the turn
// open, or past the turn, for an answer that comes as a message.
export type Asked =
  | { readonly wait: "here" }
  | {
      readonly wait: "message";
      readonly id: string;
      readonly closesAt: string;
    };

// A question that waits past its turn, as the Session's page shows it.
export interface WaitingQuestion {
  readonly id: string;
  readonly questions: readonly Question[];
  readonly closesAt: string;
  readonly mayAnswer: boolean;
}

export interface WaitingQuestions {
  readonly questions: readonly WaitingQuestion[];
}

const units = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

export const durationPattern = "^[1-9][0-9]*[smhd]$";

// "30m" or "24h" in milliseconds.
export function durationMs(text: string): number {
  const unit = text.slice(-1) as keyof typeof units;

  return Number(text.slice(0, -1)) * units[unit];
}

// A default's words, such as an option's label.
function defaultOf(question: Question, value: string): string {
  if ("options" in question) {
    return value
      .split(",")
      .map(
        (each) =>
          question.options.find((option) => option.value === each.trim())
            ?.label ?? each.trim(),
      )
      .join(", ");
  }

  return question.type === "number" && question.unit !== null
    ? `${value} ${question.unit}`
    : value;
}

// What Pi hears when nobody answered in time.
export function timedOut(
  questions: readonly Question[],
  defaults: Defaults,
): string {
  const taken = questions.flatMap((question) => {
    const value = defaults[question.id];

    return value === undefined
      ? []
      : [`- ${question.label}: ${defaultOf(question, value)}`];
  });

  if (taken.length === 0) {
    return "Nobody answered in time, and the questions have no default answer. If you can't go on without an answer, stop and say that you are blocked.";
  }

  return [
    "Nobody answered in time, so take the default answers:",
    ...taken,
  ].join("\n");
}

// The questions in Markdown, as a comment, a Slack reply or a mail shows
// them.
export function questionText(
  questions: readonly Question[],
  defaults: Defaults,
  closesAt: string,
): string {
  const asked = questions.map((question) => {
    const lines = [`**${question.prompt}**`];

    if (question.context !== null) {
      lines.push(question.context);
    }

    if ("options" in question) {
      lines.push(
        ...question.options.map(
          (option) =>
            `- ${option.label}${option.recommended ? " (recommended)" : ""}${option.description === null ? "" : `: ${option.description}`}`,
        ),
      );
    }

    if (question.type === "number") {
      lines.push(
        `A number from ${String(question.min)} to ${String(question.max)}${question.unit === null ? "" : ` ${question.unit}`}.`,
      );
    }

    const value = defaults[question.id];

    if (value !== undefined) {
      lines.push(`If nobody answers: ${defaultOf(question, value)}.`);
    }

    return lines.join("\n");
  });

  return [
    "Pi is waiting for an answer.",
    ...asked,
    `It waits until ${closesAt}.`,
  ].join("\n\n");
}
