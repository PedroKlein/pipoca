import { expect, test } from "bun:test";
import { Button, buttonClass } from "./button";
import { byRole, click, render, withPage } from "./testing/render";

withPage();

test("a button is not a submit button unless asked, and runs its click", () => {
  let clicks = 0;

  const page = render(
    <Button
      size="sm"
      onClick={() => {
        clicks += 1;
      }}
    >
      Save
    </Button>,
  );

  const button = byRole(page, "button", "Save");
  click(button);

  expect(clicks).toBe(1);
  expect(button.getAttribute("type")).toBe("button");
  expect(button.className).toContain("h-7");
});

test("a link button draws as underlined text", () => {
  expect(buttonClass({ variant: "link" })).toContain("underline");
  expect(buttonClass({ variant: "link" })).not.toContain("border");
});

test("an extra small icon button is a square mark beside text", () => {
  const classes = buttonClass({ size: "xs", iconOnly: true }).split(" ");

  expect(classes).toContain("h-6");
  expect(classes).toContain("w-6");
});
