import type { Session } from "@pipoca/protocol";
import { Button, Checkbox, Icon, Mark, TextInput } from "@pipoca/ui";
import { type ReactElement, useState } from "react";
import { useMe, useQuery } from "../data/hooks";
import { matches } from "../notices";
import type { NavEntry } from "../plugins";
import type { Route } from "../router";
import {
  ownedByEnabled,
  SidebarSession,
  EnvironmentStatus,
  NotifyButton,
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
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const me = useMe();
  const environments = useQuery("environments.list").data ?? [];

  const opened = route.name === "session" ? route.params.id : undefined;

  const environmentName = (session: Session): string =>
    environments.find((e) => e.id === session.environmentId)?.name ??
    session.provider;

  // A plugin's own Sessions show inside the plugin, and here only in a search
  // or once the plugin is off (ADR 0028).
  const shown = sessions.filter(
    (session) =>
      (query !== "" || !ownedByEnabled(session)) &&
      matches(session, query, environmentName(session)),
  );

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
          <Button
            variant="ghost"
            iconOnly
            aria-label="Search"
            aria-expanded={searching}
            onClick={() => {
              setSearching(!searching);
              setQuery("");
            }}
          >
            <Icon name="search" />
          </Button>
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

      {searching && (
        <div className="px-3 pb-2">
          <TextInput
            type="search"
            aria-label="Search sessions"
            placeholder="Search sessions"
            autoFocus
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setSearching(false);
                setQuery("");
              }
            }}
            className="w-full py-1 text-label"
          />
        </div>
      )}

      <ul
        id="sessions"
        className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-2"
      >
        {shown.length === 0 && (
          <li className="px-3 py-2 text-caption text-fg-dim">
            {query === "" ? "No sessions yet." : "No sessions match."}
          </li>
        )}
        {shown.map((session) => (
          <SidebarSession
            key={session.id}
            session={session}
            environment={environments.find(
              (e) => e.id === session.environmentId,
            )}
            current={session.id === opened}
          />
        ))}
      </ul>

      <NotifyButton />
      <EnvironmentStatus environments={environments} />
      <AccountMenu />
    </nav>
  );
}
