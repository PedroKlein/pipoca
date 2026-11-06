import { expect, test } from "bun:test";
import { Chip } from "./chip";
import { byRole, click, render, withPage } from "./testing/render";

withPage();

test("shows its value with no button unless it can be removed", () => {
  const page = render(<Chip mono>/home/bea/code</Chip>);

  expect(page.textContent).toBe("/home/bea/code");
  expect(page.querySelector("button")).toBeNull();
});

test("its remove button is named and reports a press", () => {
  let removed = 0;

  const page = render(
    <Chip
      removeLabel="Remove bea@example.com"
      onRemove={() => {
        removed += 1;
      }}
    >
      bea@example.com
    </Chip>,
  );

  click(byRole(page, "button", "Remove bea@example.com"));

  expect(removed).toBe(1);
});
