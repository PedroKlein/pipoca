import type { Question, Session } from "@pipoca/protocol";
import type { Person } from "./server";

// The event a Session's work came from, as a plugin heard it (ADR 0076).
export interface Origin {
  readonly event: `${string}.${string}`;
  readonly fields: Readonly<Record<string, unknown>>;
}

// How the questions of a Session another plugin started wait: the turn ends,
// and the answer comes later as a message (ADR 0076).
export interface Waiting {
  // Where the questions are posted too.
  readonly origin?: Origin;
  // The person the work is for, who may answer anywhere, by id.
  readonly owner?: string;
  // The people a question is for, who may answer anywhere, by id.
  readonly for?: readonly string[];
  // How long a question waits for an answer when it doesn't say.
  readonly timeoutMs?: number;
}

// A question that waits, as its place shows it.
export interface PostedQuestion {
  readonly id: string;
  readonly session: Session;
  readonly origin: Origin;
  readonly questions: readonly Question[];
  // The questions in Markdown. The place adds how to answer there.
  readonly text: string;
  readonly closesAt: string;
  // The owner and the people it is for, who may answer wherever it is.
  readonly answerers: readonly Person[];
}

// An answer someone gave where the question was posted, by the name that
// place knows them by, such as a login or an address.
export interface Reply {
  readonly text: string;
  readonly by: string;
}

// Questions a plugin asks in one of its Sessions from the server, such as an
// approval, which wait as Pi's do.
export interface Asking {
  readonly questions: readonly Question[];
  // Each question's answer when nobody gives one in time, by question id.
  readonly defaults?: Readonly<Record<string, string>>;
  // More people it is for, by id.
  readonly for?: readonly string[];
}

export interface OpenQuestion {
  readonly id: string;
  readonly questions: readonly Question[];
  readonly closesAt: string;
}

// What a plugin that publishes events does to ask where one of them came
// from, such as a comment on the issue: false when it can't, so the
// question stays in Pipoca.
export interface ReplyPlace {
  readonly post: (question: PostedQuestion) => Promise<boolean>;
}

// The plugin that keeps the questions that wait. One per server does.
export interface QuestionKeeper {
  readonly wait: (sessionId: string, waiting: Waiting) => void;
  // false when the question is closed or there is none of that id.
  readonly answer: (id: string, reply: Reply) => boolean;
  readonly open: (sessionId: string) => readonly OpenQuestion[];
  // undefined when the Session doesn't wait past its turn.
  readonly ask: (sessionId: string, asking: Asking) => OpenQuestion | undefined;
}

// Any plugin's way to the kept questions. Without a keeper, questions hold
// the turn open as they always did, and none is open.
export interface Questions {
  // false when no plugin keeps questions.
  readonly wait: (sessionId: string, waiting: Waiting) => boolean;
  readonly answer: (id: string, reply: Reply) => boolean;
  readonly open: (sessionId: string) => readonly OpenQuestion[];
  // undefined when no plugin keeps questions or the Session doesn't wait.
  readonly ask: (sessionId: string, asking: Asking) => OpenQuestion | undefined;
}

export interface QuestionDesk {
  // Posts the question where its origin's plugin says, and says whether
  // it did.
  readonly post: (question: PostedQuestion) => Promise<boolean>;
}
