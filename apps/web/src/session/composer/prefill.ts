import { type RefObject, useEffect } from "react";
import type { Feed } from "../feed";

// The message a fork from a message starts with in its composer, as Pi's
// /fork puts it back in the editor, or a draft a page asks for. A composer
// already open takes it at once.
const prefills = new Map<string, string>();

const listeners = new Set<() => void>();

export function prefillComposer(sessionId: string, text: string): void {
  prefills.set(sessionId, text);

  for (const listener of listeners) {
    listener();
  }
}

export function usePrefill(
  sessionId: string,
  textRef: RefObject<HTMLTextAreaElement | null>,
  editorText: Feed["editorText"],
): void {
  useEffect(() => {
    const take = (): void => {
      const prefilled = prefills.get(sessionId);

      if (prefilled !== undefined && textRef.current) {
        prefills.delete(sessionId);
        textRef.current.value = prefilled;
        textRef.current.focus();
      }
    };

    take();
    listeners.add(take);

    return () => {
      listeners.delete(take);
    };
  }, [sessionId, textRef]);

  useEffect(() => {
    if (editorText && textRef.current) {
      textRef.current.value = editorText.text;
      textRef.current.focus();
    }
  }, [editorText, textRef]);
}
