import {
  availability,
  type Environment,
  kindOf,
  type Person,
  type Session,
} from "@pipoca/protocol";
import {
  Badge,
  Button,
  Icon,
  initialsOf,
  PageTitle,
  Row,
  Rows,
  Select,
} from "@pipoca/ui";
import { Fragment, type ReactElement, type ReactNode, useState } from "react";
import { api, command } from "./api";
import { ago } from "./chat";
import { deleteEnvironment, kindNames } from "./environments";
import { InviteDialog, InvitesTable, revoke } from "./invites";
import { NewcomersCard } from "./newcomers";
import {
  useEveryonesEnvironments,
  useEveryonesSessions,
  useInvites,
  useNow,
  usePeople,
} from "./hooks";
import { settingsPageClass } from "./page-class";

const busy = new Set(["queued", "starting", "running"]);

const headClass = "px-4 py-2.5 text-left text-caption font-medium text-fg-dim";
const cellClass = "border-t border-line px-4 py-3 align-middle";

// Who can use the server, and what an admin sees of their work: names and
// states, never transcripts, files or variable values (ADR 0049).
export function PeoplePage({ user }: { readonly user: string }): ReactElement {
  const people = usePeople();
  const environments = useEveryonesEnvironments();
  const sessions = useEveryonesSessions();
  const invites = useInvites();
  const [tab, setTab] = useState<"members" | "invites">("members");
  const [inviting, setInviting] = useState(false);
  const [editingNewcomers, setEditingNewcomers] = useState(false);
  const [open, setOpen] = useState<string>();
  const [error, setError] = useState<string>();

  const act = (run: Promise<unknown>): void => {
    run.then(
      () => {
        setError(undefined);
        sessions.reload();
        people.reload();
        invites.reload();
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

  const now = useNow();

  return (
    <div className={settingsPageClass}>
      <PageTitle
        description="Who can use this server. Admins see names and states, never transcripts, files or secret values."
        actions={
          <Button
            variant="primary"
            onClick={() => {
              setInviting(true);
            }}
          >
            <Icon name="plus" />
            Invite people
          </Button>
        }
      >
        People
      </PageTitle>
      <InviteDialog
        open={inviting}
        onClose={() => {
          setInviting(false);
          invites.reload();
        }}
        onChangeSetup={() => {
          setInviting(false);
          setEditingNewcomers(true);
        }}
      />
      <NewcomersCard
        editing={editingNewcomers}
        onEditing={setEditingNewcomers}
      />
      {error !== undefined && (
        <p role="alert" className="mb-3 text-caption text-failed">
          {error}
        </p>
      )}
      <div
        role="tablist"
        aria-label="People"
        className="mt-6 flex gap-1 border-b border-line"
      >
        {(
          [
            ["members", `Members · ${String(people.value.length)}`],
            ["invites", `Invites · ${String(invites.value.length)}`],
          ] as const
        ).map(([name, label]) => (
          <button
            key={name}
            type="button"
            role="tab"
            aria-selected={tab === name}
            onClick={() => {
              setTab(name);
            }}
            className="-mb-px cursor-pointer border-b-2 border-transparent px-3 py-2 text-ui text-fg-dim hover:text-fg aria-selected:border-fg-strong aria-selected:font-medium aria-selected:text-fg-strong"
          >
            {label}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        className="mt-1.5 overflow-x-auto rounded-lg border border-line bg-elevated shadow-xs"
      >
        {tab === "invites" && (
          <InvitesTable
            invites={invites.value}
            onRevoke={(invite) => {
              act(revoke(invite));
            }}
          />
        )}
        {tab === "members" && (
          <table className="w-full min-w-xl border-collapse text-ui">
            <thead>
              <tr>
                <th className={headClass}>Name</th>
                <th className={headClass}>Role</th>
                <th className={headClass}>Now</th>
                <th className={headClass}>Last active</th>
                <th className={headClass}>
                  <span className="sr-only">More</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {people.value.map((person) => {
                const theirs = sessions.value.filter(
                  (session) => personOf(session) === person.id,
                );

                const own = environments.value.filter(
                  ({ ownerId }) => ownerId === person.id,
                );

                return (
                  <Fragment key={person.id}>
                    <tr aria-label={person.name}>
                      <td className={cellClass}>
                        <span className="flex items-center gap-2.5">
                          <span
                            aria-hidden="true"
                            className="grid size-7 shrink-0 place-items-center rounded-full bg-hover text-caption font-semibold text-fg-strong"
                          >
                            {initialsOf(person.name)}
                          </span>
                          <span className="flex min-w-0 flex-col">
                            <span className="truncate text-fg-strong">
                              {person.name}
                            </span>
                            <span className="text-label text-fg-dim">
                              {[
                                person.name === user && "you",
                                person.settingUp && "setting up",
                              ]
                                .filter(Boolean)
                                .join(" · ")}
                            </span>
                          </span>
                        </span>
                      </td>
                      <td className={cellClass}>
                        <Select
                          aria-label={`Role of ${person.name}`}
                          className="w-32"
                          value={person.admin ? "admin" : "member"}
                          onChange={(event) => {
                            act(
                              api("people.update", {
                                params: { id: person.id },
                                body: {
                                  admin: event.target.value === "admin",
                                },
                              }),
                            );
                          }}
                        >
                          <option value="admin">Admin</option>
                          <option value="member">Member</option>
                        </Select>
                      </td>
                      <td className={cellClass}>
                        <Doing person={person} sessions={theirs} />
                      </td>
                      <td className={`${cellClass} text-label text-fg-dim`}>
                        {lastActive(person.lastActive, now)}
                      </td>
                      <td className={`${cellClass} w-11 text-right`}>
                        <Button
                          variant="ghost"
                          aria-label={`More for ${person.name}`}
                          aria-expanded={open === person.id}
                          onClick={() => {
                            setOpen(open === person.id ? undefined : person.id);
                          }}
                        >
                          ···
                        </Button>
                      </td>
                    </tr>
                    {open === person.id && (
                      <tr>
                        <td colSpan={5} className={`${cellClass} bg-panel`}>
                          <Work
                            person={person}
                            environments={own}
                            sessions={theirs}
                            onStop={(session) => {
                              act(command(session.id, { type: "abort" }));
                            }}
                            onArchive={(session) => {
                              act(
                                api("sessions.update", {
                                  params: { id: session.id },
                                  body: { archived: true },
                                }),
                              );
                            }}
                            onDelete={(environment) => {
                              act(
                                deleteEnvironment(environment).then(
                                  environments.reload,
                                ),
                              );
                            }}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function Doing({
  person,
  sessions,
}: {
  readonly person: Person;
  readonly sessions: readonly Session[];
}): ReactElement {
  const waiting = sessions.filter((session) => session.waiting).length;
  const running = sessions.filter(({ status }) => busy.has(status)).length;

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

function lastActive(at: string | null, now: number): string {
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
function Work({
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
  const environmentName = (id: string): string =>
    environments.find((each) => each.id === id)?.name ?? id;

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
  );
}

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? "" : "s"}`;
}
