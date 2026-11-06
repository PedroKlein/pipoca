import { expect, test } from "bun:test";
import { act } from "react";
import { fieldClass } from "./field";
import { Select } from "./select";
import { render, withPage } from "./testing/render";

withPage();

test("draws the browser's select as a field and reports a pick", () => {
  const picked: string[] = [];

  const page = render(
    <Select
      aria-label="Role"
      className="w-32"
      value="member"
      onChange={(event) => {
        picked.push(event.target.value);
      }}
    >
      <option value="admin">Admin</option>
      <option value="member">Member</option>
    </Select>,
  );

  const select = page.querySelector("select");

  act(() => {
    if (select) {
      select.value = "admin";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });

  expect(select?.className).toContain(fieldClass);
  expect(select?.parentElement?.className).toContain("w-32");
  expect(picked).toEqual(["admin"]);
});
