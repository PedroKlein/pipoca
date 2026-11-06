import {
  type AreaItem,
  AreaLayout,
  Avatar,
  Badge,
  cn,
  Icon,
  linkCardClass,
  Page,
  Row,
  Rows,
} from "@pipoca/ui";
import type { ReactElement, ReactNode } from "react";
import { AccountsPage } from "./accounts/accounts";
import { useMe, useQuery } from "../data/hooks";
import { EnvironmentsPage } from "./environments/environments";
import { GeneralPage } from "./general/general";
import { PluginBoundary } from "../plugin-boundary";
import { enabledPlugins } from "../plugins";
import { ProfilesPage } from "./profiles/profiles";
import { href } from "../router";
import { TokensPage } from "./tokens/tokens";
import {
  type Entry,
  pluginPages,
  serverPageHref,
  ServerPageView,
  serverPages,
  SharedNote,
} from "./server-pages";

interface Group {
  readonly label: string;
  readonly entries: readonly Entry[];
}

// The server pages a phone's menu keeps in view; the rest go under More.
const upfront = new Set(["people", "integrations"]);

// Settings is grouped by who it is for, and only admins see the server's
// pages (ADR 0063).
function groups(admin: boolean, people: boolean): readonly Group[] {
  return [
    {
      label: "You",
      entries: [
        { page: "general", label: "General" },
        { page: "accounts", label: "Accounts" },
        ...pluginPages("you"),
        { page: "tokens", label: "Access tokens" },
      ],
    },
    {
      label: "Workspace",
      entries: [
        { page: "environments", label: "Environments" },
        { page: "profiles", label: "Profiles" },
        ...pluginPages("workspace"),
      ],
    },
    ...(admin
      ? [{ label: "Server, for admins", entries: serverPages(people) }]
      : []),
  ];
}

export function SettingsLayout({
  page,
  rest,
}: {
  // "" on a phone's menu of the pages.
  readonly page: string;
  readonly rest: string;
}): ReactElement {
  const { user, admin, team } = useMe();
  const shown = useQuery("me").data?.displayName ?? user.name;
  const people = admin && team;
  const open = page === "" ? "general" : page;
  const environments = useQuery("environments.list").data;
  const profiles = useQuery("profiles.list").data;
  const everyone = useQuery("people.list").data;
  const installed = useQuery("plugins.list").data ?? [];
  const failed = installed.filter(({ state }) => state === "failed").length;

  const more = admin
    ? serverPages(people).filter((entry) => !upfront.has(entry.page))
    : [];

  const counts: Readonly<Record<string, number | undefined>> = {
    environments: environments?.length,
    profiles: profiles?.length,
    people: everyone?.length,
  };

  const statuses: Readonly<Record<string, ReactNode>> = {
    integrations: <Badge state="done">On</Badge>,
    plugins: failed > 0 && <Badge state="failed">{failed} failed</Badge>,
  };

  const itemOf = (entry: Entry): AreaItem => {
    const count = counts[entry.page];

    return {
      href: href("settings", { page: entry.page }),
      label: entry.label,
      current: entry.page === open,
      ...(count !== undefined && { count }),
    };
  };

  const shared = admin
    ? serverPages(people).find((entry) => entry.page === open)
    : undefined;

  const content = (): ReactNode => {
    switch (open) {
      case "more":
        return (
          <Page title="More">
            <Rows label="More">
              {more.map((entry) => (
                <Row
                  key={entry.page}
                  title={
                    <a
                      href={href("settings", { page: entry.page })}
                      className="hover:underline focus-visible:underline"
                    >
                      {entry.label}
                    </a>
                  }
                >
                  {statuses[entry.page]}
                </Row>
              ))}
            </Rows>
          </Page>
        );
      case "profiles":
        return <ProfilesPage selected={rest} />;
      case "environments":
        return <EnvironmentsPage selected={rest} />;
      case "accounts":
        return <AccountsPage />;
      case "tokens":
        return <TokensPage />;
      case "general":
        return <GeneralPage />;
    }

    if (shared !== undefined) {
      return <ServerPageView page={open} rest={rest} team={false} />;
    }

    const Section = enabledPlugins().find(
      (plugin) => plugin.name === open,
    )?.SettingsSection;

    if (Section) {
      return (
        <Page>
          <PluginBoundary name={open}>
            <Section />
          </PluginBoundary>
        </Page>
      );
    }

    return <GeneralPage />;
  };

  return (
    <AreaLayout
      label="Settings"
      back={{ href: href("home"), label: "Back to Pipoca" }}
      heading="Settings"
      groups={groups(admin, people).map((group) => ({
        label: group.label,
        items: group.entries.map(itemOf),
      }))}
      menuGroups={groups(admin, people).map((group) => ({
        label: group.label,
        items: [
          ...group.entries
            .filter((entry) => !more.some((each) => each.page === entry.page))
            .map((entry) => ({
              ...itemOf(entry),
              status: statuses[entry.page],
            })),
          ...(group.entries.some((entry) => entry.page === more[0]?.page)
            ? [
                {
                  href: href("settings", { page: "more" }),
                  label: "More",
                  hint: more.map(({ label }) => label).join(", "),
                },
              ]
            : []),
        ],
      }))}
      phone="menu"
      menuOpen={page === ""}
      menuHref={href("settings")}
      menuTop={
        <a
          href={href("settings", { page: "general" })}
          className={cn("mt-1 flex items-center gap-3 p-3.5", linkCardClass)}
        >
          <Avatar name={shown} size="lg" className="size-10 text-ui" />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-ui font-medium text-fg-strong">{shown}</span>
            <span className="text-label text-fg-dim">
              {admin ? `Admin · @${user.name}` : `@${user.name}`}
            </span>
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
            href={serverPageHref(true, shared.page)}
            className="text-fg underline"
          >
            open it there
          </a>
          .
        </SharedNote>
      )}
      {content()}
    </AreaLayout>
  );
}
