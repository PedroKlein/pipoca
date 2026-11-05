import { expect, test } from "bun:test";
import { StatusMark } from "./status-mark";
import { byRole, render, withPage } from "./testing/render";

withPage();

test("names each status for screen readers", () => {
  const page = render(
    <>
      <StatusMark status="running" />
      <StatusMark status="done" />
      <StatusMark status="pending" label="Waiting" />
    </>,
  );

  expect(byRole(page, "img", "Running")).toBeDefined();
  expect(byRole(page, "img", "Done").querySelector("svg")).not.toBeNull();
  expect(byRole(page, "img", "Waiting")).toBeDefined();
});

test("an empty label hides the mark", () => {
  const page = render(<StatusMark status="failed" label="" />);

  expect(page.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
});
