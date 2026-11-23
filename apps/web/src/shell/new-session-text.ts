import type { Attachment } from "@pipoca/plugins/web";

// What a plugin asks the New session composer to open with, such as a
// template to start from.
export interface FirstMessage {
  readonly text: string;
  readonly attachments: readonly Attachment[];
}

const listeners = new Set<(first: FirstMessage) => void>();

export function askNewSession(
  text: string,
  attachments: readonly Attachment[] = [],
): void {
  for (const listener of listeners) {
    listener({ text, attachments });
  }
}

export function listenNewSession(
  listener: (first: FirstMessage) => void,
): () => void {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}
