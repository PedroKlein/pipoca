import { Page, PageTitle, Tabs } from "@pipoca/ui";
import type { ReactElement } from "react";
import { PluginBoundary } from "../../plugin-boundary";
import { enabledPlugins, pluginContext, pluginTitle } from "../../plugins";

// Plugins that bring work in from outside, such as Slack and Email, share
// one page with a tab each (ADR 0063).
export function IntegrationsPage({
  tab,
  tabHref,
}: {
  readonly tab: string;
  readonly tabHref: (tab: string) => string;
}): ReactElement {
  const tabs = enabledPlugins().filter(
    ({ SettingsSection, settingsGroup }) =>
      SettingsSection !== undefined && settingsGroup === "integrations",
  );


  const open = tabs.find(({ name }) => name === tab) ?? tabs[0];
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
          href: tabHref(name),
        }))}
      />
      {open && Section && (
        <PluginBoundary name={open.name}>
          <Section context={pluginContext(open.name)} />
        </PluginBoundary>
      )}
    </Page>
  );
}
