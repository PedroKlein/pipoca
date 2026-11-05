import { useNow } from "@pipoca/plugins/web";
import type { Session } from "@pipoca/protocol";
import {
  Button,
  Card,
  Cell,
  ErrorText,
  Icon,
  initialsOf,
  Page,
  PageTitle,
  Select,
  Table,
  Tabs,
  useConfirm,
} from "@pipoca/ui";
import { Fragment, type ReactElement, useState } from "react";
import { api, command } from "../../api";
import { deleteEnvironment } from "../environments/values";
import { InviteDialog } from "./invite-dialog";
import { InvitesTable, revoke } from "./invites";
import { NewcomersCard } from "./newcomers";
import {
  useEveryonesEnvironments,
  useEveryonesSessions,
  useInvites,
  usePeople,
} from "../../hooks";
import { Doing, lastActive, Work } from "./work";

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
  const [ask, asking] = useConfirm();

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
    <Page>
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
      <ErrorText size="caption" className="mb-3">
        {error}
      </ErrorText>
      <Tabs
        label="People"
        className="mt-6"
        value={tab}
        onSelect={setTab}
        tabs={[
          {
            value: "members",
            label: `Members · ${String(people.value.length)}`,
          },
          {
            value: "invites",
            label: `Invites · ${String(invites.value.length)}`,
          },
        ]}
      />
      <Card role="tabpanel" padding="none" className="mt-1.5 overflow-x-auto">
        {tab === "invites" && (
          <InvitesTable
            invites={invites.value}
            onRevoke={(invite) => {
              act(revoke(invite));
            }}
          />
        )}
        {tab === "members" && (
          <Table
            bare
            columns={[
              "Name",
              "Role",
              "Now",
              "Last active",
              <span key="more" className="sr-only">
                More
              </span>,
            ]}
          >
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
                    <Cell>
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
                    </Cell>
                    <Cell>
                      <Select
                        aria-label={`Role of ${person.name}`}
                        className="w-32"
                        value={person.admin ? "admin" : "member"}
                        onChange={(event) => {
                          act(
                            api("people.update", {
                              params: { id: person.id },
                              body: { admin: event.target.value === "admin" },
                            }),
                          );
                        }}
                      >
                        <option value="admin">Admin</option>
                        <option value="member">Member</option>
                      </Select>
                    </Cell>
                    <Cell>
                      <Doing person={person} sessions={theirs} />
                    </Cell>
                    <Cell className="text-label text-fg-dim">
                      {lastActive(person.lastActive, now)}
                    </Cell>
                    <Cell className="w-11 text-right">
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
                    </Cell>
                  </tr>
                  {open === person.id && (
                    <tr>
                      <Cell colSpan={5} className="bg-panel">
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
                              deleteEnvironment(environment, ask).then(
                                environments.reload,
                              ),
                            );
                          }}
                        />
                      </Cell>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </Table>
        )}
      </Card>
      {asking}
    </Page>
  );
}
