import { expect, test } from "bun:test";
import { act } from "react";
import { Menu } from "./menu";
import { byRole, click, render, withPage } from "./testing/render";

withPage();

test("opens its actions, runs one and closes", () => {
  const ran: string[] = [];

  const page = render(
    <Menu
      label="Session actions"
      items={[
        { label: "Rename", run: () => ran.push("rename") },
        { label: "Done", checked: true, run: () => ran.push("done") },
        {
          label: "Archive",
          danger: true,
          divided: true,
          run: () => ran.push("archive"),
        },
      ]}
    />,
  );

  click(byRole(page, "button", "Session actions"));

  const menu = byRole(page, "menu", "Session actions");

  expect(
    byRole(menu, "menuitemradio", "Done").getAttribute("aria-checked"),
  ).toBe("true");

  click(byRole(menu, "menuitem", "Archive"));

  expect(ran).toEqual(["archive"]);
  expect(page.querySelector('[role="menu"]')).toBeNull();
});

test("Escape closes it", () => {
  const page = render(
    <Menu label="More" items={[{ label: "Copy", run: () => undefined }]} />,
  );

  click(byRole(page, "button", "More"));

  act(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  });

  expect(page.querySelector('[role="menu"]')).toBeNull();
});
