import { Page, PageTitle, Tabs } from "@pipoca/ui";
import type { ReactElement } from "react";
import { PluginBoundary } from "../../plugin-boundary";
import { enabledPlugins, pluginTitle } from "../../plugins";

// Plugins that bring work in from outside, such as Slack and Email, share
// one page with a tab each (ADR 0063).
export function IntegrationsPage({
  route,
  base,
}: {
  readonly route: string;
  readonly base: string;
}): ReactElement {
  const tabs = enabledPlugins().filter(
    ({ SettingsSection, settingsGroup }) =>
      SettingsSection !== undefined && settingsGroup === "integrations",
  );

  const chosen = route.slice(base.length + 1);
  const open = tabs.find(({ name }) => name === chosen) ?? tabs[0];
  const Section = open?.SettingsSection;

  return (
    <Page>
      <PageTitle description="Services that start work from outside Pipoca and that Sessions can answer through.">
        Integrations
      </PageTitle>
      <Tabs
        label="Integrations"
        className="mb-2"
        value={open?.name}
        tabs={tabs.map(({ name }) => ({
          value: name,
          label: pluginTitle(name),
          href: `#${base}/${name}`,
        }))}
      />
      {open && Section && (
        <PluginBoundary name={open.name}>
          <Section />
        </PluginBoundary>
      )}
    </Page>
  );
}
