import "./dom";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeAll } from "bun:test";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";

const mounted: Root[] = [];

// Each test file calls this once: modules load once per run, so hooks in
// this module would only reach the first file, and other test files in the
// run expect the real fetch and timers.
export function withPage(): void {
  beforeAll(() => {
    if (!GlobalRegistrator.isRegistered) {
      GlobalRegistrator.register();
    }
  });

  afterEach(() => {
    act(() => {
      for (const root of mounted.splice(0)) {
        root.unmount();
      }
    });

    document.body.innerHTML = "";
  });

  afterAll(async () => {
    if (GlobalRegistrator.isRegistered) {
      await GlobalRegistrator.unregister();
    }
  });
}

export function render(element: ReactElement): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push(root);

  act(() => {
    root.render(element);
  });

  return container;
}

export function click(element: Element | null | undefined): void {
  if (!(element instanceof HTMLElement)) {
    throw new Error("Nothing to click");
  }

  act(() => {
    element.click();
  });
}

// Types into a field the way React hears it under happy-dom: React watches a
// focused field's value for changes on each key.
export function type(element: HTMLElement, text: string): void {
  if (!(
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement
  )) {
    throw new Error("Nothing to type into");
  }

  act(() => {
    element.focus();

    // Past React's own value property, so it sees the change.
    Reflect.set(
      Object.getPrototypeOf(element) as object,
      "value",
      text,
      element,
    );

    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
  });
}

export function press(element: HTMLElement, key: string): void {
  act(() => {
    element.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
  });
}

export function byRole(
  container: ParentNode,
  role: string,
  name?: string,
): HTMLElement {
  const found = [...container.querySelectorAll<HTMLElement>("*")].find(
    (element) =>
      roleOf(element) === role &&
      (name === undefined || accessibleName(element) === name),
  );

  if (found === undefined) {
    throw new Error(`No ${role}${name === undefined ? "" : ` "${name}"`}`);
  }

  return found;
}

const implicit: Record<string, string> = {
  BUTTON: "button",
  A: "link",
  NAV: "navigation",
  DIALOG: "dialog",
  TABLE: "table",
  UL: "list",
  OL: "list",
  LI: "listitem",
  TEXTAREA: "textbox",
  PRE: "code",
};

function roleOf(element: HTMLElement): string | undefined {
  const given = element.getAttribute("role");

  if (given !== null) {
    return given;
  }

  if (element instanceof HTMLInputElement) {
    return { checkbox: "checkbox", radio: "radio" }[element.type] ?? "textbox";
  }

  return implicit[element.tagName];
}

function accessibleName(element: HTMLElement): string {
  const label = element.getAttribute("aria-label");

  if (label !== null) {
    return label;
  }

  const by = element.getAttribute("aria-labelledby");

  if (by !== null) {
    return document.getElementById(by)?.textContent.trim() ?? "";
  }

  const wrapping = element.closest("label");

  if (wrapping !== null && wrapping !== element) {
    return wrapping.textContent.trim();
  }

  return element.textContent.trim();
}
