import { expect, test } from "bun:test";
import { Hero, SetupShell } from "./setup-shell";
import { byRole, render, withPage } from "./testing/render";

withPage();

test("shows the wordmark, the steps so far and the current step", () => {
  const page = render(
    <SetupShell steps={{ total: 4, at: 1 }} aside="Step 2 of 4">
      <Hero title="Where should Pi work?">Pick a machine.</Hero>
    </SetupShell>,
  );

  const steps = [...byRole(page, "list", "Setup steps").children];

  expect(page.textContent).toContain("pipoca");
  expect(page.textContent).toContain("Step 2 of 4");

  expect(steps.map((step) => step.getAttribute("aria-current"))).toEqual([
    null,
    "step",
    null,
    null,
  ]);

  expect(page.querySelector("h1")?.textContent).toBe("Where should Pi work?");
});

test("says which setup it is beside the wordmark", () => {
  const page = render(
    <SetupShell label={<span>Server setup</span>}>
      <Hero title="Who is this Pipoca for?" />
    </SetupShell>,
  );

  expect(page.querySelector("header")?.textContent).toBe("pipocaServer setup");
});
