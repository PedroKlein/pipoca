import {
  BadRequest,
  NotFound,
  readBody,
  requireAdmin,
  type ServerPlugin,
  Type,
} from "@pipoca/plugins";
import { check, MailRefused, send, verify, type Mail } from "./mail";
import { type Mailbox, mailboxStore } from "./mailboxes";
import type { Account, MailboxView } from "./model";

const server = Type.Object({
  host: Type.String({ minLength: 1 }),
  port: Type.Integer({ minimum: 1, maximum: 65_535 }),
  secure: Type.Boolean(),
});

const newMailbox = Type.Object({
  name: Type.String(),
  address: Type.String({ minLength: 3 }),
  user: Type.String({ minLength: 1 }),
  password: Type.String({ minLength: 1 }),
  imap: server,
  smtp: server,
});

interface State {
  readonly uid_validity: string;
  readonly last_uid: number;
}

// New mail as routine triggers, and Sessions that send from a mailbox, with
// replies to what they sent coming back to them (ADR 0062).
const schema = `
create table email_state (
  mailbox text primary key,
  uid_validity text not null,
  last_uid integer not null
) strict;

create table email_threads (
  mailbox text not null,
  message_id text not null,
  session_id text not null references sessions (id) on delete cascade,
  primary key (mailbox, message_id)
) strict, without rowid;
create index email_threads_session on email_threads (session_id);
`;

export const email: ServerPlugin = {
  name: "email",
  schema: { version: 1, sql: schema },
  register: (context) => {
    const mailboxes = mailboxStore(context.config, context.store, context.log);

    const errors = new Map<string, string>();

    const sessionOf = (
      mailbox: string,
      messageId: string,
    ): string | undefined =>
      (
        context.store.all(
          "select session_id from email_threads where mailbox = ? and message_id = ?",
          mailbox,
          messageId,
        ) as { session_id: string }[]
      )[0]?.session_id;

    // A reply to mail a Session sent goes to that Session. Other mail is an
    // event.
    const received = (mailbox: Mailbox, mail: Mail): void => {
      const sessionId =
        mail.inReplyTo === ""
          ? undefined
          : sessionOf(mailbox.name, mail.inReplyTo);

      if (sessionId !== undefined) {
        context.store.run(
          "insert into email_threads (mailbox, message_id, session_id) values (?, ?, ?) on conflict do nothing",
          mailbox.name,
          mail.messageId,
          sessionId,
        );

        const sent = context.sessions.send(
          sessionId,
          `A reply to the mail you sent from ${mailbox.address}, from ${mail.from}, subject “${mail.subject}” (Message-ID ${mail.messageId}):\n\n${mail.text}`,
          "plugin:email",
          { kind: "email_reply", data: { from: mail.from } },
        );

        if (sent.ok) {
          return;
        }
      }

      context.events.publish({
        type: "email.received",
        mailbox: mailbox.name,
        from: mail.from,
        fromName: mail.fromName,
        to: mail.to,
        subject: mail.subject,
        date: mail.date,
        messageId: mail.messageId,
        inReplyTo: mail.inReplyTo,
        text: mail.text,
        userIds: mailbox.users,
      });
    };

    const poll = async (mailbox: Mailbox): Promise<void> => {
      const [seen] = context.store.all(
        "select uid_validity, last_uid from email_state where mailbox = ?",
        mailbox.name,
      ) as State[];

      const checked = await check(
        mailbox,
        seen && { uidValidity: seen.uid_validity, last: seen.last_uid },
      );

      for (const mail of checked.mail) {
        received(mailbox, mail);
      }

      context.store.run(
        "insert into email_state (mailbox, uid_validity, last_uid) values (?, ?, ?) on conflict (mailbox) do update set uid_validity = excluded.uid_validity, last_uid = excluded.last_uid",
        mailbox.name,
        checked.uidValidity,
        checked.last,
      );

      if (checked.mail.length > 0) {
        context.log("new mail", {
          mailbox: mailbox.name,
          count: checked.mail.length,
        });
      }
    };

    const checkedAt = new Map<string, number>();
    let checking: Promise<void> | undefined;

    // Each mailbox is checked once its interval passed since its last check,
    // so a changed interval counts from then on.
    const checkDue = async (): Promise<void> => {
      const intervalMs = Number(context.settings.get()["pollSeconds"]) * 1000;

      for (const mailbox of mailboxes.list()) {
        if (Date.now() - (checkedAt.get(mailbox.name) ?? 0) < intervalMs) {
          continue;
        }

        checkedAt.set(mailbox.name, Date.now());

        try {
          await poll(mailbox);
          errors.delete(mailbox.name);
        } catch (failure) {
          const error =
            failure instanceof Error ? failure.message : String(failure);

          errors.set(mailbox.name, error);

          context.log("couldn't check a mailbox", {
            mailbox: mailbox.name,
            error,
          });
        }
      }
    };

    const tick = (): void => {
      checking ??= checkDue().finally(() => {
        checking = undefined;
      });
    };

    const timer = setInterval(tick, 1000);
    tick();

    context.signal.addEventListener("abort", () => {
      clearInterval(timer);
    });

    const usable = (userId: string | null): readonly Mailbox[] =>
      userId === null
        ? []
        : mailboxes.list().filter((each) => each.users.includes(userId));

    // From a mailbox the admin who invited can send from, so the invite
    // comes from someone the person may know.
    context.events.subscribe("PersonInvited", (invite) => {
      const [mailbox] = usable(invite.invitedBy.id);

      if (mailbox === undefined) {
        return;
      }

      const expires = new Date(invite.expiresAt).toUTCString().slice(5, 16);

      void send(mailbox, {
        to: invite.email,
        subject: `${invite.invitedBy.name} invited you to Pipoca`,
        text: `${invite.invitedBy.name} invited you to Pipoca${invite.admin ? " as an admin" : ""}.\n\nJoin with this link: ${invite.link}\n\nIt works once, until ${expires}.\n`,
      }).then(
        () => {
          context.log("invite emailed", { mailbox: mailbox.name });
        },
        (failure: unknown) => {
          context.log("couldn't email an invite", {
            mailbox: mailbox.name,
            error: failure instanceof Error ? failure.message : String(failure),
          });
        },
      );
    });

    context.tools.register({
      name: "email_send",
      description:
        "Sends an email from one of the user's mailboxes, or replies to one by its Message-ID. Replies to what you send come back to this Session as messages.",
      parameters: {
        type: "object",
        properties: {
          to: {
            type: "string",
            description: "One address, or several split by commas",
          },
          subject: { type: "string" },
          text: { type: "string", description: "Plain text" },
          in_reply_to: {
            type: "string",
            description: "The Message-ID of the mail this replies to",
          },
          mailbox: {
            type: "string",
            description: "Which mailbox, when the user has more than one",
          },
        },
        required: ["to", "subject", "text"],
        additionalProperties: false,
      },
      exposure: "direct",
      annotations: { readOnlyHint: false, destructiveHint: false },
      appliesTo: (session) => usable(session.startedBy).length > 0,
      run: async (input, { session }) => {
        const {
          to,
          subject,
          text,
          in_reply_to: inReplyTo,
          mailbox: name,
        } = input as Record<string, unknown>;

        const mine = usable(session.startedBy);
        const only = mine.length === 1 ? mine[0] : undefined;

        const mailbox =
          typeof name === "string"
            ? mine.find((each) => each.name === name)
            : only;

        if (mailbox === undefined) {
          return {
            text: `name one of these mailboxes: ${mine.map((each) => each.name).join(", ")}`,
            isError: true,
          };
        }

        if (
          typeof to !== "string" ||
          typeof subject !== "string" ||
          typeof text !== "string"
        ) {
          return { text: "give to, subject and text", isError: true };
        }

        try {
          const messageId = await send(mailbox, {
            to,
            subject,
            text,
            ...(typeof inReplyTo === "string" && { inReplyTo }),
          });

          context.store.run(
            "insert into email_threads (mailbox, message_id, session_id) values (?, ?, ?) on conflict do update set session_id = excluded.session_id",
            mailbox.name,
            messageId,
            session.id,
          );

          return {
            text: `Sent from ${mailbox.address} to ${to} (Message-ID ${messageId}). Replies come back here.`,
            isError: false,
          };
        } catch (failure) {
          if (!(failure instanceof MailRefused)) {
            throw failure;
          }

          return { text: failure.message, isError: true };
        }
      },
    });

    const viewOf = (mailbox: Mailbox): MailboxView => ({
      name: mailbox.name,
      address: mailbox.address,
      error: errors.get(mailbox.name) ?? null,
    });

    context.routes.handle(async (request, path, caller) => {
      const [route, name] = path.split("/");

      if (route === "account" && request.method === "GET") {
        const account: Account = {
          admin: caller.kind === "user" && caller.admin,
        };

        return Response.json(account);
      }

      if (route !== "mailboxes") {
        throw new NotFound(`no route ${path}`);
      }

      requireAdmin(caller, "Only admins manage mailboxes.");

      if (name === undefined && request.method === "GET") {
        return Response.json(mailboxes.list().map(viewOf));
      }

      if (name === undefined && request.method === "POST") {
        const input = await readBody(request, newMailbox);

        const mailbox: Mailbox = {
          ...input,
          name: input.name.trim(),
          address: input.address.trim(),
          users:
            caller.kind === "user" ? [caller.actor.slice("user:".length)] : [],
        };

        await verify(mailbox).catch((failure: unknown) => {
          throw failure instanceof MailRefused
            ? new BadRequest(failure.message)
            : failure;
        });

        mailboxes.add(mailbox);
        context.log("mailbox added", { name: mailbox.name });
        tick();

        return Response.json(viewOf(mailbox), { status: 201 });
      }

      if (name !== undefined && request.method === "DELETE") {
        if (!mailboxes.remove(name)) {
          throw new NotFound(`no mailbox ${name}`);
        }

        context.store.run("delete from email_state where mailbox = ?", name);
        context.log("mailbox removed", { name });

        return Response.json({ removed: name });
      }

      throw new NotFound(`no route ${path}`);
    });
  },
};
