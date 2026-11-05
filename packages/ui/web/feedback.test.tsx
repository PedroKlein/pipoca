import { expect, test } from "bun:test";
import { EmptyState, ErrorText, Notice, Spinner } from "./feedback";
import { byRole, render, withPage } from "./testing/render";

withPage();

test("an error line shows only when there is an error", () => {
  const page = render(
    <>
      <ErrorText>{undefined}</ErrorText>
      <ErrorText>{""}</ErrorText>
      <ErrorText>The name is taken</ErrorText>
    </>,
  );

  expect(page.querySelectorAll('[role="alert"]').length).toBe(1);
  expect(byRole(page, "alert").textContent).toBe("The name is taken");
});

test("a failed notice is an alert, and others are notes", () => {
  const page = render(
    <>
      <Notice tone="failed" title="The runner failed" />
      <Notice action={<button type="button">Open</button>}>A tip</Notice>
    </>,
  );

  expect(byRole(page, "alert").textContent).toBe("The runner failed");
  expect(byRole(page, "note").textContent).toContain("A tip");
  expect(byRole(page, "button", "Open")).toBeDefined();
});

test("an empty state says what goes there, and a spinner says what loads", () => {
  const page = render(
    <>
      <EmptyState action={<button type="button">Add</button>}>
        No hosts yet.
      </EmptyState>
      <Spinner label="Loading…" />
    </>,
  );

  expect(page.textContent).toContain("No hosts yet.");
  expect(byRole(page, "status").textContent).toBe("Loading…");
});
