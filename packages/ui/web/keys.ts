// Enter that commits an IME conversion must not submit. Safari fires that
// keydown after compositionend, so only keyCode 229 gives it away.
export function isComposing(event: {
  readonly keyCode: number;
  readonly nativeEvent: { readonly isComposing: boolean };
}): boolean {
  return event.nativeEvent.isComposing || event.keyCode === 229;
}

// Enter sends and Shift+Enter starts a new line. On a phone Enter is the only
// way to start a new line, so only Cmd or Ctrl+Enter sends there, as in
// Claude Code on the web.
export function sendsOnEnter(
  event: Parameters<typeof isComposing>[0] & {
    readonly key: string;
    readonly shiftKey: boolean;
    readonly metaKey: boolean;
    readonly ctrlKey: boolean;
  },
  phone = matchMedia("(pointer: coarse)").matches,
): boolean {
  return (
    !isComposing(event) &&
    event.key === "Enter" &&
    !event.shiftKey &&
    (event.metaKey || event.ctrlKey || !phone)
  );
}
