import { expect, test } from "bun:test";
import { Step, Stepper } from "./stepper";
import { byRole, render, withPage } from "./testing/render";

withPage();

test("numbers steps, checks the done ones and marks the current one", () => {
  const page = render(
    <Stepper label="Set up Connect">
      <Step number={1} state="done" title="Open the page" />
      <Step number={2} state="current" title="Paste the ID">
        <input aria-label="Client ID" />
      </Step>
      <Step number={3} state="next" title="Try it" />
    </Stepper>,
  );

  const steps = [...byRole(page, "list", "Set up Connect").children];

  expect(steps[0]?.querySelector("svg")).not.toBeNull();
  expect(steps[1]?.getAttribute("aria-current")).toBe("step");
  expect(steps[1]?.querySelector("input")).not.toBeNull();
  expect(steps[2]?.textContent).toBe("3Try it");
});
