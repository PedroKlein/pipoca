import {
  availability,
  type Environment,
  kindOf,
  type Session,
} from "@pipoca/protocol";
import {
  Badge,
  Button,
  initialsOf,
  PageTitle,
  Row,
  Rows,
  Section,
} from "@pipoca/ui";
import { type ReactElement, useState } from "react";
import { api, command } from "./api";
import { deleteEnvironment, kindNames } from "./environments";
import {
  type Person,
  useEveryonesEnvironments,
  useEveryonesSessions,
  usePeople,
} from "./hooks";
import { settingsPageClass } from "./page-class";

const busy = new Set(["queued", "starting", "running"]);

// What an admin sees of everyone's work: names and states, never
// transcripts, files or variable values (ADR 0049).
export function PeoplePage(): ReactElement {
  const people = usePeople();
  const environments = useEveryonesEnvironments();
  const sessions = useEveryonesSessions();
  const [error, setError] = useState<string>();

  const act = (run: Promise<unknown>): void => {
    run.then(
      () => {
        setError(undefined);
        sessions.reload();
      },
      (reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
  };

  const personOf = (session: Session): string | null =>
    session.startedBy ??
    environments.value.find(({ id }) => id === session.environmentId)
      ?.ownerId ??
    null;

  return (
    <div className={settingsPageClass}>
      <PageTitle description="Everyone's Environments and running Sessions, as admins see them: names and states, never transcripts, files or variable values. Admins can stop or archive a Session, and delete an Environment once its Sessions are archived.">
        People
      </PageTitle>
      {error !== undefined && (
        <p role="alert" className="text-caption text-failed">
          {error}
        </p>
      )}
      {people.value.map((person) => (
        <PersonSection
          key={person.id}
          person={person}
          environments={environments.value.filter(
            ({ ownerId }) => ownerId === person.id,
          )}
          sessions={sessions.value.filter(
            (session) => personOf(session) === person.id,
          )}
          onStop={(session) => {
            act(command(session.id, { type: "abort" }));
          }}
          onDelete={(environment) => {
            act(deleteEnvironment(environment).then(environments.reload));
          }}
          onArchive={(session) => {
            act(
              api(
                `/api/sessions/${encodeURIComponent(session.id)}/archive`,
                {},
              ),
            );
          }}
        />
      ))}
    </div>
  );
}

function PersonSection({
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
}): ReactElement {
  const environmentName = (id: string): string =>
    environments.find((each) => each.id === id)?.name ?? id;

  return (
    <Section
      title={
        <span className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="grid size-7 place-items-center rounded-full bg-hover text-label font-semibold text-fg-strong"
          >
            {initialsOf(person.name)}
          </span>
          {person.name}
          {person.admin && <Badge state="offline">Admin</Badge>}
        </span>
      }
      description={`${plural(environments.length, "Environment")} · ${plural(sessions.length, "active Session")}`}
    >
      <div aria-label={person.name} className="flex flex-col gap-2.5">
        {environments.length > 0 && (
          <Rows label="Environments">
            {environments.map((environment) => (
              <Row
                key={environment.id}
                initials={initialsOf(environment.name)}
                title={
                  <>
                    {environment.name}
                    <Badge
                      state={
                        availability(environment) === "Offline"
                          ? "offline"
                          : "done"
                      }
                    >
                      {availability(environment) === "Starts runners on demand"
                        ? "On demand"
                        : availability(environment)}
                    </Badge>
                  </>
                }
                description={kindNames[kindOf(environment)]}
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
                title={session.title ?? "Untitled Session"}
                description={`${environmentName(session.environmentId)} · ${session.status}`}
              >
                {busy.has(session.status) && (
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
    </Section>
  );
}

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? "" : "s"}`;
}
