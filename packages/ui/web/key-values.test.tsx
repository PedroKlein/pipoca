import { expect, test } from "bun:test";
import { act } from "react";
import { type KeyValue, KeyValues } from "./key-values";
import { byRole, click, render, type, withPage } from "./testing/render";

withPage();

function rows(given: readonly KeyValue[]): {
  readonly page: HTMLElement;
  readonly changes: (readonly KeyValue[])[];
} {
  const changes: (readonly KeyValue[])[] = [];

  const page = render(
    <KeyValues
      label="Variables"
      rows={given}
      onChange={(next) => {
        changes.push(next);
      }}
    />,
  );

  return { page, changes };
}

test("edits, locks and removes a row", () => {
  const { page, changes } = rows([{ name: "TOKEN", value: "", secret: false }]);

  type(byRole(page, "textbox", "Value of TOKEN"), "abc");
  click(byRole(page, "button", "Keep TOKEN secret"));
  click(byRole(page, "button", "Remove TOKEN"));
  click(byRole(page, "button", "Add"));

  expect(changes).toEqual([
    [{ name: "TOKEN", value: "abc", secret: false }],
    [{ name: "TOKEN", value: "", secret: true }],
    [],
    [
      { name: "TOKEN", value: "", secret: false },
      { name: "", value: "", secret: false },
    ],
  ]);
});

test("pasting a .env into a name fills a row per line", () => {
  const { page, changes } = rows([{ name: "", value: "", secret: true }]);
  const name = byRole(page, "textbox", "Name of row 1");
  const pasted = new Event("paste", { bubbles: true, cancelable: true });

  Object.assign(pasted, {
    clipboardData: {
      getData: () => '# keys\nexport A=1\nB="two"\n',
    },
  });

  act(() => {
    name.dispatchEvent(pasted);
  });

  expect(changes).toEqual([
    [
      { name: "A", value: "1", secret: true },
      { name: "B", value: "two", secret: true },
    ],
  ]);
});
