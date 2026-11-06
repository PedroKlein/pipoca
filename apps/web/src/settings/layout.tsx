import { AreaLayout, Avatar, cn, Icon, linkCardClass, Page } from "@pipoca/ui";
import type { ReactElement, ReactNode } from "react";
import { AccountsPage } from "./accounts/accounts";
import { useMe } from "../data/hooks";
import { EnvironmentsPage } from "./environments/environments";
import { GeneralPage } from "./general/general";
import { PluginBoundary } from "../plugin-boundary";
import { enabledPlugins, PluginSettings } from "../plugins";
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
  const people = admin && team;
  const open = page === "" ? "general" : page;

  const shared = admin
    ? serverPages(people).find((entry) => entry.page === open)
    : undefined;

  const content = (): ReactNode => {
    switch (open) {
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

    const part = enabledPlugins().find(
      ({ plugin, settings }) => plugin.id === open && settings !== undefined,
    );

    if (part) {
      return (
        <Page>
          <PluginBoundary name={open}>
            <PluginSettings key={open} part={part} />
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
        items: group.entries.map((entry) => ({
          href: href("settings", { page: entry.page }),
          label: entry.label,
          current: entry.page === open,
        })),
      }))}
      phone="menu"
      menuOpen={page === ""}
      menuHref={href("settings")}
      menuTop={
        <a
          href={href("settings", { page: "general" })}
          className={cn("mt-1 flex items-center gap-3 p-3.5", linkCardClass)}
        >
          <Avatar name={user.name} size="lg" className="size-10 text-ui">
            {user.name.slice(0, 1).toUpperCase()}
          </Avatar>
          <span className="flex-1 text-ui font-medium text-fg-strong">
            {user.name}
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
