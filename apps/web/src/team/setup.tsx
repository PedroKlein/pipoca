import { Page, Tabs } from "@pipoca/ui";
import type { ReactElement, ReactNode } from "react";
import { useMe } from "../data/hooks";
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
import { HubLayout, TeamNaming, TeamPlugins } from "./setup-parts";

interface Entry {
  readonly section: string;
  readonly rest?: string;
  readonly label: string;
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
// server's own pages that personal Settings shows too, as tabs inside the
// team workspace (ADRs 0064 and 0067).
export function TeamSetup({
  section: given,
  rest,
}: {
  readonly section: string;
  readonly rest: string;
}): ReactElement {
  const { admin, team } = useMe();
  const plugins = screens();
  const server = serverPages(admin && team);
  const section = given === "" ? "profiles" : given;

  const entries: readonly Entry[] = [
    { section: "profiles", label: "Profiles" },
    { section: "environments", label: "Environments" },
    ...plugins.filter(({ group }) => group === "runs-on"),
    { section: "plugins", label: "Plugins" },
    ...plugins.filter(({ group }) => group === "rules"),
    { section: "layout", label: "Hub layout" },
    { section: "name", label: "Name" },
    ...server.map(({ page, label }) => ({
      section: "server",
      rest: page,
      label: page === "plugins" ? "Server plugins" : label,
    })),
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
      case "layout":
        return <HubLayout />;
      case "name":
        return <TeamNaming />;
      case "profiles":
        return <ProfilesPage team selected={rest} />;
    }

    const screen = plugins.find((each) => each.rest === rest);

    return (
      screen !== undefined && (
        <PluginBoundary name={screen.plugin}>
          <screen.Page path="" />
        </PluginBoundary>
      )
    );
  };

  const current = entries.find(
    (entry) =>
      entry.section === section &&
      (entry.rest === undefined ||
        rest === entry.rest ||
        rest.startsWith(`${entry.rest}/`)),
  );

  const key = (entry: Entry): string =>
    entry.rest === undefined ? entry.section : `${entry.section}/${entry.rest}`;

  return (
    <Page>
      <Tabs
        label="Team setup"
        value={current && key(current)}
        tabs={entries.map((entry) => ({
          value: key(entry),
          label: entry.label,
          href: href("teamSetup", {
            section: entry.section,
            rest: entry.rest ?? "",
          }),
        }))}
      />
      <div className="mt-10">{content()}</div>
    </Page>
  );
}
