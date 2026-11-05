import { expect, test } from "bun:test";
import { Tabs } from "./tabs";
import { byRole, click, render, withPage } from "./testing/render";

withPage();

test("link tabs mark the current page", () => {
  const page = render(
    <Tabs
      label="Profile"
      value="skills"
      tabs={[
        { value: "overview", label: "Overview", href: "#p/overview" },
        { value: "skills", label: "Skills", href: "#p/skills" },
      ]}
    />,
  );

  const nav = byRole(page, "navigation", "Profile");

  expect(byRole(nav, "link", "Skills").getAttribute("aria-current")).toBe(
    "page",
  );

  expect(byRole(nav, "link", "Overview").hasAttribute("aria-current")).toBe(
    false,
  );
});

test("other tabs select their panel", () => {
  const picked: string[] = [];

  const page = render(
    <Tabs
      label="People"
      value="members"
      tabs={[
        { value: "members", label: "Members" },
        { value: "invites", label: "Invites" },
      ]}
      onSelect={(value) => {
        picked.push(value);
      }}
    />,
  );

  const list = byRole(page, "tablist", "People");

  expect(byRole(list, "tab", "Members").getAttribute("aria-selected")).toBe(
    "true",
  );

  click(byRole(list, "tab", "Invites"));

  expect(picked).toEqual(["invites"]);
});
