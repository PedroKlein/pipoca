import type { Attachment } from "@pipoca/plugins/web";
import { type RefObject, useEffect } from "react";
import type { Feed } from "../feed";

interface Prefill {
  readonly text: string;
  readonly attachments: readonly Attachment[];
}

// The message a fork from a message starts with in its composer, as Pi's
// /fork puts it back in the editor, or a draft a page asks for. A composer
// already open takes it at once.
const prefills = new Map<string, Prefill>();

const listeners = new Set<() => void>();

// The Sessions whose composer shows, such as a Project's chat on its page.
const open = new Map<string, number>();

export function composerOpen(sessionId: string): boolean {
  return (open.get(sessionId) ?? 0) > 0;
}

export function prefillComposer(
  sessionId: string,
  text: string,
  attachments: readonly Attachment[] = [],
): void {
  const before = prefills.get(sessionId);

  prefills.set(sessionId, {
    text: text === "" ? (before?.text ?? "") : text,
    attachments: [...(before?.attachments ?? []), ...attachments],
  });

  for (const listener of listeners) {
    listener();
  }
}

export function usePrefill(
  sessionId: string,
  textRef: RefObject<HTMLTextAreaElement | null>,
  editorText: Feed["editorText"],
  onAttach: (attachments: readonly Attachment[]) => void,
): void {
  useEffect(() => {
    const take = (): void => {
      const prefilled = prefills.get(sessionId);

      if (prefilled !== undefined && textRef.current) {
        prefills.delete(sessionId);

        if (prefilled.text !== "") {
          textRef.current.value = prefilled.text;
        }

        if (prefilled.attachments.length > 0) {
          onAttach(prefilled.attachments);
        }

        textRef.current.focus();
      }
    };

    take();
    listeners.add(take);
    open.set(sessionId, (open.get(sessionId) ?? 0) + 1);

    return () => {
      listeners.delete(take);
      open.set(sessionId, (open.get(sessionId) ?? 1) - 1);
    };
  }, [sessionId, textRef, onAttach]);

  useEffect(() => {
    if (editorText && textRef.current) {
      textRef.current.value = editorText.text;
      textRef.current.focus();
    }
  }, [editorText, textRef]);
}
