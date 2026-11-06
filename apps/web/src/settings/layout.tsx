import type { Environment, Profile } from "@pipoca/protocol";
import { AreaLayout, Avatar, cn, Icon, linkCardClass, Page } from "@pipoca/ui";
import type { ReactElement, ReactNode } from "react";
import { AccountsPage } from "./accounts/accounts";
import { EnvironmentsPage } from "./environments/environments";
import { GeneralPage } from "./general/general";
import { PeoplePage } from "./people/people";
import { PluginBoundary } from "../plugin-boundary";
import { enabledPlugins } from "../plugins";
import { ConfigurationPage } from "./configuration/configuration";
import { PluginsPage } from "./plugins/plugins";
import { ProfilesPage } from "./profiles/profiles";
import { TokensPage } from "./tokens/tokens";
import {
  type Entry,
  pluginPages,
  integrationsPath,
  serverPages,
  SharedNote,
} from "./server-pages";
import { IntegrationsPage } from "./integrations/integrations";

interface Group {
  readonly label: string;
  readonly entries: readonly Entry[];
}

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
      return <TokensPage />;
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
        <Page>
          <PluginBoundary name={name}>
            <Section />
          </PluginBoundary>
        </Page>
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
          className={cn("mt-1 flex items-center gap-3 p-3.5", linkCardClass)}
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
