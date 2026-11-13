import {
  type Environment,
  isBusy,
  type Person,
  type Session,
} from "@pipoca/protocol";
import { Badge, Button, initialsOf, plural, Row, Rows } from "@pipoca/ui";
import type { ReactElement, ReactNode } from "react";
import { useNow } from "@pipoca/plugins/web";
import { AvailabilityBadge } from "../../shell/availability";
import { ago, sessionTitle } from "../../names";
import { sessionMeta, SessionState } from "../../shell/sidebar-parts";
import { kindName } from "../environments/kinds";

export function Doing({
  person,
  sessions,
}: {
  readonly person: Person;
  readonly sessions: readonly Session[];
}): ReactElement {
  const waiting = sessions.filter((session) => session.waiting).length;
  const running = sessions.filter(({ status }) => isBusy(status)).length;

  if (waiting > 0) {
    return (
      <Badge state="waiting">
        {waiting} {waiting === 1 ? "needs" : "need"} an answer
      </Badge>
    );
  }

  if (running > 0) {
    return <Badge state="working">{plural(running, "Session")}</Badge>;
  }

  if (person.settingUp) {
    return <Badge state="offline">Setting up</Badge>;
  }

  return <span className="text-label text-fg-dim">Idle</span>;
}

export function lastActive(at: string | null, now: number): string {
  if (at === null) {
    return "Never";
  }

  const said = ago(at, now);
  if (said === "just now") {
    return "Now";
  }

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);

  return now - Date.parse(at) >= 24 * 3_600_000 &&
    new Date(at).toDateString() === yesterday.toDateString()
    ? "Yesterday"
    : said;
}

// Everything of the person's an admin may stop, archive or delete.
export function Work({
  person,
  environments,
  sessions,
  onStop,
  onArchive,
  onDelete,
}: {
  readonly person: Person;
  readonly environments: readonly Environment[];
  readonly sessions: readonly Session[];
  readonly onStop: (session: Session) => void;
  readonly onArchive: (session: Session) => void;
  readonly onDelete: (environment: Environment) => void;
}): ReactNode {
  const now = useNow();

  if (environments.length === 0 && sessions.length === 0) {
    return (
      <p className="text-label text-fg-dim">
        {person.name} has no Environments or active Sessions.
      </p>
    );
  }

  return (
    <div aria-label={`${person.name}'s work`} className="flex flex-col gap-2.5">
      {environments.length > 0 && (
        <Rows label="Environments">
          {environments.map((environment) => (
            <Row
              key={environment.id}
              initials={initialsOf(environment.name)}
              title={
                <>
                  {environment.name}
                  <AvailabilityBadge environment={environment} />
                </>
              }
              description={kindName(environment)}
            >
              <Button
                variant="ghost"
                aria-label={`Delete ${environment.name}`}
                onClick={() => {
                  onDelete(environment);
                }}
              >
                Delete
              </Button>
            </Row>
          ))}
        </Rows>
      )}
      {sessions.length > 0 && (
        <Rows label="Sessions">
          {sessions.map((session) => (
            <Row
              key={session.id}
              title={sessionTitle(session)}
              description={sessionMeta(session, {
                environment: environments.find(
                  ({ id }) => id === session.environmentId,
                ),
                now,
              })}
            >
              <SessionState session={session} />
              {isBusy(session.status) && (
                <Button
                  variant="ghost"
                  onClick={() => {
                    onStop(session);
                  }}
                >
                  Stop
                </Button>
              )}
              <Button
                variant="ghost"
                onClick={() => {
                  onArchive(session);
                }}
              >
                Archive
              </Button>
            </Row>
          ))}
        </Rows>
      )}
    </div>
  );
}
