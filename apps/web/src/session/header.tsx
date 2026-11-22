import type { Environment, Session } from "@pipoca/protocol";
import { SessionPanelButton, SessionSection } from "@pipoca/plugins/web";
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
        "@container flex min-h-10 shrink-0 items-center gap-2 border-b border-line px-3",
        shown !== "chat" && "bg-term-bg",
      )}
    >
      {onMenu && (
        <span className="hidden drawer:contents">
          <Button
            variant="ghost"
            iconOnly
            aria-label="Open sessions"
            onClick={onMenu}
          >
            <Icon name="menu" />
          </Button>
        </span>
      )}
      <div className="flex min-w-16 flex-1 items-center gap-2">
        <h1 className="flex min-w-0 items-center gap-2 text-ui font-semibold text-fg-strong">
          {crumb}
          <span
            aria-hidden="true"
            className={cn(
              "size-2 shrink-0 rounded-full",
              dotClass(feed.session),
            )}
          />
          <span className="truncate">{title}</span>
        </h1>
        <span
          id={primary ? "status" : undefined}
          className="shrink-0 text-caption text-fg-dim max-sm:sr-only @max-lg:sr-only"
        >
          {statusText(feed)}
        </span>
      </div>
      {session && <StateBadge session={session} />}
      <SessionPanelButton />
      {primary && !archived && (
        <span className="@max-md:hidden">
          <ViewSwitch view={view} onChange={onView} />
        </span>
      )}
      {actions}
      {primary && menu}
    </header>
  );
}

function dotClass(session: Session | undefined): string {
  const badge = session && sessionBadge(session);

  switch (badge?.state) {
    case "working":
      return "bg-working motion-safe:animate-pulse";
    case "waiting":
      return "bg-waiting";
    case "failed":
      return "bg-failed";
    case "offline":
      return "bg-line-strong";
    case undefined:
      return session?.archivedAt === null ? "bg-done" : "bg-line-strong";
  }
}

function statusText({ missing, session }: Feed): string {
  if (missing) {
    return "session not found";
  }

  return session ? describe(session) : "";
}

// Where the Session runs and who opens it, as the panel's last section.
export function AboutSection({
  feed: { session },
  environments,
}: {
  readonly feed: Feed;
  readonly environments: readonly Environment[];
}): ReactElement | null {
  if (session === undefined) {
    return null;
  }

  return (
    <SessionSection
      name="about"
      order={90}
      label="About"
      icon="info"
      button="About this Session"
    >
      <p className="truncate font-mono text-caption">
        {sessionCrumb(session, environments)}
      </p>
      <p className="flex items-center gap-1.5 text-caption text-fg-dim">
        {session.access.kind !== "team" && (
          <Icon name="lock" className="size-3.5" />
        )}
        {`${describe(session)} · ${accessLabels[session.access.kind]}`}
      </p>
    </SessionSection>
  );
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

  return badge?.state === "waiting" || badge?.state === "failed" ? (
    <Badge state={badge.state}>{badge.label}</Badge>
  ) : null;
}
