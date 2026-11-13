import type { Environment, Session, Teammate } from "@pipoca/protocol";
import {
  Avatar,
  Button,
  Checkbox,
  cn,
  Icon,
  type IconName,
  TextInput,
} from "@pipoca/ui";
import {
  type ComponentType,
  type ReactElement,
  type ReactNode,
  useState,
} from "react";
import type { NavItemsProps } from "@pipoca/plugins/web";
import { useMe } from "../data/hooks";
import { matches } from "../notices";
import { PluginBoundary } from "../plugin-boundary";
import { href } from "../router";
import { AccountMenu } from "../shell/account-menu";
import {
  EnvironmentStatus,
  ownedByEnabled,
  SidebarSession,
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
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [mine, setMine] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const showMore = moreOpen || more.some(({ current }) => current);

  const nameOf = (id: string | null): string | undefined => {
    if (id === me.user.id) {
      return "You";
    }

    return people.find((person) => person.id === id)?.name;
  };

  const environmentName = (session: Session): string =>
    environments.find(({ id }) => id === session.environmentId)?.name ??
    session.provider;

  const shown = sessions.filter(
    (session) =>
      session.archivedAt === null &&
      (query !== "" || !ownedByEnabled(session)) &&
      (!mine || session.startedBy === me.user.id) &&
      matches(session, query, environmentName(session)),
  );

  const here = people.filter((person) => person.here === true);

  const row = ({
    href: to,
    label,
    icon,
    current,
    count,
  }: TeamEntry): ReactElement => (
    <a
      key={to}
      href={to}
      aria-current={current ? "page" : undefined}
      className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-ui text-fg hover:bg-hover aria-[current=page]:bg-hover aria-[current=page]:text-fg-strong"
    >
      <Icon name={icon} className="text-fg-dim" />
      <span className="truncate">{label}</span>
      {count !== undefined && (
        <span className="ml-auto text-caption text-fg-dim tabular-nums">
          {count}
        </span>
      )}
    </a>
  );

  return (
    <nav aria-label="Team" className="flex h-full flex-col bg-panel">
      <div className="flex items-center gap-1 py-3 pr-3 pl-2.5">
        <WorkspaceSwitcher inTeam />
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

        {searching && (
          <div className="px-3 pb-2">
            <TextInput
              type="search"
              aria-label="Search sessions"
              placeholder="Search team sessions"
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

        <ul id="team-sessions" className="flex flex-col gap-0.5 px-2 pb-2">
          {shown.length === 0 && (
            <li className="px-3 py-2 text-caption text-fg-dim">
              {query === "" ? "No team sessions yet." : "No sessions match."}
            </li>
          )}
          {shown.map((session) => (
            <SidebarSession
              key={session.id}
              session={session}
              environment={environments.find(
                ({ id }) => id === session.environmentId,
              )}
              who={nameOf(session.startedBy)}
              link={href("teamSession", { id: session.id })}
              current={session.id === opened}
            />
          ))}
        </ul>
      </div>

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
                  >
                    {Array.from(person.name).slice(0, 2).join("").toUpperCase()}
                  </Avatar>
                ))}
              </span>
              <span className="text-caption text-fg-dim">
                {String(here.length)} here now
              </span>
            </span>
          )
        }
      />
      <AccountMenu user={me.user.name} />
    </nav>
  );
}
