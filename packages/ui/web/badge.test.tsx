import { expect, test } from "bun:test";
import { Badge } from "./badge";
import { render, withPage } from "./testing/render";

withPage();

test("a state badge has a dot and a plain one has none", () => {
  const page = render(
    <>
      <Badge state="failed">Failed</Badge>
      <Badge>Admin</Badge>
    </>,
  );

  const [state, plain] = [...page.querySelectorAll("span")];

  expect(state?.textContent).toBe("Failed");
  expect(state?.className).toContain("text-failed");
  expect(state?.className).toContain("before:size-1.5");
  expect(plain?.textContent).toBe("Admin");
  expect(plain?.className).not.toContain("before:");
});
