import { AreaLayout, Page } from "@pipoca/ui";
import type { ReactElement, ReactNode } from "react";
import { useMe, useQuery } from "../data/hooks";
import { EnvironmentsPage } from "../settings/environments/environments";
import { PluginBoundary } from "../plugin-boundary";
import { enabledPlugins } from "../plugins";
import { ProfilesPage } from "../settings/profiles/profiles";
import { href } from "../router";
import {
  serverPageHref,
  ServerPageView,
  serverPages,
  SharedNote,
} from "../settings/server-pages";
import { TeamNaming, TeamPlugins } from "./setup-parts";

interface Entry {
  readonly section: string;
  readonly rest?: string;
  readonly label: string;
  readonly count?: number;
}

function screens() {
  return enabledPlugins().flatMap(({ plugin: { id }, pages }) =>
    (pages ?? []).flatMap((page) =>
      page.area === "setup"
        ? [
            {
              label: page.label,
              group: page.group ?? "runs-on",
              Page: page.Page,
              section: "plugin",
              rest: `${id}/${page.path}`,
              plugin: id,
            },
          ]
        : [],
    ),
  );
}

// What team work runs on and its rules, which only admins change, and the
// server's own pages that personal Settings shows too (ADRs 0064 and 0067).
export function TeamSetup({
  section: given,
  rest,
}: {
  readonly section: string;
  readonly rest: string;
}): ReactElement {
  const { admin, team } = useMe();
  const scope = { query: { scope: "team" } } as const;
  const profiles = useQuery("profiles.list", scope).data ?? [];
  const environments = useQuery("environments.list", scope).data ?? [];
  const plugins = screens();
  const server = serverPages(admin && team);
  const section = given === "" ? "profiles" : given;

  const groups: readonly (readonly [string, readonly Entry[]])[] = [
    [
      "What team work runs on",
      [
        { section: "profiles", label: "Profiles", count: profiles.length },
        {
          section: "environments",
          label: "Environments",
          count: environments.length,
        },
        ...plugins.filter(({ group }) => group === "runs-on"),
      ],
    ],
    [
      "Rules",
      [
        { section: "name", label: "Name" },
        { section: "plugins", label: "Plugins in team work" },
        ...plugins.filter(({ group }) => group === "rules"),
      ],
    ],
    [
      "Shared with personal work",
      server.map(({ page, label }) => ({
        section: "server",
        rest: page,
        label,
      })),
    ],
  ];

  const [page = "", ...more] = rest.split("/");

  const content = (): ReactNode => {
    switch (section) {
      case "server":
        return (
          server.some((entry) => entry.page === page) && (
            <>
              <SharedNote>
                Server-wide, for personal and team work alike. It&apos;s the
                same page as in{" "}
                <a
                  href={serverPageHref(false, page)}
                  className="text-fg underline"
                >
                  Settings
                </a>
                , so a change shows in both.
              </SharedNote>
              <ServerPageView page={page} rest={more.join("/")} team />
            </>
          )
        );
      case "environments":
        return <EnvironmentsPage team selected={rest} />;
      case "plugins":
        return <TeamPlugins />;
      case "name":
        return <TeamNaming />;
      case "profiles":
        return <ProfilesPage team selected={rest} />;
    }

    const screen = plugins.find((each) => each.rest === rest);

    return (
      screen !== undefined && (
        <Page>
          <PluginBoundary name={screen.plugin}>
            <screen.Page path="" />
          </PluginBoundary>
        </Page>
      )
    );
  };

  const current = (entry: Entry): boolean =>
    entry.section === section &&
    (entry.rest === undefined ||
      rest === entry.rest ||
      rest.startsWith(`${entry.rest}/`));

  return (
    <AreaLayout
      label="Team setup"
      back={{ href: href("team"), label: "Team home" }}
      heading="Team setup"
      groups={groups.map(([label, entries]) => ({
        label,
        items: entries.map((entry) => ({
          href: href("teamSetup", {
            section: entry.section,
            rest: entry.rest ?? "",
          }),
          label: entry.label,
          current: current(entry),
          ...(entry.count !== undefined && { count: entry.count }),
        })),
      }))}
    >
      {content()}
    </AreaLayout>
  );
}
