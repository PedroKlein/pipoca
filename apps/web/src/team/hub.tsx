import type { HubPage } from "@pipoca/protocol";
import { AreaLayout, Avatar, Page, plural } from "@pipoca/ui";
import { type ReactElement, type ReactNode, useState } from "react";
import { request } from "../data/client";
import { useAction, useMe, useQuery } from "../data/hooks";
import { NewSessionDialog } from "../shell/new-session";
import { PluginBoundary } from "../plugin-boundary";
import { SessionView } from "../session/session-view";
import { pluginContext } from "../plugins";
import { href, navigate, type Route, routeHref } from "../router";
import { type Entry, screens, pagesOf, hrefOf, newPageId } from "./hub-pages";
import { AddPage } from "./add-page";
import { LayoutPage, TeamSessions } from "./layout-page";

// The team's own area, apart from a person's work, with its own menu. Its
// pages are layouts of the panels plugins give it (ADRs 0065 and 0067).
export function TeamHub({ route }: { readonly route: Route }): ReactElement {
  const { admin } = useMe();
  const name = useQuery("settings.team").data?.name ?? null;
  const people = useQuery("people.list").data;
  const sessions = useQuery("sessions.list", { query: { scope: "team" } }).data;
  const layout = useQuery("settings.hub").data;
  const [starting, setStarting] = useState(false);
  const pages = pagesOf(layout?.pages ?? null);
  const current = routeHref(route);

  const lay = useAction(async (next: readonly HubPage[]) =>
    request("settings.hub.update", { body: { pages: next } }),
  );

  const entries: readonly Entry[] = [
    ...pages.map((page) => ({
      href: hrefOf(page),
      label: page.title,
      icon: page.id === "home" ? ("home" as const) : ("panel-right" as const),
    })),
    {
      href: href("teamSessions"),
      label: "Sessions",
      icon: "menu",
      ...(sessions !== undefined && { count: sessions.length }),
    },
    ...screens().map((screen) => ({
      href: screen.href,
      label: screen.label,
      icon: "panel-right" as const,
    })),
  ];

  const opened = route.name === "teamSession" ? route.params.id : undefined;

  const content = (): ReactNode => {
    if (opened !== undefined) {
      return <SessionView key={opened} sessionId={opened} />;
    }

    if (route.name === "teamSessions") {
      return <TeamSessions sessions={sessions ?? []} />;
    }

    const screen = screens().find((each) => each.href === current);

    if (screen !== undefined) {
      return (
        <Page>
          <PluginBoundary name={screen.plugin}>
            <screen.Page context={pluginContext(screen.plugin)} />
          </PluginBoundary>
        </Page>
      );
    }

    const page = pages.find((each) => hrefOf(each) === current) ?? pages[0];

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
    <AreaLayout
      label="Team"
      back={{ href: href("home"), label: "My work" }}
      heading={name ?? "Team"}
      mark={<Avatar name={name ?? "Team"} square size="md" />}
      detail={
        people === undefined
          ? undefined
          : plural(people.length, "person", "people")
      }
      groups={[
        {
          items: [
            ...entries.map((entry) => ({
              href: entry.href,
              label: entry.label,
              icon: entry.icon,
              ...(entry.count !== undefined && { count: entry.count }),
              current:
                entry.href === current ||
                (opened !== undefined && entry.href === href("teamSessions")),
            })),
            ...(admin
              ? [
                  {
                    href: href("teamSetup"),
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

              void lay.run([...pages, page]);
              navigate(hrefOf(page));
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
        onClose={() => {
          setStarting(false);
        }}
      />
    </AreaLayout>
  );
}
