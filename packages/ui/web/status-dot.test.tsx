import { expect, test } from "bun:test";
import { StatusDot } from "./status-dot";
import { byRole, render, withPage } from "./testing/render";

withPage();

test("a dot takes its tone's colour and stays hidden without a label", () => {
  const page = render(<StatusDot tone="waiting" />);
  const dot = page.querySelector("span");

  expect(dot?.className).toContain("bg-waiting");
  expect(dot?.getAttribute("aria-hidden")).toBe("true");
});

test("an offline dot is an outline, and a labelled one is named", () => {
  const page = render(<StatusDot tone="offline" label="Offline" />);

  expect(byRole(page, "img", "Offline").className).toContain("border");
});

test("a dot without a tone is a quiet placeholder", () => {
  const page = render(<StatusDot />);

  expect(page.querySelector("span")?.className).toContain("bg-line");
});
