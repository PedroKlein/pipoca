import { expect, test } from "bun:test";
import { fieldClass } from "./field";
import { Checkbox, Radio, TextArea, TextInput } from "./inputs";
import { byRole, click, render, withPage } from "./testing/render";

withPage();

test("text fields share the field look and keep their attributes", () => {
  const page = render(
    <>
      <TextInput aria-label="Name" name="name" required />
      <TextArea aria-label="Notes" className="font-mono" />
    </>,
  );

  const name = byRole(page, "textbox", "Name");
  const notes = byRole(page, "textbox", "Notes");

  expect(name.className).toBe(fieldClass);
  expect(name.getAttribute("name")).toBe("name");
  expect(notes.className).toContain("font-mono");
});

test("a checkbox and a radio are named by their label", () => {
  let checked = false;

  const page = render(
    <>
      <Checkbox
        label="Remove the secret"
        onChange={(event) => {
          checked = event.target.checked;
        }}
      />
      <Radio label="Member" name="role" description="Can start Sessions" />
    </>,
  );

  click(byRole(page, "checkbox"));

  expect(checked).toBe(true);

  expect(byRole(page, "radio").closest("label")?.textContent).toContain(
    "Can start Sessions",
  );
});
