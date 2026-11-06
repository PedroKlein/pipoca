import { useNow } from "@pipoca/plugins/web";
import type { Person, Session } from "@pipoca/protocol";
import {
  Avatar,
  Button,
  Card,
  Cell,
  ErrorText,
  Icon,
  Page,
  Select,
  Table,
  Tabs,
  useConfirm,
} from "@pipoca/ui";
import { Fragment, type ReactElement, useState } from "react";
import { command, request } from "../../data/client";
import { useAction, useMe, useQuery } from "../../data/hooks";
import { deleteEnvironment } from "../environments/values";
import { InviteDialog } from "./invite-dialog";
import { InvitesTable, revoke } from "./invites";
import { NewcomersCard } from "./newcomers";
import { Doing, lastActive, Work } from "./work";

// Who can use the server, and what an admin sees of their work: names and
// states, never transcripts, files or variable values (ADR 0049).
export function PeoplePage(): ReactElement {
  const user = useMe().user.name;

  // Their outline changes as runners and Sessions come and go.
  const people = (
    useQuery("people.list", undefined, {
      topics: ["environments", "sessions"],
    }).data ?? []
  ).map((person): Person => ({
    ...person,
    admin: person.admin ?? false,
    settingUp: person.settingUp ?? false,
    lastActive: person.lastActive ?? null,
  }));

  const all = { query: { scope: "all" } } as const;
  const environments = useQuery("environments.list", all).data ?? [];

  const sessions =
    useQuery("sessions.list", {
      query: { scope: "all", archived: false, plugins: true },
    }).data ?? [];

  const invites = useQuery("invites.list").data ?? [];
  const [tab, setTab] = useState<"members" | "invites">("members");
  const [inviting, setInviting] = useState(false);
  const [editingNewcomers, setEditingNewcomers] = useState(false);
  const [open, setOpen] = useState<string>();
  const [ask, asking] = useConfirm();
  const action = useAction(async (work: Promise<unknown>) => work);
  const error = action.error;

  const act = (work: Promise<unknown>): void => {
    void action.run(work);
  };

  const personOf = (session: Session): string | null =>
    session.startedBy ??
    environments.find(({ id }) => id === session.environmentId)?.ownerId ??
    null;

  const now = useNow();

  return (
    <Page
      title="People"
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
      <InviteDialog
        open={inviting}
        onClose={() => {
          setInviting(false);
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
            label: `Members · ${String(people.length)}`,
          },
          {
            value: "invites",
            label: `Invites · ${String(invites.length)}`,
          },
        ]}
      />
      <Card
        role="tabpanel"
        padding="none"
        className="relative mt-1.5 overflow-x-auto"
      >
        {tab === "invites" && (
          <InvitesTable
            invites={invites}
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
            {people.map((person) => {
              const theirs = sessions.filter(
                (session) => personOf(session) === person.id,
              );

              const own = environments.filter(
                ({ ownerId }) => ownerId === person.id,
              );

              return (
                <Fragment key={person.id}>
                  <tr aria-label={person.name}>
                    <Cell>
                      <span className="flex items-center gap-2.5">
                        <Avatar name={person.name} />
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
                            request("people.update", {
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
                              request("sessions.update", {
                                params: { id: session.id },
                                body: { archived: true },
                              }),
                            );
                          }}
                          onDelete={(environment) => {
                            act(deleteEnvironment(environment, ask));
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
