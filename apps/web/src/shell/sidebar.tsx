import type { Environment, Session } from "@pipoca/protocol";
import { Button, Checkbox, Icon, Mark, TextInput } from "@pipoca/ui";
import { type ReactElement, useState } from "react";
import { matches } from "../notices";
import type { NavEntry } from "../plugins";
import {
  ownedByEnabled,
  SidebarSession,
  EnvironmentStatus,
  NotifyButton,
} from "./sidebar-parts";
import { AccountMenu } from "./account-menu";
import { PluginNav } from "./plugin-nav";

export interface SidebarProps {
  readonly nav: readonly NavEntry[];
  readonly route: string;
  readonly sessions: readonly Session[];
  readonly environments: readonly Environment[];
  readonly showArchived: boolean;
  readonly onShowArchived: (show: boolean) => void;
  readonly onNewSession: () => void;
  readonly user: string;
  // What the team is called, on a server several people use.
  readonly team: string | undefined;
}

export function Sidebar({
  nav,
  route,
  sessions,
  environments,
  showArchived,
  onShowArchived,
  onNewSession,
  user,
  team,
}: SidebarProps): ReactElement {
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);

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
        <span className="flex items-center gap-2 font-serif text-wordmark font-light text-fg-strong">
          <Mark className="size-7" />
          pipoca
        </span>
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

      {team !== undefined && (
        <a
          href="#team"
          className="mx-2 flex items-center gap-2.5 rounded-md px-2 py-1.5 text-ui text-fg hover:bg-hover"
        >
          <span
            aria-hidden="true"
            className="grid size-6 place-items-center rounded-md border border-line bg-elevated text-fg-dim"
          >
            <Icon name="users" className="size-3.5" />
          </span>
          <span className="truncate">{team}</span>
        </a>
      )}
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
            current={session.id === route}
          />
        ))}
      </ul>

      <NotifyButton />
      <EnvironmentStatus environments={environments} />
      <AccountMenu user={user} />
    </nav>
  );
}
