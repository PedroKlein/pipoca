import type { Environment, Session, Teammate } from "@pipoca/protocol";
import { Avatar, Button, Checkbox, cn, Icon, type IconName } from "@pipoca/ui";
import {
  type ComponentType,
  type ReactElement,
  type ReactNode,
  useState,
} from "react";
import type { NavItemsProps } from "@pipoca/plugins/web";
import { useMe } from "../data/hooks";
import { PluginBoundary } from "../plugin-boundary";
import { href } from "../router";
import { AccountMenu } from "../shell/account-menu";
import {
  EnvironmentStatus,
  listedSessions,
  NavRow,
  NotifyButton,
  SessionList,
  useSessionSearch,
  useStartedBy,
} from "../shell/sidebar-parts";
import { WorkspaceSwitcher } from "../shell/workspace-switcher";

export interface TeamEntry {
  readonly href: string;
  readonly label: string;
  readonly icon: IconName;
  readonly current: boolean;
  readonly count?: ReactNode;
}

// What a plugin lists live under the main entries, such as active Projects.
export interface TeamItems {
  readonly plugin: string;
  readonly path: string | undefined;
  readonly Items: ComponentType<NavItemsProps>;
}

// The team's workspace has the same shape as a person's own sidebar: the
// switcher, search and new, the main entries, then live lists of the
// team's Projects and Sessions, and who is here.
export function TeamSidebar({
  entries,
  more,
  items,
  sessions,
  people,
  environments,
  opened,
  sessionsCurrent,
  footer,
  onNewSession,
}: {
  readonly entries: readonly TeamEntry[];
  // Pages under More, such as the hub's own pages and Team setup.
  readonly more: readonly TeamEntry[];
  readonly items: readonly TeamItems[];
  readonly sessions: readonly Session[];
  readonly people: readonly Teammate[];
  readonly environments: readonly Environment[];
  readonly opened: string | undefined;
  readonly sessionsCurrent: boolean;
  // Under More, such as adding a page.
  readonly footer?: ReactNode;
  readonly onNewSession: () => void;
}): ReactElement {
  const me = useMe();
  const search = useSessionSearch("Search team sessions");
  const [mine, setMine] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const showMore = moreOpen || more.some(({ current }) => current);

  const nameOf = useStartedBy();

  const shown = listedSessions(
    sessions.filter(
      (session) =>
        session.archivedAt === null &&
        (!mine || session.startedBy === me.user.id),
    ),
    search.query,
    environments,
  );

  const here = people.filter((person) => person.here === true);

  const row = (entry: TeamEntry): ReactElement => (
    <NavRow key={entry.href} {...entry} />
  );

  return (
    <nav aria-label="Team" className="flex h-full flex-col bg-panel">
      <div className="flex items-center gap-1 py-3 pr-3 pl-2.5">
        <WorkspaceSwitcher inTeam />
        {search.toggle}
        <Button
          variant="primary"
          iconOnly
          aria-label="New team session"
          onClick={onNewSession}
        >
          <Icon name="plus" />
        </Button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="flex flex-col gap-0.5 px-2">
          {entries.map(row)}
          {more.length > 0 && (
            <button
              type="button"
              aria-expanded={showMore}
              onClick={() => {
                setMoreOpen(!showMore);
              }}
              className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-ui text-fg hover:bg-hover"
            >
              <Icon name="more" className="text-fg-dim" />
              <span className="flex min-w-0 flex-1 flex-col">
                More
                {!showMore && (
                  <span className="truncate text-caption text-fg-dim">
                    {more.map(({ label }) => label).join(", ")}
                  </span>
                )}
              </span>
              <Icon
                name="chevron-down"
                className={cn(
                  "size-3 text-fg-dim transition-transform",
                  showMore && "rotate-180",
                )}
              />
            </button>
          )}
          {showMore && (
            <div className="flex flex-col gap-0.5 pl-4">
              {more.map(row)}
              {footer}
            </div>
          )}
        </div>

        {items.map(({ plugin, path, Items }) => (
          <div
            key={plugin}
            className="mt-2 border-t border-line px-2 pt-3 empty:hidden"
          >
            <PluginBoundary name={plugin}>
              <Items path={path} />
            </PluginBoundary>
          </div>
        ))}

        <div className="mt-2 flex items-center justify-between border-t border-line px-4 pt-4 pb-2">
          <a
            href={href("teamSessions")}
            aria-current={sessionsCurrent ? "page" : undefined}
            className="flex items-center gap-1.5 text-caption font-medium text-fg-dim hover:text-fg aria-[current=page]:text-fg-strong"
          >
            Sessions
            <span className="tabular-nums">{shown.length}</span>
          </a>
          <Checkbox
            id="team-mine-only"
            label="Mine only"
            checked={mine}
            onChange={(event) => {
              setMine(event.target.checked);
            }}
            size="sm"
          />
        </div>

        {search.field}

        <SessionList
          id="team-sessions"
          sessions={shown}
          environments={environments}
          searched={search.query !== ""}
          none="No team sessions yet."
          opened={opened}
          who={({ startedBy }) => nameOf(startedBy)}
          link={({ id }) => href("teamSession", { id })}
          className="flex flex-col gap-0.5 px-2 pb-2"
        />
      </div>

      <NotifyButton />
      <EnvironmentStatus
        environments={environments}
        before={
          here.length > 0 && (
            <span className="flex shrink-0 items-center gap-2 pt-0.5">
              <span className="flex -space-x-1.5">
                {here.slice(0, 4).map((person) => (
                  <Avatar
                    key={person.id}
                    name={person.name}
                    size="xs"
                    className="bg-elevated text-fg-dim ring-2 ring-panel"
                  />
                ))}
              </span>
              <span className="text-caption text-fg-dim">
                {String(here.length)} here now
              </span>
            </span>
          )
        }
      />
      <AccountMenu />
    </nav>
  );
}
