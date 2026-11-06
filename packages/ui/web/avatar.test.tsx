import { expect, test } from "bun:test";
import { Avatar } from "./avatar";
import { render, withPage } from "./testing/render";

withPage();

test("shows a name's initials, round for a person and square for a logo", () => {
  const page = render(
    <>
      <Avatar name="Maria Silva" />
      <Avatar name="GitHub" square />
    </>,
  );

  const [person, logo] = [...page.querySelectorAll("span")];

  expect(person?.textContent).toBe("Ms");
  expect(person?.className).toContain("rounded-full");
  expect(logo?.textContent).toBe("Gh");
  expect(logo?.className).toContain("rounded-md");
});
