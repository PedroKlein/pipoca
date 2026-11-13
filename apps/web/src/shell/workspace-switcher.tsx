import type { Session } from "@pipoca/protocol";
import { Avatar, Icon, Menu, plural } from "@pipoca/ui";
import { type ReactElement, useEffect } from "react";
import { useMe, useQuery } from "../data/hooks";
import { sessionBadge } from "../names";
import { href, navigate } from "../router";

const mac =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.userAgent);

function shortcut(key: string): string {
  return mac ? `⌘${key}` : `Ctrl ${key}`;
}

function summary(sessions: readonly Session[] | undefined): string {
  const badges = (sessions ?? []).map(sessionBadge);
  const running = badges.filter((badge) => badge?.state === "working").length;
  const waiting = badges.filter((badge) => badge?.state === "waiting").length;

  if (running === 0 && waiting === 0) {
    return "nothing running";
  }

  return [
    ...(running > 0 ? [`${String(running)} running`] : []),
    ...(waiting > 0 ? [`${String(waiting)} needs someone`] : []),
  ].join(", ");
}

export function TeamMark({
  name,
  size = "md",
}: {
  readonly name: string;
  readonly size?: "sm" | "md";
}): ReactElement {
  return (
    <span
      aria-hidden="true"
      className={
        size === "md"
          ? "grid size-8 shrink-0 place-items-center rounded-md bg-butter text-label font-semibold text-on-butter"
          : "grid size-6 shrink-0 place-items-center rounded-md bg-butter text-caption font-semibold text-on-butter"
      }
    >
      {Array.from(name)[0]?.toUpperCase()}
    </span>
  );
}

function PersonMark({
  name,
  size = "md",
}: {
  readonly name: string;
  readonly size?: "sm" | "md";
}): ReactElement {
  return (
    <Avatar
      name={name}
      size={size === "md" ? "sm" : "xs"}
      square
      className="bg-accent-tint text-accent"
    >
      {Array.from(name)[0]?.toUpperCase()}
    </Avatar>
  );
}

// Where the wordmark is, on a server with a team: switches between the
// person's own workspace and the team's, also with ⌘1 and ⌘2.
export function WorkspaceSwitcher({
  inTeam,
}: {
  readonly inTeam: boolean;
}): ReactElement {
  const { user } = useMe();
  const team = useQuery("settings.team").data?.name ?? "Team";
  const people = useQuery("people.list").data;

  const own = useQuery("sessions.list", {
    query: { archived: false, plugins: true },
  }).data;

  const teams = useQuery("sessions.list", { query: { scope: "team" } }).data;

  useEffect(() => {
    const switchOn = (event: KeyboardEvent): void => {
      if (
        !(mac ? event.metaKey : event.ctrlKey) ||
        event.altKey ||
        event.shiftKey ||
        (event.key !== "1" && event.key !== "2")
      ) {
        return;
      }

      event.preventDefault();
      navigate(href(event.key === "1" ? "home" : "team"));
    };

    document.addEventListener("keydown", switchOn);

    return () => {
      document.removeEventListener("keydown", switchOn);
    };
  }, []);

  const detail = inTeam
    ? `Team workspace${people === undefined ? "" : ` · ${plural(people.length, "person", "people")}`}`
    : "Your workspace";

  return (
    <Menu
      label="Switch workspace"
      align="start"
      className="min-w-0 flex-1"
      triggerClassName="h-auto w-full justify-start gap-2.5 px-1.5 py-1 text-left"
      trigger={
        <>
          {inTeam ? <TeamMark name={team} /> : <PersonMark name={user.name} />}
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-ui font-medium text-fg-strong">
              {inTeam ? team : user.name}
            </span>
            <span className="truncate text-caption text-fg-dim">{detail}</span>
          </span>
          <Icon name="chevron-down" className="size-3 shrink-0 text-fg-dim" />
        </>
      }
      items={[
        {
          label: user.name,
          description: `Your workspace · ${summary(own)}`,
          mark: <PersonMark name={user.name} size="sm" />,
          shortcut: shortcut("1"),
          checked: !inTeam,
          run: () => {
            navigate(href("home"));
          },
        },
        {
          label: team,
          description: `Team workspace · ${summary(teams)}`,
          mark: <TeamMark name={team} size="sm" />,
          shortcut: shortcut("2"),
          checked: inTeam,
          run: () => {
            navigate(href("team"));
          },
        },
      ]}
    />
  );
}
