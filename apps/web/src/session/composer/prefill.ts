import { type RefObject, useEffect } from "react";
import type { Feed } from "../feed";

// The message a fork from a message starts with in its composer, as Pi's
// /fork puts it back in the editor.
const prefills = new Map<string, string>();

export function prefillComposer(sessionId: string, text: string): void {
  prefills.set(sessionId, text);
}

export function usePrefill(
  sessionId: string,
  textRef: RefObject<HTMLTextAreaElement | null>,
  editorText: Feed["editorText"],
): void {
  useEffect(() => {
    const prefilled = prefills.get(sessionId);

    if (prefilled !== undefined && textRef.current) {
      prefills.delete(sessionId);
      textRef.current.value = prefilled;
      textRef.current.focus();
    }
  }, [sessionId, textRef]);

  useEffect(() => {
    if (editorText && textRef.current) {
      textRef.current.value = editorText.text;
      textRef.current.focus();
    }
  }, [editorText, textRef]);
}
