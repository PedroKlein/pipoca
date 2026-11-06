import { expect, test } from "bun:test";
import { Page, Section } from "./page";
import { byRole, render, withPage } from "./testing/render";

withPage();

test("a page has its title, description, actions and sections", () => {
  const page = render(
    <Page
      id="people-page"
      title="People"
      description="Who can use this server."
      actions={<button type="button">Invite</button>}
    >
      <Section title="Members">
        <p>Bea</p>
      </Section>
    </Page>,
  );

  expect(page.querySelector("#people-page h1")?.textContent).toBe("People");
  expect(page.textContent).toContain("Who can use this server.");
  expect(byRole(page, "button", "Invite")).toBeDefined();
  expect(page.querySelector("h2")?.textContent).toBe("Members");
});

test("a page inside another draws its title in the outer column", () => {
  const page = render(
    <Page id="outer">
      <Page
        id="inner"
        title="Push"
        actions={<button type="button">Add</button>}
      >
        <p>Devices</p>
      </Page>
    </Page>,
  );

  const inner = page.querySelector("#inner");

  expect(page.querySelector("#outer")?.className).toContain("max-w-page");
  expect(inner?.className).not.toContain("max-w-page");
  expect(inner?.querySelector("h1")?.textContent).toBe("Push");
  expect(byRole(page, "button", "Add")).toBeDefined();
});
