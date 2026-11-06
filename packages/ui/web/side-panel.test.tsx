import { expect, test } from "bun:test";
import { type ReactElement, useState } from "react";
import { SidePanel } from "./side-panel";
import { byRole, click, press, render, withPage } from "./testing/render";

withPage();

function Opened(): ReactElement {
  const [open, setOpen] = useState(true);

  return (
    <SidePanel
      open={open}
      title="Changes"
      closeLabel="Close changes"
      onClose={() => {
        setOpen(false);
      }}
    >
      <p>Two files</p>
    </SidePanel>
  );
}

test("a side panel is named by its title and closes from its button", () => {
  const page = render(<Opened />);
  const panel = byRole(page, "dialog", "Changes");

  expect(panel.hidden).toBe(false);
  expect(panel.querySelector("h2")?.textContent).toBe("Changes");
  expect(panel.textContent).toContain("Two files");

  click(byRole(panel, "button", "Close changes"));

  expect(panel.hidden).toBe(true);
});

test("Escape closes an open side panel", () => {
  const page = render(<Opened />);
  const panel = byRole(page, "dialog", "Changes");

  press(document.body, "Escape");

  expect(panel.hidden).toBe(true);
});
