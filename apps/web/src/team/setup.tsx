import { AreaLayout, Page } from "@pipoca/ui";
import type { ReactElement, ReactNode } from "react";
import { EnvironmentsPage } from "../settings/environments/environments";
import { useTeamEnvironments, useTeamProfiles } from "../hooks";
import { PluginBoundary } from "../plugin-boundary";
import { enabledPlugins, type SetupScreen } from "../plugins";
import { ProfilesPage } from "../settings/profiles/profiles";
import {
  ServerPageView,
  serverPages,
  SharedNote,
} from "../settings/server-pages";
import { TeamNaming, TeamPlugins } from "./setup-parts";

interface Entry {
  readonly path: string;
  readonly label: string;
  readonly count?: number;
}

interface Screen extends SetupScreen {
  readonly path: string;
  readonly plugin: string;
}

export function isTeamSetupRoute(route: string): boolean {
  return /^team\/setup(\/|$)/.test(route);
}

function screens(): readonly Screen[] {
  return enabledPlugins().flatMap(({ name, hub }) =>
    Object.entries(hub.setup).map(([key, screen]) => ({
      ...screen,
      path: `team/setup/plugin/${name}/${key}`,
      plugin: name,
    })),
  );
}

// What team work runs on and its rules, which only admins change, and the
// server's own pages that personal Settings shows too (ADRs 0064 and 0067).
export function TeamSetup({
  route,
  user,
  people,
  teamName,
}: {
  readonly route: string;
  readonly user: string;
  readonly people: boolean;
  readonly teamName: string | null;
}): ReactElement {
  const profiles = useTeamProfiles();
  const environments = useTeamEnvironments();
  const plugins = screens();
  const server = serverPages(people);
  const [, , section = "profiles", ...rest] = route.split("/");
  const selected = rest.join("/");

  const groups: readonly (readonly [string, readonly Entry[]])[] = [
    [
      "What team work runs on",
      [
        {
          path: "team/setup/profiles",
          label: "Profiles",
          count: profiles.value.length,
        },
        {
          path: "team/setup/environments",
          label: "Environments",
          count: environments.value.length,
        },
        ...plugins.filter(({ group }) => group === "runs-on"),
      ],
    ],
    [
      "Rules",
      [
        { path: "team/setup/name", label: "Name" },
        { path: "team/setup/plugins", label: "Plugins in team work" },
        ...plugins.filter(({ group }) => group === "rules"),
      ],
    ],
    [
      "Shared with personal work",
      server.map(({ key, label }) => ({
        path: `team/setup/server/${key}`,
        label,
      })),
    ],
  ];

  const content = (): ReactNode => {
    const shared =
      section === "server"
        ? server.find(({ key }) => key === rest[0])
        : undefined;

    if (shared !== undefined) {
      return (
        <>
          <SharedNote>
            Server-wide, for personal and team work alike. It&apos;s the same
            page as in{" "}
            <a href={`#${shared.path}`} className="text-fg underline">
              Settings
            </a>
            , so a change shows in both.
          </SharedNote>
          <ServerPageView
            page={shared}
            route={route}
            base={`team/setup/server/${shared.key}`}
            user={user}
          />
        </>
      );
    }

    if (section === "environments") {
      return (
        <EnvironmentsPage
          environments={environments.value}
          team
          selected={selected}
          onChange={environments.reload}
        />
      );
    }

    if (section === "plugins") {
      return <TeamPlugins />;
    }

    if (section === "name") {
      return <TeamNaming name={teamName} />;
    }

    const screen = plugins.find(({ path }) => path === route);

    if (screen !== undefined) {
      return (
        <Page>
          <PluginBoundary name={screen.plugin}>
            <screen.Page />
          </PluginBoundary>
        </Page>
      );
    }

    return (
      <ProfilesPage
        profiles={profiles.value}
        admin
        team
        selected={section === "profiles" ? selected : ""}
        onChange={profiles.reload}
      />
    );
  };

  const current = (path: string): boolean =>
    route === path ||
    route.startsWith(`${path}/`) ||
    (path === "team/setup/profiles" && route === "team/setup");

  return (
    <AreaLayout
      label="Team setup"
      back={{ href: "#team", label: "Team home" }}
      heading="Team setup"
      groups={groups.map(([label, entries]) => ({
        label,
        items: entries.map(({ path, label: name, count }) => ({
          href: `#${path}`,
          label: name,
          current: current(path),
          ...(count !== undefined && { count }),
        })),
      }))}
    >
      {content()}
    </AreaLayout>
  );
}
