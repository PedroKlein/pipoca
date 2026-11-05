import type { SettingsGroup } from "@pipoca/plugins/web";
import type { Environment, Profile } from "@pipoca/protocol";
import { AreaLayout, Avatar, cn, Icon, linkCardClass, PageTitle, Tabs } from "@pipoca/ui";
import type { ReactElement, ReactNode } from "react";
import { AccountsPage } from "./accounts";
import { EnvironmentsPage } from "./environments";
import { GeneralPage } from "./general";
import { settingsPageClass } from "./page-class";
import { PeoplePage } from "./people";
import { PluginBoundary } from "./plugin-boundary";
import { enabledPlugins, pluginContext, pluginTitle } from "./plugins";
import { ConfigurationPage } from "./configuration";
import { PluginsPage } from "./plugins-page";
import { ProfilesPage } from "./profiles";
import { SettingsPage } from "./settings";

interface Entry {
  readonly path: string;
  readonly label: string;
}

interface Group {
  readonly label: string;
  readonly entries: readonly Entry[];
}

function pluginPages(group: SettingsGroup): readonly Entry[] {
  return enabledPlugins().flatMap(({ name, SettingsSection, settingsGroup }) =>
    SettingsSection && (settingsGroup ?? "you") === group
      ? [{ path: `settings/${name}`, label: pluginTitle(name) }]
      : [],
  );
}

const integrationsPath = "settings/integrations";

// Settings is grouped by who it is for, and only admins see the server's
// pages (ADR 0063).
function groups(admin: boolean, people: boolean): readonly Group[] {
  return [
    {
      label: "You",
      entries: [
        { path: "settings/general", label: "General" },
        { path: "settings/accounts", label: "Accounts" },
        ...pluginPages("you"),
        { path: "settings/tokens", label: "Access tokens" },
      ],
    },
    {
      label: "Workspace",
      entries: [
        { path: "environments", label: "Environments" },
        { path: "profiles", label: "Profiles" },
        ...pluginPages("workspace"),
      ],
    },
    ...(admin
      ? [
          {
            label: "Server, for admins",
            entries: serverPages(people).map(({ path, label }) => ({
              path,
              label,
            })),
          },
        ]
      : []),
  ];
}

function opens(route: string, path: string): boolean {
  return (
    route === path ||
    route.startsWith(`${path}/`) ||
    (route === "settings" && path === "settings/general")
  );
}

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
      className="mx-auto mt-4 flex w-full max-w-chat items-center gap-2 px-4 text-caption text-fg-dim md:px-12"
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
    <div className={settingsPageClass}>
      {Section && (
        <PluginBoundary name={page.key}>
          <Section context={pluginContext(page.key)} />
        </PluginBoundary>
      )}
    </div>
  );
}

export function isSettingsRoute(route: string): boolean {
  return /^(environments|profiles|plugins|people|settings)(\/|$)/.test(route);
}

export function SettingsLayout({
  route,
  user,
  admin,
  people,
  team,
  environments,
  profiles,
  onEnvironmentsChange,
  onProfilesChange,
}: {
  readonly route: string;
  readonly user: string;
  readonly admin: boolean;
  readonly people: boolean;
  readonly team: boolean;
  readonly environments: readonly Environment[];
  readonly profiles: readonly Profile[];
  readonly onEnvironmentsChange: () => void;
  readonly onProfilesChange: () => void;
}): ReactElement {
  const menu = groups(admin, people);

  const shared = admin
    ? serverPages(people).find(({ path }) => opens(route, path))
    : undefined;

  const page = (): ReactNode => {
    const profilesRoute = /^profiles\/?(.*)$/.exec(route);
    if (profilesRoute) {
      return (
        <ProfilesPage
          profiles={profiles}
          admin={admin}
          selected={profilesRoute[1] ?? ""}
          onChange={onProfilesChange}
        />
      );
    }

    const environmentsRoute = /^environments\/?(.*)$/.exec(route);
    if (environmentsRoute) {
      return (
        <EnvironmentsPage
          environments={environments}
          selected={environmentsRoute[1] ?? ""}
          onChange={onEnvironmentsChange}
        />
      );
    }

    if (route === "plugins") {
      return <PluginsPage />;
    }

    if (route === "people" && people) {
      return <PeoplePage user={user} />;
    }

    if (route === "settings/accounts") {
      return <AccountsPage />;
    }

    if (route === "settings/configuration" && admin) {
      return <ConfigurationPage />;
    }

    if (route === "settings/tokens") {
      return <SettingsPage />;
    }

    if (opens(route, integrationsPath)) {
      return <IntegrationsPage route={route} base={integrationsPath} />;
    }

    const name = /^settings\/(.+)$/.exec(route)?.[1];

    const Section = enabledPlugins().find(
      (plugin) => plugin.name === name,
    )?.SettingsSection;

    if (name !== undefined && Section) {
      return (
        <div className={settingsPageClass}>
          <PluginBoundary name={name}>
            <Section context={pluginContext(name)} />
          </PluginBoundary>
        </div>
      );
    }

    return <GeneralPage user={user} admin={admin} />;
  };

  return (
    <AreaLayout
      label="Settings"
      back={{ href: "#", label: "Back to Pipoca" }}
      heading="Settings"
      groups={menu.map((group) => ({
        label: group.label,
        items: group.entries.map(({ path, label }) => ({
          href: `#${path}`,
          label,
          current: opens(route, path),
        })),
      }))}
      phone="menu"
      menuOpen={route === "settings"}
      menuHref="#settings"
      menuTop={
        <a
          href="#settings/general"
          className={cn(
            "mt-1 flex items-center gap-3 p-3.5",
            linkCardClass,
          )}
        >
          <Avatar name={user} size="lg" className="size-10 text-ui">
            {user.slice(0, 1).toUpperCase()}
          </Avatar>
          <span className="flex-1 text-ui font-medium text-fg-strong">
            {user}
          </span>
          <Icon name="chevron-right" className="text-fg-dim" />
        </a>
      }
    >
      {team && shared !== undefined && (
        <SharedNote>
          Server-wide, for personal and team work alike. Team setup shows this
          same page:{" "}
          <a
            href={`#team/setup/server/${shared.key}`}
            className="text-fg underline"
          >
            open it there
          </a>
          .
        </SharedNote>
      )}
      {page()}
    </AreaLayout>
  );
}

// Plugins that start routines from outside, such as Slack and Email, share
// one page with a tab each (ADR 0063).
function IntegrationsPage({
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
    <div className={settingsPageClass}>
      <PageTitle description="Services that start your routines from outside Pipoca and that Sessions can answer through.">
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
          <Section context={pluginContext(open.name)} />
        </PluginBoundary>
      )}
    </div>
  );
}
