import { expect, test } from "bun:test";
import { AreaLayout } from "./area-layout";
import { byRole, render, withPage } from "./testing/render";

withPage();

test("a side nav with groups marks the current page beside the page", () => {
  const page = render(
    <AreaLayout
      label="Settings"
      back={{ href: "#", label: "Back to Pipoca" }}
      heading="Settings"
      phone="menu"
      menuOpen
      groups={[
        {
          label: "You",
          items: [
            { href: "#settings/general", label: "General", current: true },
            { href: "#settings/accounts", label: "Accounts" },
          ],
        },
        { label: "Empty", items: [] },
      ]}
    >
      <p>General page</p>
    </AreaLayout>,
  );

  const nav = byRole(page, "navigation", "Settings");

  expect(byRole(nav, "link", "General").getAttribute("aria-current")).toBe(
    "page",
  );

  expect(nav.textContent).not.toContain("Empty");
  expect(page.textContent).toContain("General page");
  // The phone menu lists the same pages.
  expect(page.querySelectorAll('a[href="#settings/accounts"]').length).toBe(2);
});

test("a phone menu can group the pages its own way, with hints and chips", () => {
  const page = render(
    <AreaLayout
      label="Settings"
      back={{ href: "#", label: "Back to Pipoca" }}
      heading="Settings"
      phone="menu"
      menuOpen
      groups={[
        {
          items: [
            { href: "#settings/plugins", label: "Plugins" },
            { href: "#settings/configuration", label: "Configuration" },
          ],
        },
      ]}
      menuGroups={[
        {
          items: [
            {
              href: "#settings/more",
              label: "More",
              hint: "Plugins, Configuration",
              status: <span>On</span>,
            },
          ],
        },
      ]}
    >
      <p>Page</p>
    </AreaLayout>,
  );

  expect(page.querySelectorAll('a[href="#settings/plugins"]').length).toBe(1);

  expect(page.querySelector('a[href="#settings/more"]')?.textContent).toBe(
    "MorePlugins, ConfigurationOn",
  );
});
