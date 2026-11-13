import type { HubPage } from "@pipoca/protocol";
import { Page } from "@pipoca/ui";
import { type ReactElement, type ReactNode, useState } from "react";
import { request } from "../data/client";
import { useAction, useMe, useQuery } from "../data/hooks";
import { NewSessionDialog } from "../shell/new-session";
import { PluginBoundary } from "../plugin-boundary";
import { SessionView } from "../session/session-view";
import { href, navigate, type Route, routeHref } from "../router";
import { screens, pagesOf, hrefOf, newPageId } from "./hub-pages";
import { AddPage } from "./add-page";
import { LayoutPage, TeamSessions } from "./layout-page";
import { TeamSidebar, type TeamEntry } from "./sidebar";
import { Drawer } from "../shell/drawer";
import { MenuButton } from "../shell/plugin-page";

// The team's own workspace, apart from a person's work, with a sidebar of
// the same shape as theirs. Its pages are layouts of the panels plugins give
// it (ADRs 0065 and 0067).
export function TeamHub({ route }: { readonly route: Route }): ReactElement {
  const { admin } = useMe();
  const people = useQuery("people.list").data ?? [];
  const sessions = useQuery("sessions.list", { query: { scope: "team" } }).data;

  const environments =
    useQuery("environments.list", { query: { scope: "team" } }).data ?? [];

  const layout = useQuery("settings.hub").data;
  const [starting, setStarting] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [drawerRoute, setDrawerRoute] = useState(route);
  const pages = pagesOf(layout?.pages ?? null);
  const current = routeHref(route);

  if (drawerRoute !== route) {
    setDrawerRoute(route);
    setDrawer(false);
  }

  const lay = useAction(async (next: readonly HubPage[]) =>
    request("settings.hub.update", { body: { pages: next } }),
  );

  const opened = route.name === "teamSession" ? route.params.id : undefined;

  const screen =
    route.name === "teamPlugin"
      ? screens().find(
          ({ plugin, key }) =>
            plugin === route.params.plugin && key === route.params.key,
        )
      : undefined;

  const [home, ...laid] = pages;

  const entries: readonly TeamEntry[] = [
    ...(home === undefined
      ? []
      : [
          {
            href: hrefOf(home),
            label: home.id === "home" ? "Home" : home.title,
            icon: "home" as const,
            current: hrefOf(home) === current,
          },
        ]),
    ...screens().map((each) => ({
      href: each.href,
      label: each.label,
      icon: each.icon,
      current: each === screen,
      ...(each.Count && {
        count: (
          <PluginBoundary name={each.plugin}>
            <each.Count />
          </PluginBoundary>
        ),
      }),
    })),
  ];

  const more: readonly TeamEntry[] = [
    ...laid.map((page) => ({
      href: hrefOf(page),
      label: page.title,
      icon: "panel-right" as const,
      current: hrefOf(page) === current,
    })),
    ...(admin
      ? [
          {
            href: href("teamSetup"),
            label: "Team setup",
            icon: "settings" as const,
            current: false,
          },
        ]
      : []),
  ];

  const openPath = route.name === "teamPlugin" ? route.params.rest : undefined;

  const items = screens().flatMap(({ plugin, key, Items }) =>
    Items === undefined
      ? []
      : [
          {
            plugin,
            Items,
            path:
              screen?.plugin === plugin && screen.key === key
                ? openPath
                : undefined,
          },
        ],
  );

  const openDrawer = (): void => {
    setDrawer(true);
  };

  const content = (): ReactNode => {
    if (opened !== undefined) {
      return (
        <SessionView key={opened} sessionId={opened} onMenu={openDrawer} />
      );
    }

    if (route.name === "teamSessions") {
      return <TeamSessions sessions={sessions ?? []} />;
    }

    if (screen !== undefined && route.name === "teamPlugin") {
      return (
        <Page>
          <PluginBoundary name={screen.plugin}>
            <screen.Page path={route.params.rest} />
          </PluginBoundary>
        </Page>
      );
    }

    const page = pages.find((each) => hrefOf(each) === current) ?? home;

    if (page === undefined) {
      return null;
    }

    return (
      <LayoutPage
        key={page.id}
        page={page}
        sessions={sessions ?? []}
        admin={admin}
        error={lay.error}
        onStart={() => {
          setStarting(true);
        }}
        onChange={(changed) => {
          void lay.run(
            pages.map((each) => (each.id === changed.id ? changed : each)),
          );
        }}
        onRemove={() => {
          void lay.run(pages.filter((each) => each.id !== page.id));
          navigate(href("team"));
        }}
      />
    );
  };

  return (
    <>
      <Drawer
        open={drawer}
        onClose={() => {
          setDrawer(false);
        }}
      >
        <TeamSidebar
          entries={entries}
          more={more}
          items={items}
          sessions={sessions ?? []}
          people={people}
          environments={environments}
          opened={opened}
          sessionsCurrent={route.name === "teamSessions"}
          onNewSession={() => {
            setStarting(true);
          }}
          {...(admin && {
            footer: (
              <AddPage
                onAdd={(title) => {
                  const page = {
                    id: newPageId(title, pages),
                    title,
                    panels: [],
                  };

                  void lay.run([...pages, page]);
                  navigate(hrefOf(page));
                }}
              />
            ),
          })}
        />
      </Drawer>

      <main inert={drawer} className="flex min-w-0 flex-1 flex-col">
        {opened === undefined ? (
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
            <div className="p-2 md:hidden">
              <MenuButton onMenu={openDrawer} />
            </div>
            {content()}
          </div>
        ) : (
          content()
        )}
      </main>

      <NewSessionDialog
        open={starting}
        team
        onClose={() => {
          setStarting(false);
        }}
      />
    </>
  );
}
