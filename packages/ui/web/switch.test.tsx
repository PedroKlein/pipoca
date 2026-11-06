import { expect, test } from "bun:test";
import { Switch } from "./switch";
import { byRole, click, render, withPage } from "./testing/render";

withPage();

test("reports the flipped value and shows its own state", () => {
  const flipped: boolean[] = [];

  const page = render(
    <Switch
      label="On"
      checked={false}
      onChange={(checked) => {
        flipped.push(checked);
      }}
    />,
  );

  const toggle = byRole(page, "switch");
  click(toggle);

  expect(toggle.getAttribute("aria-checked")).toBe("false");
  expect(flipped).toEqual([true]);
});

test("a hidden label still names it, and a disabled one can't flip", () => {
  let flips = 0;

  const page = render(
    <Switch
      label="Turn on Slack"
      labelHidden
      checked
      disabled
      onChange={() => {
        flips += 1;
      }}
    />,
  );

  click(byRole(page, "switch"));

  expect(page.querySelector(".sr-only")?.textContent).toBe("Turn on Slack");
  expect(flips).toBe(0);
});
