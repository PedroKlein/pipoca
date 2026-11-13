import { ThemeSwitch } from "../theme";
import { availability, type Environment, type Session } from "@pipoca/protocol";
import { Button, Icon, SessionRow, StatusDot } from "@pipoca/ui";
import { type ReactElement, useState } from "react";
import { useNow } from "@pipoca/plugins/web";
import {
  ago,
  modelName,
  sessionBadge,
  shortName,
  workspaceName,
} from "../names";
import { enabledPlugins, pageLabel, sessionHref } from "../plugins";

export function ownedByEnabled({ plugin }: Session): boolean {
  return (
    plugin !== null &&
    enabledPlugins().some((part) => part.plugin.id === plugin.id)
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

  const meta = [
    ...(who === undefined ? [] : [who]),
    ...(session.plugin === null ? [] : [ownerLabel(session.plugin.id)]),
    ...(session.title === null ? [] : [shortName(session.workspace)]),
    environment?.name ?? session.provider,
    ...(session.model ? [modelName(session.model)] : []),
    session.archivedAt === null ? ago(session.createdAt, now) : "archived",
  ].join(" · ");

  return (
    <SessionRow
      id={session.id}
      href={link ?? sessionHref(session)}
      title={session.title ?? shortName(session.workspace)}
      titleHint={workspaceName(session.workspace)}
      meta={meta}
      current={current}
      {...(badge && { badge })}
    />
  );
}

function ownerLabel(plugin: string): string {
  const label =
    pageLabel(plugin) ?? plugin.charAt(0).toUpperCase() + plugin.slice(1);

  return `from ${label}`;
}

export function EnvironmentStatus({
  environments,
}: {
  readonly environments: readonly Environment[];
}): ReactElement {
  return (
    <div className="flex items-start gap-2 border-t border-line py-2.5 pr-2 pl-4">
      <ul className="flex flex-1 flex-wrap gap-x-4 gap-y-1 pt-1 text-caption text-fg-dim">
        {environments.map((environment) => (
          <li key={environment.id} className="flex items-center gap-1.5">
            <StatusDot
              tone={
                availability(environment) === "Offline" ? "offline" : "done"
              }
            />
            {environment.name}{" "}
            {availability(environment) === "Starts runners on demand"
              ? "on demand"
              : availability(environment).toLowerCase()}
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
