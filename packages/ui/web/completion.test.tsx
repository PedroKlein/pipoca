import { expect, test } from "bun:test";
import { act, type ReactElement, useState } from "react";
import { type Typed, useCompletion } from "./completion";
import { render, withPage } from "./testing/render";

withPage();

const names = ["Ana Souza", "Bo", "Anton"];

// Keys the form around the textarea heard, as a dialog would.
const heard: string[] = [];

function Mentions(): ReactElement {
  const [text, setText] = useState("");

  const completing = useCompletion({
    find: (value, caret): Typed | undefined => {
      const typed = /(?:^|\s)@(\S*)$/.exec(value.slice(0, caret));

      return typed === null
        ? undefined
        : {
            query: typed[1] ?? "",
            from: caret - (typed[1] ?? "").length - 1,
            label: "People",
          };
    },
    options: ({ query }) =>
      names
        .filter((name) => name.toLowerCase().startsWith(query.toLowerCase()))
        .map((name) => ({ value: `@${name}`, detail: null })),
  });

  return (
    <div
      onKeyDown={(event) => {
        heard.push(event.key);
      }}
    >
      {completing.menu}
      <textarea
        aria-label="Text"
        value={text}
        {...completing.box}
        onChange={(event) => {
          setText(event.target.value);
        }}
        onKeyDown={(event) => {
          completing.keyDown(event);
        }}
      />
      <output>{text}</output>
    </div>
  );
}

// Types as React hears it under happy-dom, with the caret where a person
// left it.
function typeAt(box: HTMLTextAreaElement, text: string, caret = text.length) {
  act(() => {
    box.focus();
    Reflect.set(Object.getPrototypeOf(box) as object, "value", text, box);
    box.setSelectionRange(caret, caret);
    box.dispatchEvent(new Event("input", { bubbles: true }));
    box.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
  });
}

function press(box: HTMLTextAreaElement, key: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
  });

  act(() => {
    box.dispatchEvent(event);
    box.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true }));
  });

  return event;
}

test("lists what completes the typed word, moves with the arrows and puts the pick in the text", () => {
  const page = render(<Mentions />);
  const box = page.querySelector("textarea") ?? new HTMLTextAreaElement();

  const options = (): string[] =>
    [...page.querySelectorAll("[role=option]")].map((each) => each.textContent);

  typeAt(box, "ask @an please", 7);

  expect(page.querySelector("[role=listbox]")?.getAttribute("aria-label")).toBe(
    "People",
  );

  expect(options()).toEqual(["@Ana Souza", "@Anton"]);
  expect(box.getAttribute("aria-activedescendant")).toEndWith("-0");

  press(box, "ArrowDown");
  expect(box.getAttribute("aria-activedescendant")).toEndWith("-1");

  // Escape closes the list and goes no further, so a dialog stays open.
  const escape = press(box, "Escape");

  expect(options()).toEqual([]);
  expect(escape.defaultPrevented).toBe(true);
  expect(heard).not.toContain("Escape");

  // Typing on in that word keeps it closed; the next word opens it again.
  typeAt(box, "ask @ant please", 8);
  expect(options()).toEqual([]);

  typeAt(box, "ask please", 3);
  typeAt(box, "ask @an please", 7);
  press(box, "ArrowDown");
  press(box, "Enter");

  expect(page.querySelector("output")?.textContent).toBe("ask @Anton please");
  expect(box.selectionStart).toBe(11);
  expect(options()).toEqual([]);

  typeAt(box, "@b");
  press(box, "Tab");

  expect(page.querySelector("output")?.textContent).toBe("@Bo ");
});
