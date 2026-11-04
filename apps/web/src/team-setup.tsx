import type { SetupScreen } from "@pipoca/plugins/web";
import { Icon } from "@pipoca/ui";
import type { ReactElement, ReactNode } from "react";
import { EnvironmentsPage } from "./environments";
import { useTeamEnvironments, useTeamProfiles } from "./hooks";
import { settingsPageClass } from "./page-class";
import { PluginBoundary } from "./plugin-boundary";
import { enabledPlugins, pluginContext, pluginTitle } from "./plugins";
import { ProfilesPage } from "./profiles";

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
    Object.entries(hub?.setup ?? {}).map(([key, screen]) => ({
      ...screen,
      path: `team/setup/plugin/${name}/${key}`,
      plugin: name,
    })),
  );
}

// What team work runs on and its rules, which only admins change. What the
// whole server shares stays in Settings (ADRs 0064 and 0067).
export function TeamSetup({
  route,
  people,
}: {
  readonly route: string;
  readonly people: boolean;
}): ReactElement {
  const profiles = useTeamProfiles();
  const environments = useTeamEnvironments();
  const plugins = screens();
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
    ["Rules", plugins.filter(({ group }) => group === "rules")],
    [
      "For the whole server, in Settings",
      [
        ...(people ? [{ path: "people", label: "People" }] : []),
        ...enabledPlugins().flatMap(
          ({ name, SettingsSection, settingsGroup }) =>
            SettingsSection && settingsGroup === "server"
              ? [{ path: `settings/${name}`, label: pluginTitle(name) }]
              : [],
        ),
        { path: "plugins", label: "Plugins" },
      ],
    ],
  ];

  const content = (): ReactNode => {
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

    const screen = plugins.find(({ path }) => path === route);

    if (screen !== undefined) {
      return (
        <div className={settingsPageClass}>
          <PluginBoundary name={screen.plugin}>
            <screen.Page context={pluginContext(screen.plugin)} />
          </PluginBoundary>
        </div>
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
    <div className="flex min-h-0 flex-1 max-md:flex-col">
      <nav
        aria-label="Team setup"
        className="flex w-62 shrink-0 flex-col gap-px overflow-y-auto border-r border-line bg-panel px-3 pt-4 pb-6 max-md:w-full max-md:flex-row max-md:flex-wrap max-md:items-center max-md:border-r-0 max-md:border-b max-md:py-2"
      >
        <a
          href="#team"
          className="mb-2.5 flex items-center gap-2 rounded-md px-2.5 py-1.5 text-label text-fg-dim hover:bg-hover max-md:mb-0"
        >
          <Icon name="chevron-left" />
          Team home
        </a>
        <h2 className="px-2.5 pt-0.5 pb-1.5 font-serif text-wordmark font-light text-fg-strong max-md:hidden">
          Team setup
        </h2>
        {groups
          .filter(([, entries]) => entries.length > 0)
          .map(([label, entries]) => (
            <div key={label} className="flex flex-col gap-px max-md:contents">
              <h3 className="px-2.5 pt-4 pb-1 text-caption text-fg-dim max-md:hidden">
                {label}
              </h3>
              {entries.map(({ path, label: name, count }) => (
                <a
                  key={path}
                  href={`#${path}`}
                  aria-current={current(path) ? "page" : undefined}
                  className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-ui text-fg hover:bg-hover aria-[current=page]:bg-hover aria-[current=page]:font-medium aria-[current=page]:text-fg-strong"
                >
                  <span className="flex-1">{name}</span>
                  {count !== undefined && (
                    <span className="text-caption text-fg-dim tabular-nums">
                      {count}
                    </span>
                  )}
                </a>
              ))}
            </div>
          ))}
      </nav>
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">{content()}</div>
    </div>
  );
}
