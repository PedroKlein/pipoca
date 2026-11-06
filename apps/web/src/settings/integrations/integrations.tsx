import { Page, Tabs } from "@pipoca/ui";
import type { ReactElement } from "react";
import { PluginBoundary } from "../../plugin-boundary";
import { enabledPlugins, PluginSettings, pluginTitle } from "../../plugins";

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
    ({ settings }) => settings?.group === "integrations",
  );

  const open = tabs.find(({ plugin }) => plugin.id === tab) ?? tabs[0];

  return (
    <Page
      title="Integrations"
      description="Services that start work from outside Pipoca and that Sessions can answer through."
    >
      <Tabs
        label="Integrations"
        className="mb-2"
        value={open?.plugin.id}
        tabs={tabs.map(({ plugin: { id } }) => ({
          value: id,
          label: pluginTitle(id),
          href: tabHref(id),
        }))}
      />
      {open && (
        <PluginBoundary name={open.plugin.id}>
          <PluginSettings key={open.plugin.id} part={open} />
        </PluginBoundary>
      )}
    </Page>
  );
}
