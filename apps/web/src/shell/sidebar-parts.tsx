import { ThemeSwitch } from "../theme";
import {
  availability,
  type Environment,
  modelName,
  type Session,
} from "@pipoca/protocol";
import {
  Avatar,
  Badge,
  Button,
  Icon,
  type IconName,
  SessionRow,
  StatusDot,
  TextInput,
} from "@pipoca/ui";
import { type ReactElement, type ReactNode, useState } from "react";
import { useNow } from "@pipoca/plugins/web";
import {
  ago,
  sessionBadge,
  sessionTitle,
  shortName,
  workspaceName,
} from "../names";
import { useMe, useQuery } from "../data/hooks";
import { matches } from "../notices";
import { enabledPlugins, pageLabel, sessionHref } from "../plugins";

export function ownedByEnabled({ plugin }: Session): boolean {
  return (
    plugin !== null &&
    enabledPlugins().some((part) => part.plugin.id === plugin.id)
  );
}

// An entry in a sidebar's nav: a page with its icon, or its initial when it
// has none, and a count at the end.
export function NavRow({
  href: to,
  label,
  icon,
  current,
  count,
}: {
  readonly href: string;
  readonly label: string;
  readonly icon: IconName | undefined;
  readonly current: boolean;
  readonly count?: ReactNode;
}): ReactElement {
  return (
    <a
      href={to}
      aria-current={current ? "page" : undefined}
      className="group/nav flex items-center gap-2.5 rounded-md px-2 py-1.5 text-ui text-fg hover:bg-hover aria-[current=page]:bg-hover aria-[current=page]:text-fg-strong"
    >
      {icon === undefined ? (
        <Avatar
          name={label}
          size="xs"
          square
          className="bg-elevated text-fg-dim group-aria-[current=page]/nav:border-accent group-aria-[current=page]/nav:text-accent"
        >
          {label.slice(0, 1).toUpperCase()}
        </Avatar>
      ) : (
        <span
          aria-hidden="true"
          className="grid size-6 place-items-center text-fg-dim group-aria-[current=page]/nav:text-accent"
        >
          <Icon name={icon} />
        </span>
      )}
      <span className="truncate">{label}</span>
      {count !== undefined && (
        <span className="ml-auto text-caption text-fg-dim tabular-nums">
          {count}
        </span>
      )}
    </a>
  );
}

// A sidebar's Session search: the button that opens it, and the field.
export function useSessionSearch(placeholder: string): {
  readonly query: string;
  readonly toggle: ReactElement;
  readonly field: ReactElement | null;
} {
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);

  const close = (): void => {
    setSearching(false);
    setQuery("");
  };

  return {
    query,
    toggle: (
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
    ),
    field: searching ? (
      <div className="px-3 pb-2">
        <TextInput
          type="search"
          aria-label="Search sessions"
          placeholder={placeholder}
          autoFocus
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              close();
            }
          }}
          className="w-full py-1 text-label"
        />
      </div>
    ) : null,
  };
}

// A plugin's own Sessions show inside the plugin, and in a sidebar only in a
// search or once the plugin is off (ADR 0028).
export function listedSessions(
  sessions: readonly Session[],
  query: string,
  environments: readonly Environment[],
): readonly Session[] {
  return sessions.filter(
    (session) =>
      (query !== "" || !ownedByEnabled(session)) &&
      matches(
        session,
        query,
        environments.find(({ id }) => id === session.environmentId)?.name ??
          session.provider,
      ),
  );
}

// A sidebar's Sessions, or why there are none.
export function SessionList({
  id,
  sessions,
  environments,
  searched,
  none,
  opened,
  who,
  link,
  className,
}: {
  readonly id: string;
  readonly sessions: readonly Session[];
  readonly environments: readonly Environment[];
  readonly searched: boolean;
  // What an empty list says when nothing was searched for.
  readonly none: string;
  readonly opened: string | undefined;
  readonly who?: (session: Session) => string | undefined;
  readonly link?: (session: Session) => string;
  readonly className?: string;
}): ReactElement {
  return (
    <ul id={id} className={className}>
      {sessions.length === 0 && (
        <li className="px-3 py-2 text-caption text-fg-dim">
          {searched ? "No sessions match." : none}
        </li>
      )}
      {sessions.map((session) => (
        <SidebarSession
          key={session.id}
          session={session}
          environment={environments.find(
            ({ id: each }) => each === session.environmentId,
          )}
          {...(who && { who: who(session) })}
          {...(link && { link: link(session) })}
          current={session.id === opened}
        />
      ))}
    </ul>
  );
}

export function SidebarSession({
  session,
  environment,
  who,
  link,
  current,
}: {
  readonly session: Session;
  readonly environment: Environment | undefined;
  // Who started it, in team work.
  readonly who?: string | undefined;
  readonly link?: string;
  readonly current: boolean;
}): ReactElement {
  const badge = sessionBadge(session);
  const now = useNow();

  return (
    <SessionRow
      id={session.id}
      href={link ?? sessionHref(session)}
      title={sessionTitle(session)}
      titleHint={workspaceName(session.workspace)}
      meta={sessionMeta(session, { environment, who, now, state: true })}
      current={current}
      leading={<StatusDot tone={badge?.state} />}
    />
  );
}

// What a Session row says under its title, wherever Sessions are listed.
// With state, it names the work state too, for a row that shows only a dot.
export function sessionMeta(
  session: Session,
  {
    environment,
    who,
    now,
    state = false,
  }: {
    readonly environment: Environment | undefined;
    // Who started it, in team work.
    readonly who?: string | undefined;
    readonly now: number;
    readonly state?: boolean;
  },
): string {
  const badge = state ? sessionBadge(session) : undefined;
  const team = who !== undefined;

  return [
    ...(team ? [who] : []),
    ...(session.plugin === null ? [] : [ownerLabel(session.plugin.id)]),
    ...(session.title === null ? [] : [shortName(session.workspace)]),
    environment?.name ?? session.provider,
    ...(badge ? [badge.label.toLowerCase()] : []),
    ...(!team && session.model ? [modelName(session.model)] : []),
    session.archivedAt === null ? ago(session.createdAt, now) : "archived",
  ].join(" · ");
}

// A Session's work state as a badge, for a row with room for one.
export function SessionState({
  session,
}: {
  readonly session: Session;
}): ReactElement | null {
  const badge = sessionBadge(session);

  return badge ? <Badge state={badge.state}>{badge.label}</Badge> : null;
}

// Who started a Session, as team lists name them.
export function useStartedBy(): (id: string | null) => string | undefined {
  const { user } = useMe();
  const people = useQuery("people.list").data ?? [];

  return (id) =>
    id === user.id ? "You" : people.find((person) => person.id === id)?.name;
}

function ownerLabel(plugin: string): string {
  const label =
    pageLabel(plugin) ?? plugin.charAt(0).toUpperCase() + plugin.slice(1);

  return `from ${label}`;
}

export function EnvironmentStatus({
  environments,
  before,
}: {
  readonly environments: readonly Environment[];
  // At the start of the row, such as who is here.
  readonly before?: ReactNode;
}): ReactElement {
  return (
    <div className="flex items-start gap-2 border-t border-line py-2.5 pr-2 pl-4">
      {before}
      <ul className="flex flex-1 flex-wrap gap-x-4 gap-y-1 pt-1 text-caption text-fg-dim">
        {environments.map((environment) => (
          <li key={environment.id} className="flex items-center gap-1.5">
            <StatusDot
              tone={
                availability(environment) === "Offline" ? "offline" : "done"
              }
            />
            {environment.name} {availability(environment).toLowerCase()}
          </li>
        ))}
      </ul>
      <ThemeSwitch />
    </div>
  );
}

export function NotifyButton(): ReactElement | null {
  const [permission, setPermission] = useState(() =>
    typeof Notification === "undefined" ? "denied" : Notification.permission,
  );

  if (permission !== "default") {
    return null;
  }

  return (
    <div className="border-t border-line px-2 py-2">
      <Button
        variant="ghost"
        onClick={() => {
          void Notification.requestPermission().then(setPermission);
        }}
        className="w-full justify-start text-label"
      >
        <Icon name="bell" />
        Notify me when sessions finish
      </Button>
    </div>
  );
}
