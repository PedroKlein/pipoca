import type { Invite } from "@pipoca/protocol";
import { Badge, Button, Cell, Table } from "@pipoca/ui";
import type { ReactElement } from "react";
import { api } from "../../api";

export type Made = Invite & { readonly token: string };

export function linkOf(token: string): string {
  return `${location.origin}/#join/${token}`;
}

function dateOf(iso: string): string {
  return new Date(iso).toLocaleDateString([], {
    day: "numeric",
    month: "long",
  });
}

// Invites still waiting for someone, which an admin can revoke.
export function InvitesTable({
  invites,
  onRevoke,
}: {
  readonly invites: readonly Invite[];
  readonly onRevoke: (invite: Invite) => void;
}): ReactElement {
  if (invites.length === 0) {
    return (
      <p className="px-4 py-3.5 text-label text-fg-dim">
        No invites waiting. Invite people to send someone a link.
      </p>
    );
  }

  return (
    <Table
      bare
      columns={[
        "Invite",
        "Role",
        "Expires",
        <span key="revoke" className="sr-only">
          Revoke
        </span>,
      ]}
    >
      {invites.map((invite) => {
        const name = invite.email ?? "Link anyone can join with";

        return (
          <tr key={invite.id} aria-label={name}>
            <Cell>
              <span className="flex flex-col">
                <span className="text-fg-strong">{name}</span>
                {invite.email === null && (
                  <span className="text-label text-fg-dim">
                    {invite.uses === 1
                      ? "1 person joined"
                      : `${String(invite.uses)} people joined`}
                  </span>
                )}
              </span>
            </Cell>
            <Cell>
              <Badge state="offline">{invite.admin ? "Admin" : "Member"}</Badge>
            </Cell>
            <Cell className="text-label text-fg-dim">
              {dateOf(invite.expiresAt)}
            </Cell>
            <Cell className="text-right">
              <Button
                variant="ghost"
                aria-label={`Revoke ${name}`}
                onClick={() => {
                  onRevoke(invite);
                }}
              >
                Revoke
              </Button>
            </Cell>
          </tr>
        );
      })}
    </Table>
  );
}

export async function revoke(invite: Invite): Promise<void> {
  await api("invites.remove", { params: { id: invite.id } });
}
