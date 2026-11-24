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

test("a button drawn with its own content is still named by the label", () => {
  const page = render(
    <Menu
      label="Account"
      side="above"
      align="stretch"
      trigger={<span>pedro</span>}
      items={[{ label: "Settings", run: () => undefined }]}
    />,
  );

  click(byRole(page, "button", "Account"));

  expect(
    byRole(byRole(page, "menu", "Account"), "menuitem", "Settings"),
  ).toBeDefined();
});

test("Escape closes it, and not the dialog it sits in", () => {
  const page = render(
    <Menu label="More" items={[{ label: "Copy", run: () => undefined }]} />,
  );

  click(byRole(page, "button", "More"));

  const escape = new KeyboardEvent("keydown", {
    key: "Escape",
    cancelable: true,
  });

  act(() => {
    document.dispatchEvent(escape);
  });

  expect(page.querySelector('[role="menu"]')).toBeNull();
  expect(escape.defaultPrevented).toBe(true);
});

test("a heading says what the list holds, and a badge marks an item", () => {
  const page = render(
    <Menu
      label="Versions"
      heading="Versions · every publish is kept"
      items={[
        { label: "Version 2", badge: "latest", checked: true, run: () => 0 },
        { label: "Version 1", checked: false, run: () => 0 },
      ]}
    />,
  );

  click(byRole(page, "button", "Versions"));

  const menu = byRole(page, "menu", "Versions");

  expect(menu.textContent).toStartWith("Versions · every publish is kept");
  expect(byRole(menu, "menuitemradio", "Version 2 latest")).toBeDefined();
});

test("shows an item that can't be picked without running it", () => {
  const ran: string[] = [];

  const page = render(
    <Menu
      label="Export"
      items={[
        { label: "PDF", run: () => ran.push("pdf") },
        {
          label: "PowerPoint (not planned)",
          disabled: true,
          run: () => ran.push("pptx"),
        },
      ]}
    />,
  );

  click(byRole(page, "button", "Export"));

  const item = byRole(page, "menuitem", "PowerPoint (not planned)");

  expect(item.getAttribute("aria-disabled")).toBe("true");

  click(item);

  expect(ran).toEqual([]);
  expect(page.querySelector('[role="menu"]')).not.toBeNull();
});
