import { expect, test } from "bun:test";
import { Row, Rows } from "./rows";
import { byRole, render, withPage } from "./testing/render";

withPage();

test("rows list items with a title, a description and their controls", () => {
  const page = render(
    <Rows label="Hosts">
      <Row title="GitHub" description="Signed in" initials="Gh">
        <button type="button">Remove</button>
      </Row>
    </Rows>,
  );

  const list = byRole(page, "list", "Hosts");
  const item = byRole(list, "listitem");

  expect(item.textContent).toContain("Signed in");
  expect(item.querySelector("[aria-hidden]")?.textContent).toBe("Gh");
  expect(byRole(item, "button", "Remove")).toBeDefined();
});
