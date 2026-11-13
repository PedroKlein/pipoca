import { expect, test } from "bun:test";
import { isComposing, sendsOnEnter } from "./keys";

test("treats a keydown that commits an IME conversion as composing", () => {
  expect(isComposing({ keyCode: 13, nativeEvent: { isComposing: true } })).toBe(
    true,
  );

  expect(
    isComposing({ keyCode: 229, nativeEvent: { isComposing: false } }),
  ).toBe(true);

  expect(
    isComposing({ keyCode: 13, nativeEvent: { isComposing: false } }),
  ).toBe(false);
});

const enter = {
  key: "Enter",
  keyCode: 13,
  nativeEvent: { isComposing: false },
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
};

test("Enter sends, Shift+Enter and an IME commit don't", () => {
  expect(sendsOnEnter(enter, false)).toBe(true);
  expect(sendsOnEnter({ ...enter, shiftKey: true }, false)).toBe(false);
  expect(sendsOnEnter({ ...enter, keyCode: 229 }, false)).toBe(false);
  expect(sendsOnEnter({ ...enter, key: "a" }, false)).toBe(false);
});

test("on a phone only Cmd or Ctrl+Enter sends", () => {
  expect(sendsOnEnter(enter, true)).toBe(false);
  expect(sendsOnEnter({ ...enter, metaKey: true }, true)).toBe(true);
  expect(sendsOnEnter({ ...enter, ctrlKey: true }, true)).toBe(true);
});
