import type { Environment, Session } from "@pipoca/protocol";
import { Badge, Button, cn, Icon } from "@pipoca/ui";
import type { ReactElement, ReactNode } from "react";
import { describe, sessionBadge, workspaceName } from "../names";
import type { Feed } from "./feed";
import { accessLabels } from "./team-access";
import { type View, ViewSwitch } from "./view-switch";

export function Header({
  primary,
  shown,
  feed,
  title,
  crumb,
  environments,
  pluginHeaders,
  archived,
  view,
  onView,
  onMenu,
  actions,
  menu,
}: {
  readonly primary: boolean;
  readonly shown: View;
  readonly feed: Feed;
  readonly title: string;
  readonly crumb: ReactNode;
  readonly environments: readonly Environment[];
  readonly pluginHeaders: ReactNode;
  readonly archived: boolean;
  readonly view: View;
  readonly onView: (view: View) => void;
  readonly onMenu: (() => void) | undefined;
  readonly actions: ReactNode;
  readonly menu: ReactNode;
}): ReactElement {
  const { session } = feed;

  return (
    <header
      className={cn(
        "flex min-h-14 flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-4 py-2",
        shown !== "chat" && "bg-term-bg",
      )}
    >
      {onMenu && (
        <Button
          variant="ghost"
          iconOnly
          aria-label="Open sessions"
          onClick={onMenu}
          className="md:hidden"
        >
          <Icon name="menu" />
        </Button>
      )}
      <div
        className={cn(
          "flex min-w-0 flex-col",
          primary ? "flex-[1_1_240px]" : "flex-[1_1_160px]",
        )}
      >
        <h1 className="flex min-w-0 items-center gap-1.5 text-title font-semibold text-fg-strong">
          {crumb}
          <span className="truncate">{title}</span>
        </h1>
        <p className="flex min-w-0 items-center gap-2 text-caption text-fg-dim">
          <span className="truncate font-mono">
            {session ? sessionCrumb(session, environments) : ""}
          </span>
          <span aria-hidden="true">·</span>
          <span id={primary ? "status" : undefined} className="shrink-0">
            {statusText(feed)}
          </span>
        </p>
      </div>
      {session && <StateBadge session={session} />}
      {session && session.access.kind !== "team" && (
        <span className="inline-flex shrink-0 items-center gap-1 text-caption text-fg-dim">
          <Icon name="lock" className="size-3.5" />
          {accessLabels[session.access.kind]}
        </span>
      )}
      <span
        id={primary ? "plugin-header" : undefined}
        className="flex items-center gap-2 text-caption text-fg-dim"
      >
        {pluginHeaders}
      </span>
      {!archived && <ViewSwitch view={view} onChange={onView} />}
      {actions}
      {menu}
    </header>
  );
}

function statusText({ missing, session }: Feed): string {
  if (missing) {
    return "session not found";
  }

  return session ? describe(session) : "";
}

function sessionCrumb(
  session: Session,
  environments: readonly Environment[],
): string {
  return [
    environments.find((e) => e.id === session.environmentId)?.name ??
      session.provider,
    workspaceName(session.workspace),
  ].join(" · ");
}

function StateBadge({
  session,
}: {
  readonly session: Session;
}): ReactElement | null {
  const badge = sessionBadge(session);

  return badge ? <Badge state={badge.state}>{badge.label}</Badge> : null;
}
