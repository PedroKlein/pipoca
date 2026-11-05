import { expect, test } from "bun:test";
import { Cell, Table } from "./table";
import { byRole, render, withPage } from "./testing/render";

withPage();

test("a table heads its columns and lists its rows", () => {
  const page = render(
    <Table label="People" columns={["Name", "Role"]}>
      <tr>
        <Cell>Bea</Cell>
        <Cell>Admin</Cell>
      </tr>
    </Table>,
  );

  const table = byRole(page, "table", "People");
  const heads = [...table.querySelectorAll("th")].map((th) => th.textContent);

  expect(heads).toEqual(["Name", "Role"]);
  expect(table.querySelector("tbody td")?.textContent).toBe("Bea");
});
