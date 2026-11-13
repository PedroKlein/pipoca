import type { Session } from "@pipoca/protocol";
import { Button, Checkbox, Icon, Mark } from "@pipoca/ui";
import type { ReactElement } from "react";
import { useMe, useQuery } from "../data/hooks";
import type { NavEntry } from "../plugins";
import type { Route } from "../router";
import {
  EnvironmentStatus,
  listedSessions,
  NotifyButton,
  SessionList,
  useSessionSearch,
} from "./sidebar-parts";
import { AccountMenu } from "./account-menu";
import { PluginNav } from "./plugin-nav";
import { WorkspaceSwitcher } from "./workspace-switcher";

interface SidebarProps {
  readonly nav: readonly NavEntry[];
  readonly route: Route;
  readonly sessions: readonly Session[];
  readonly showArchived: boolean;
  readonly onShowArchived: (show: boolean) => void;
  readonly onNewSession: () => void;
}

export function Sidebar({
  nav,
  route,
  sessions,
  showArchived,
  onShowArchived,
  onNewSession,
}: SidebarProps): ReactElement {
  const me = useMe();
  const environments = useQuery("environments.list").data ?? [];
  const search = useSessionSearch("Search sessions");
  const opened = route.name === "session" ? route.params.id : undefined;
  const shown = listedSessions(sessions, search.query, environments);

  return (
    <nav aria-label="Pipoca" className="flex h-full flex-col bg-panel">
      <div className="flex items-center justify-between gap-2 py-3 pr-3 pl-4">
        {me.team ? (
          <WorkspaceSwitcher inTeam={false} />
        ) : (
          <span className="flex items-center gap-2 font-serif text-wordmark font-light text-fg-strong">
            <Mark className="size-7" />
            pipoca
          </span>
        )}
        <span className="flex items-center gap-1">
          {search.toggle}
          <Button
            variant="primary"
            iconOnly
            aria-label="New session"
            onClick={onNewSession}
          >
            <Icon name="plus" />
          </Button>
        </span>
      </div>

      <PluginNav nav={nav} route={route} />

      <div className="mt-2 flex items-center justify-between border-t border-line px-4 pt-4 pb-2">
        <h2 className="text-caption font-medium text-fg-dim">Sessions</h2>
        <Checkbox
          id="show-archived"
          label="Show archived"
          checked={showArchived}
          onChange={(event) => {
            onShowArchived(event.target.checked);
          }}
          size="sm"
        />
      </div>

      {search.field}

      <SessionList
        id="sessions"
        sessions={shown}
        environments={environments}
        searched={search.query !== ""}
        none="No sessions yet."
        opened={opened}
        className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-2"
      />

      <NotifyButton />
      <EnvironmentStatus environments={environments} />
      <AccountMenu />
    </nav>
  );
}
