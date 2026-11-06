import { expect, test } from "bun:test";
import { act } from "react";
import { Code, Command } from "./code";
import { byRole, click, render, withPage } from "./testing/render";

withPage();

test("a command shows its text alone and copies it", async () => {
  const copied: string[] = [];

  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        copied.push(text);
        await Promise.resolve();
      },
    },
  });

  const page = render(
    <>
      <Command label="Join command">pipoca agent</Command>
      <Code label="Output">done</Code>
    </>,
  );

  expect(page.querySelector('[aria-label="Join command"]')?.textContent).toBe(
    "pipoca agent",
  );

  click(byRole(page, "button", "Copy"));
  await act(async () => Promise.resolve());

  expect(copied).toEqual(["pipoca agent"]);
  expect(byRole(page, "button", "Copied")).toBeDefined();
  expect(byRole(page, "code", "Output").textContent).toBe("done");
});
