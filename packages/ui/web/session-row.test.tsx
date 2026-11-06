import { expect, test } from "bun:test";
import { SessionRow } from "./session-row";
import { byRole, render, withPage } from "./testing/render";

withPage();

test("links to the Session with its badge, detail and actions", () => {
  const page = render(
    <ul>
      <SessionRow
        id="s1"
        href="#s1"
        title="Fix the login"
        meta="laptop · 5m ago"
        current
        badge={{ state: "waiting", label: "Needs you" }}
        actions={<button type="button">More</button>}
      />
    </ul>,
  );

  const link = byRole(page, "link");

  expect(link.getAttribute("href")).toBe("#s1");
  expect(link.getAttribute("aria-current")).toBe("page");
  expect(link.textContent).toBe("Fix the loginNeeds youlaptop · 5m ago");
  expect(page.querySelector("li")?.dataset["id"]).toBe("s1");
  expect(byRole(page, "button", "More")).toBeDefined();
});
