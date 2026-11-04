import type { Session } from "@pipoca/protocol";
import {
  Badge,
  Icon,
  type IconName,
  PageTitle,
  Row,
  Rows,
  Section,
} from "@pipoca/ui";
import type { ReactElement, ReactNode } from "react";
import { useNow, useTeamSessions } from "./hooks";
import { ago, sessionBadge, shortName } from "./names";
import { settingsPageClass } from "./page-class";

interface Entry {
  readonly path: string;
  readonly label: string;
  readonly icon: IconName;
}

const entries: readonly Entry[] = [
  { path: "team", label: "Home", icon: "home" },
  { path: "team/sessions", label: "Sessions", icon: "menu" },
];

const busy = new Set<Session["status"]>(["queued", "starting", "running"]);

export function isTeamRoute(route: string): boolean {
  return /^team(\/|$)/.test(route);
}

// The team's own area, apart from a person's work, with its own menu
// (ADR 0065).
export function TeamHub({ route }: { readonly route: string }): ReactElement {
  const sessions = useTeamSessions();

  return (
    <div className="flex min-h-0 flex-1 max-md:flex-col">
      <nav
        aria-label="Team"
        className="flex w-62 shrink-0 flex-col gap-px border-r border-line bg-panel px-3 pt-4 pb-6 max-md:w-full max-md:flex-row max-md:flex-wrap max-md:items-center max-md:border-r-0 max-md:border-b max-md:py-2"
      >
        <a
          href="#"
          className="mb-2.5 flex items-center gap-2 rounded-md px-2.5 py-1.5 text-label text-fg-dim hover:bg-hover max-md:mb-0"
        >
          <Icon name="chevron-left" />
          My work
        </a>
        <h2 className="px-2.5 pt-0.5 pb-2 font-serif text-wordmark font-light text-fg-strong max-md:hidden">
          Team
        </h2>
        {entries.map(({ path, label, icon }) => (
          <a
            key={path}
            href={`#${path}`}
            aria-current={route === path ? "page" : undefined}
            className="flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-ui text-fg hover:bg-hover aria-[current=page]:bg-hover aria-[current=page]:font-medium aria-[current=page]:text-fg-strong"
          >
            <Icon name={icon} />
            {label}
          </a>
        ))}
      </nav>
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        {route === "team/sessions" ? (
          <TeamSessions sessions={sessions.value} />
        ) : (
          <TeamHome sessions={sessions.value} />
        )}
      </div>
    </div>
  );
}

function TeamHome({
  sessions,
}: {
  readonly sessions: readonly Session[];
}): ReactElement {
  const waiting = sessions.filter(({ waiting: asks }) => asks);

  const running = sessions.filter(
    ({ status, waiting: asks }) => !asks && busy.has(status),
  );

  return (
    <div className={settingsPageClass}>
      <PageTitle description="What the team is working on now. Team work runs on the team's Profiles, Environments and keys.">
        Team home
      </PageTitle>
      <Section title="Needs someone" description="Any of you can pick these up">
        <SessionRows
          sessions={waiting}
          empty="Nothing is waiting on the team."
        />
      </Section>
      <Section title="Running now">
        <SessionRows sessions={running} empty="No team work is running." />
      </Section>
    </div>
  );
}

function TeamSessions({
  sessions,
}: {
  readonly sessions: readonly Session[];
}): ReactElement {
  return (
    <div className={settingsPageClass}>
      <PageTitle description="Every Session the team has, newest first. Anyone on the team can open one.">
        Sessions
      </PageTitle>
      <SessionRows sessions={sessions} empty="The team has no Sessions yet." />
    </div>
  );
}

function SessionRows({
  sessions,
  empty,
}: {
  readonly sessions: readonly Session[];
  readonly empty: ReactNode;
}): ReactElement {
  const now = useNow();

  if (sessions.length === 0) {
    return <p className="text-label text-fg-dim">{empty}</p>;
  }

  return (
    <Rows>
      {sessions.map((session) => {
        const badge = sessionBadge(session);

        return (
          <Row
            key={session.id}
            title={
              <a
                href={`#${session.id}`}
                className="hover:underline focus-visible:underline"
              >
                {session.title ?? shortName(session.workspace)}
              </a>
            }
            description={`${shortName(session.workspace)} · ${ago(session.createdAt, now)}`}
          >
            {badge && <Badge state={badge.state}>{badge.label}</Badge>}
          </Row>
        );
      })}
    </Rows>
  );
}
