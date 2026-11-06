import type { SettingsGroup } from "@pipoca/plugins/web";
import { Icon, Page } from "@pipoca/ui";
import type { ReactElement, ReactNode } from "react";
import { PeoplePage } from "./people/people";
import { PluginBoundary } from "../plugin-boundary";
import { enabledPlugins, pluginTitle } from "../plugins";
import { href } from "../router";
import { ConfigurationPage } from "./configuration/configuration";
import { PluginsPage } from "./plugins/plugins";
import { IntegrationsPage } from "./integrations/integrations";

// A page of Settings, by its part of the address after settings/.
export interface Entry {
  readonly page: string;
  readonly label: string;
}

export function pluginPages(group: SettingsGroup): readonly Entry[] {
  return enabledPlugins().flatMap(({ name, SettingsSection, settingsGroup }) =>
    SettingsSection && (settingsGroup ?? "you") === group
      ? [{ page: name, label: pluginTitle(name) }]
      : [],
  );
}

// The pages the whole server shares, which Team setup shows too (ADR 0064).
export function serverPages(people: boolean): readonly Entry[] {
  return [
    ...(people ? [{ page: "people", label: "People" }] : []),
    ...pluginPages("server"),
    ...(pluginPages("integrations").length > 0
      ? [{ page: "integrations", label: "Integrations" }]
      : []),
    { page: "plugins", label: "Plugins" },
    { page: "configuration", label: "Configuration" },
  ];
}

// The link to a server page in Settings, or in Team setup.
export function serverPageHref(team: boolean, page: string, rest = ""): string {
  return team
    ? href("teamSetup", {
        section: "server",
        rest: rest === "" ? page : `${page}/${rest}`,
      })
    : href("settings", { page, rest });
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

// One of the server's pages, in Settings or in Team setup.
export function ServerPageView({
  page,
  rest,
  team,
}: {
  readonly page: string;
  readonly rest: string;
  readonly team: boolean;
}): ReactElement {
  switch (page) {
    case "people":
      return <PeoplePage />;
    case "plugins":
      return <PluginsPage />;
    case "configuration":
      return <ConfigurationPage />;
    case "integrations":
      return (
        <IntegrationsPage
          tab={rest}
          tabHref={(tab) => serverPageHref(team, page, tab)}
        />
      );
  }

  const Section = enabledPlugins().find(
    (plugin) => plugin.name === page,
  )?.SettingsSection;

  return (
    <Page>
      {Section && (
        <PluginBoundary name={page}>
          <Section />
        </PluginBoundary>
      )}
    </Page>
  );
}
