import { expect, test } from "bun:test";
import { Card, cardClass } from "./card";
import { render, withPage } from "./testing/render";

withPage();

test("a card is elevated with a border, padded unless told not to be", () => {
  const page = render(
    <>
      <Card aria-label="Padded">One</Card>
      <Card padding="none">Two</Card>
    </>,
  );

  const [padded, bare] = [...page.querySelectorAll("div")];

  expect(padded?.className).toContain(cardClass);
  expect(padded?.className).toContain("p-4");
  expect(padded?.getAttribute("aria-label")).toBe("Padded");
  expect(bare?.className).not.toContain("p-4");
});
