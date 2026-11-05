import type { HubPage } from "@pipoca/protocol";
import { AreaLayout, Avatar, Page, plural } from "@pipoca/ui";
import { type ReactElement, type ReactNode, useState } from "react";
import { api } from "../api";
import {
  useHubLayout,
  useTeamEnvironments,
  useTeammates,
  useTeamProfiles,
  useTeamSessions,
} from "../hooks";
import { NewSessionDialog } from "../new-session";
import { PluginBoundary } from "../plugin-boundary";
import { SessionView } from "../session-view";
import { pluginContext } from "../plugins";
import { type Entry, screens, pagesOf, pathOf, newPageId } from "./hub-pages";
import { AddPage } from "./add-page";
import { LayoutPage, TeamSessions } from "./layout-page";

export function isTeamRoute(route: string): boolean {
  return /^team(\/|$)/.test(route);
}

// The team's own area, apart from a person's work, with its own menu. Its
// pages are layouts of the panels plugins give it (ADRs 0065 and 0067).
export function TeamHub({
  route,
  admin,
  name,
}: {
  readonly route: string;
  readonly admin: boolean;
  readonly name: string | null;
}): ReactElement {
  const people = useTeammates();
  const sessions = useTeamSessions();
  const environments = useTeamEnvironments();
  const profiles = useTeamProfiles();
  const layout = useHubLayout();
  const [starting, setStarting] = useState(false);
  const pages = pagesOf(layout.pages);
  const [error, setError] = useState<string>();

  const lay = (next: readonly HubPage[]): void => {
    api("settings.hub.update", { body: { pages: next } }).then(
      () => {
        setError(undefined);
        layout.reload();
      },
      (reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
  };

  const entries: readonly Entry[] = [
    ...pages.map((page) => ({
      path: pathOf(page),
      label: page.title,
      icon: page.id === "home" ? ("home" as const) : ("panel-right" as const),
    })),
    { path: "team/sessions", label: "Sessions", icon: "menu" },
    ...screens().map(({ path, label }) => ({
      path,
      label,
      icon: "panel-right" as const,
    })),
  ];

  const open = pages.find((page) => pathOf(page) === route);
  const screen = screens().find(({ path }) => path === route);

  const opened = /^team\/sessions\/(.+)$/.exec(route)?.[1];

  const content = (): ReactNode => {
    if (opened !== undefined) {
      return (
        <SessionView
          key={opened}
          sessionId={opened}
          environments={environments.value}
          onSessionChange={sessions.reload}
        />
      );
    }

    if (route === "team/sessions") {
      return <TeamSessions sessions={sessions.value} />;
    }

    if (screen !== undefined) {
      return (
        <Page>
          <PluginBoundary name={screen.plugin}>
            <screen.Page context={pluginContext(screen.plugin)} />
          </PluginBoundary>
        </Page>
      );
    }

    const page = open ?? pages[0];

    if (page === undefined) {
      return null;
    }

    return (
      <LayoutPage
        key={page.id}
        page={page}
        sessions={sessions.value}
        admin={admin}
        error={error}
        onStart={() => {
          setStarting(true);
        }}
        onChange={(changed) => {
          lay(pages.map((each) => (each.id === changed.id ? changed : each)));
        }}
        onRemove={() => {
          lay(pages.filter((each) => each.id !== page.id));
          location.assign("#team");
        }}
      />
    );
  };

  return (
    <AreaLayout
      label="Team"
      back={{ href: "#", label: "My work" }}
      heading={name ?? "Team"}
      mark={<Avatar name={name ?? "Team"} square size="md" />}
      detail={
        people.loaded
          ? plural(people.value.length, "person", "people")
          : undefined
      }
      groups={[
        {
          items: [
            ...entries.map(({ path, label, icon }) => ({
              href: `#${path}`,
              label,
              icon,
              current:
                route === path ||
                (route === "team/" && path === "team") ||
                (opened !== undefined && path === "team/sessions"),
            })),
            ...(admin
              ? [
                  {
                    href: "#team/setup",
                    label: "Team setup",
                    icon: "settings" as const,
                  },
                ]
              : []),
          ],
        },
      ]}
      footer={
        admin && (
          <AddPage
            onAdd={(title) => {
              const page = { id: newPageId(title, pages), title, panels: [] };

              lay([...pages, page]);
              location.assign(`#${pathOf(page)}`);
            }}
          />
        )
      }
      fill={opened !== undefined}
    >
      {content()}
      <NewSessionDialog
        open={starting}
        team
        environments={environments.value}
        profiles={profiles.value}
        sessions={sessions.value}
        onClose={() => {
          setStarting(false);
        }}
      />
    </AreaLayout>
  );
}
