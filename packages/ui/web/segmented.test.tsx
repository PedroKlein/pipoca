import { expect, test } from "bun:test";
import { Segmented } from "./segmented";
import { byRole, click, render, withPage } from "./testing/render";

withPage();

test("presses the picked option and reports a new pick", () => {
  const picked: string[] = [];

  const page = render(
    <Segmented
      label="View"
      compact
      value="chat"
      options={[
        { value: "chat", label: "Chat", icon: "chat" },
        { value: "terminal", label: "Terminal", icon: "terminal" },
      ]}
      onChange={(value) => {
        picked.push(value);
      }}
    />,
  );

  const group = byRole(page, "group", "View");

  expect(byRole(group, "button", "Chat").getAttribute("aria-pressed")).toBe(
    "true",
  );

  click(byRole(group, "button", "Terminal"));

  expect(picked).toEqual(["terminal"]);
});
