import { expect, test } from "bun:test";
import { ListInput } from "./list-input";
import { byRole, click, press, render, type, withPage } from "./testing/render";

withPage();

function list(values: readonly string[]): {
  readonly page: HTMLElement;
  readonly changes: (readonly string[])[];
} {
  const changes: (readonly string[])[] = [];

  const page = render(
    <ListInput
      label="Folders"
      values={values}
      onChange={(next) => {
        changes.push(next);
      }}
    />,
  );

  return { page, changes };
}

test("Enter adds a new value once", () => {
  const { page, changes } = list(["/srv"]);
  const box = byRole(page, "textbox", "Add to Folders");

  type(box, " /home ");
  press(box, "Enter");
  type(box, "/srv");
  press(box, "Enter");

  expect(changes).toEqual([["/srv", "/home"]]);
});

test("a value's x removes it", () => {
  const { page, changes } = list(["/srv", "/home"]);

  click(byRole(page, "button", "Remove /srv"));

  expect(changes).toEqual([["/home"]]);
});
