import type { Invite } from "@pipoca/protocol";
import { Badge, Button, Cell, cn, CopyButton, Dialog, ErrorText, Icon, Segmented, Select, Table } from "@pipoca/ui";
import { type ClipboardEvent, type KeyboardEvent, type ReactElement, useState } from "react";
import { api, send } from "./api";
import { TheirSetup } from "./newcomers";

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
                <Badge state="offline">
                  {invite.admin ? "Admin" : "Member"}
                </Badge>
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

export async function revoke(invite: Invite): Promise<Response> {
  return await send(`/api/invites/${encodeURIComponent(invite.id)}`, "DELETE");
}

const emailPattern = /^[^\s@]+@[^\s@]+$/;

// Admins invite people by email, or make a link to share (ADR 0063).
export function InviteDialog({
  open,
  onClose,
  onChangeSetup,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onChangeSetup: () => void;
}): ReactElement {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      labelledBy="invite-title"
      size="md"
    >
      <InviteForm onClose={onClose} onChangeSetup={onChangeSetup} />
    </Dialog>
  );
}

function InviteForm({
  onClose,
  onChangeSetup,
}: {
  readonly onClose: () => void;
  readonly onChangeSetup: () => void;
}): ReactElement {
  const [emails, setEmails] = useState<readonly string[]>([]);
  const [typed, setTyped] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");
  const [days, setDays] = useState("7");
  const [link, setLink] = useState<string>();
  const [sent, setSent] = useState<readonly Made[]>();
  const [error, setError] = useState<string>();

  const add = (text: string): void => {
    const found = text
      .split(/[\s,;]+/)
      .map((each) => each.trim().toLowerCase())
      .filter((each) => each !== "");

    const bad = found.find((each) => !emailPattern.test(each));
    setError(bad === undefined ? undefined : `${bad} isn't an email address`);

    setEmails([
      ...new Set([
        ...emails,
        ...found.filter((each) => emailPattern.test(each)),
      ]),
    ]);

    setTyped(bad ?? "");
  };

  const make = async (list: readonly string[]): Promise<readonly Made[]> =>
    (await (
      await api("/api/invites", {
        emails: list,
        admin: role === "admin",
        days: Number(days),
      })
    ).json()) as Made[];

  const failed = (reason: unknown): void => {
    setError(reason instanceof Error ? reason.message : String(reason));
  };

  const pending = typed.trim() === "" ? [] : [typed];
  const count = emails.length + pending.length;

  return (
    <div className="flex flex-col">
      <header className="flex items-start gap-2 px-6 pt-5 pb-2">
        <div className="flex flex-1 flex-col gap-1">
          <h2
            id="invite-title"
            className="text-prose font-semibold text-fg-strong"
          >
            Invite people
          </h2>
          <p className="text-label text-fg-dim">
            They join with their link and land in a short setup of their own.
          </p>
        </div>
        <Button variant="ghost" iconOnly aria-label="Close" onClick={onClose}>
          <Icon name="x" />
        </Button>
      </header>
      <div className="flex flex-col gap-5 px-6 py-4">
        {sent === undefined ? (
          <>
            <label className="flex flex-col gap-1.5">
              <span className="text-label font-medium text-fg">
                Email addresses
              </span>
              <span className="flex min-h-11 flex-wrap items-center gap-1.5 rounded-md border border-line bg-elevated px-2 py-1.5 focus-within:border-line-strong">
                {emails.map((email) => (
                  <span
                    key={email}
                    className="inline-flex h-7 items-center gap-1 rounded-full border border-line pr-1 pl-2.5 text-label text-fg"
                  >
                    {email}
                    <button
                      type="button"
                      aria-label={`Remove ${email}`}
                      className="grid size-5 cursor-pointer place-items-center rounded-full text-fg-dim hover:bg-hover"
                      onClick={() => {
                        setEmails(emails.filter((each) => each !== email));
                      }}
                    >
                      <Icon name="x" />
                    </button>
                  </span>
                ))}
                <input
                  value={typed}
                  aria-label="Email addresses"
                  placeholder={
                    emails.length === 0
                      ? "name@example.com"
                      : "Add more, or paste a list"
                  }
                  className="h-7 min-w-40 flex-1 bg-transparent text-ui outline-none"
                  onChange={(event) => {
                    setTyped(event.target.value);
                  }}
                  onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
                    if (["Enter", ",", " ", ";"].includes(event.key)) {
                      event.preventDefault();
                      add(typed);
                    }
                  }}
                  onPaste={(event: ClipboardEvent<HTMLInputElement>) => {
                    event.preventDefault();
                    add(`${typed} ${event.clipboardData.getData("text")}`);
                  }}
                  onBlur={() => {
                    if (typed.trim() !== "") {
                      add(typed);
                    }
                  }}
                />
              </span>
            </label>
            <div className="flex flex-col gap-1.5">
              <span className="text-label font-medium text-fg">As</span>
              <Segmented
                label="Invite as"
                value={role}
                onChange={setRole}
                options={[
                  { value: "member", label: "Members" },
                  { value: "admin", label: "Admins" },
                ]}
              />
            </div>
            <TheirSetup onChange={onChangeSetup} />
            <div className="flex flex-col gap-1.5">
              <span className="text-label font-medium text-fg">
                Or share a link
              </span>
              <div className="flex items-center gap-2 rounded-md bg-hover p-1.5 pl-3">
                <span
                  aria-label="Invite link"
                  className={cn(
                    "min-w-0 flex-1 truncate font-mono text-mono-sm",
                    link === undefined ? "text-fg-dim" : "text-fg",
                  )}
                >
                  {link ?? "Anyone with the link can join"}
                </span>
                <Select
                  aria-label="Expires after"
                  className="w-28"
                  value={days}
                  disabled={link !== undefined}
                  onChange={(event) => {
                    setDays(event.target.value);
                  }}
                >
                  <option value="1">1 day</option>
                  <option value="7">7 days</option>
                  <option value="30">30 days</option>
                </Select>
                {link === undefined ? (
                  <Button
                    onClick={() => {
                      make([]).then(([made]) => {
                        setLink(made && linkOf(made.token));
                      }, failed);
                    }}
                  >
                    Make a link
                  </Button>
                ) : (
                  <CopyButton text={link} />
                )}
              </div>
            </div>
          </>
        ) : (
          <ul aria-label="Invite links" className="flex flex-col gap-2">
            {sent.map((made) => (
              <li
                key={made.id}
                className="flex items-center gap-2 rounded-md bg-hover p-1.5 pl-3"
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-label text-fg-strong">
                    {made.email}
                  </span>
                  <span className="truncate font-mono text-mono-sm text-fg-dim">
                    {linkOf(made.token)}
                  </span>
                </span>
                <CopyButton text={linkOf(made.token)} />
              </li>
            ))}
          </ul>
        )}
        <ErrorText size="caption">{error}</ErrorText>
      </div>
      <footer className="flex flex-wrap items-center gap-2 border-t border-line px-6 py-4">
        <span className="flex-1 text-caption text-fg-dim">
          {sent === undefined
            ? "Each person gets a link of their own to sign in with."
            : "Each link works once. A mailbox you send from emails it too."}
        </span>
        <Button variant="ghost" onClick={onClose}>
          {sent === undefined ? "Cancel" : "Done"}
        </Button>
        {sent === undefined && (
          <Button
            variant="primary"
            disabled={count === 0}
            onClick={() => {
              const all = [...emails, ...pending]
                .map((each) => each.trim().toLowerCase())
                .filter((each) => emailPattern.test(each));

              make(all).then(setSent, failed);
            }}
          >
            {count === 1 ? "Invite 1 person" : `Invite ${String(count)} people`}
          </Button>
        )}
      </footer>
    </div>
  );
}
