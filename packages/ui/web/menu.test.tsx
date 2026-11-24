import { expect, spyOn, test } from "bun:test";
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

test("an open menu shifts to stay 16px inside the screen, and again as the screen changes", () => {
  let place = { at: 0, left: -40, width: 320 };
  const screen = 1000;

  const measure = (
    name: "offsetLeft" | "offsetWidth" | "clientWidth",
    of: (element: HTMLElement) => number,
  ): (() => void) => {
    const was =
      Object.getOwnPropertyDescriptor(HTMLElement.prototype, name) ??
      Object.getOwnPropertyDescriptor(Element.prototype, name);

    Object.defineProperty(HTMLElement.prototype, name, {
      configurable: true,
      get(this: HTMLElement) {
        return of(this);
      },
    });

    return () => {
      if (was === undefined) {
        Reflect.deleteProperty(HTMLElement.prototype, name);
      } else {
        Object.defineProperty(HTMLElement.prototype, name, was);
      }
    };
  };

  const menuOnly =
    (of: () => number) =>
    (element: HTMLElement): number =>
      element.getAttribute("role") === "menu" ? of() : 0;

  const boxed = spyOn(
    HTMLElement.prototype,
    "getBoundingClientRect",
  ).mockImplementation(() => new DOMRect(place.at, 0, 0, 0));

  const restore = [
    measure(
      "offsetLeft",
      menuOnly(() => place.left),
    ),
    measure(
      "offsetWidth",
      menuOnly(() => place.width),
    ),
    measure("clientWidth", (element) =>
      element === document.documentElement ? screen : 0,
    ),
  ];

  try {
    const page = render(
      <Menu label="Design system" items={[{ label: "Open", run: () => 0 }]} />,
    );

    const button = byRole(page, "button", "Design system");
    const menu = (): HTMLElement => byRole(page, "menu", "Design system");

    click(button);
    expect(menu().style.translate).toBe("56px 0");

    click(button);
    place = { at: screen - 100, left: 0, width: 300 };
    click(button);
    expect(menu().style.translate).toBe("-216px 0");

    place = { at: 100, left: 0, width: 200 };

    act(() => {
      dispatchEvent(new Event("resize"));
    });

    expect(menu().style.translate).toBe("");
  } finally {
    boxed.mockRestore();

    for (const each of restore) {
      each();
    }
  }
});
