import { expect, test } from "bun:test";
import { Icon, isIconName } from "./icon";
import { render, withPage } from "./testing/render";

withPage();

test("draws a hidden 16px icon by default", () => {
  const page = render(<Icon name="check" className="text-done" />);
  const svg = page.querySelector("svg");

  expect(svg?.getAttribute("aria-hidden")).toBe("true");
  expect(svg?.getAttribute("class")).toContain("size-4");
  expect(svg?.getAttribute("class")).toContain("text-done");
  expect(svg?.querySelectorAll("path").length).toBeGreaterThan(0);
});

test("a name from data may name no icon", () => {
  expect(isIconName("check")).toBe(true);
  expect(isIconName("toString")).toBe(false);
  expect(isIconName("no-such-icon")).toBe(false);
});
