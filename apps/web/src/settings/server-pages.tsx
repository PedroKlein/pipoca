import type { SettingsGroup } from "@pipoca/plugins/web";
import { Icon, Page } from "@pipoca/ui";
import type { ReactElement, ReactNode } from "react";
import { PeoplePage } from "./people/people";
import { PluginBoundary } from "../plugin-boundary";
import { enabledPlugins, pluginTitle } from "../plugins";
import { ConfigurationPage } from "./configuration/configuration";
import { PluginsPage } from "./plugins/plugins";
import { IntegrationsPage } from "./integrations/integrations";

export interface Entry {
  readonly path: string;
  readonly label: string;
}

export function pluginPages(group: SettingsGroup): readonly Entry[] {
  return enabledPlugins().flatMap(({ name, SettingsSection, settingsGroup }) =>
    SettingsSection && (settingsGroup ?? "you") === group
      ? [{ path: `settings/${name}`, label: pluginTitle(name) }]
      : [],
  );
}

export const integrationsPath = "settings/integrations";

export interface ServerPage {
  readonly key: string;
  readonly path: string;
  readonly label: string;
}

// The pages the whole server shares, which Team setup shows too (ADR 0064).
export function serverPages(people: boolean): readonly ServerPage[] {
  return [
    ...(people ? [{ key: "people", path: "people", label: "People" }] : []),
    ...pluginPages("server").map(({ path, label }) => ({
      key: path.slice("settings/".length),
      path,
      label,
    })),
    ...(pluginPages("integrations").length > 0
      ? [{ key: "integrations", path: integrationsPath, label: "Integrations" }]
      : []),
    { key: "plugins", path: "plugins", label: "Plugins" },
    {
      key: "configuration",
      path: "settings/configuration",
      label: "Configuration",
    },
  ];
}

// Says a page is the server's, the same one the other area shows.
export function SharedNote({
  children,
}: {
  readonly children: ReactNode;
}): ReactElement {
  return (
    <p
      role="note"
      className="mx-auto mt-4 flex w-full max-w-page items-center gap-2 px-4 text-caption text-fg-dim md:px-12"
    >
      <Icon name="settings" />
      <span>{children}</span>
    </p>
  );
}

// One of the server's pages, at its key, under base in the address.
export function ServerPageView({
  page,
  route,
  base,
  user,
}: {
  readonly page: ServerPage;
  readonly route: string;
  readonly base: string;
  readonly user: string;
}): ReactElement {
  switch (page.key) {
    case "people":
      return <PeoplePage user={user} />;
    case "plugins":
      return <PluginsPage />;
    case "configuration":
      return <ConfigurationPage />;
    case "integrations":
      return <IntegrationsPage route={route} base={base} />;
  }

  const Section = enabledPlugins().find(
    (plugin) => plugin.name === page.key,
  )?.SettingsSection;

  return (
    <Page>
      {Section && (
        <PluginBoundary name={page.key}>
          <Section />
        </PluginBoundary>
      )}
    </Page>
  );
}
