import {
  BadRequest,
  defineServer,
  NotFound,
  ToolError,
  Type,
} from "@pipoca/plugins";
import type { Owner } from "@pipoca/protocol";
import { email } from "../plugin";
import {
  check,
  type Mail,
  type Mailbox,
  MailRefused,
  send,
  verify,
} from "./mail";
import type { MailboxView } from "./model";
import { questionReplies } from "./questions";

const mailServer = Type.Object({
  host: Type.String({ minLength: 1 }),
  port: Type.Integer({ minimum: 1, maximum: 65_535 }),
  secure: Type.Boolean(),
});

const newMailbox = Type.Object({
  name: Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,62}$" }),
  address: Type.String({ minLength: 3 }),
  user: Type.String({ minLength: 1 }),
  password: Type.String({ minLength: 1 }),
  imap: mailServer,
  smtp: mailServer,
});

const sendMail = Type.Object(
  {
    to: Type.String({ description: "One address, or several split by commas" }),
    subject: Type.String(),
    text: Type.String({ description: "Plain text" }),
    in_reply_to: Type.Optional(
      Type.String({
        description: "The Message-ID of the mail this replies to",
      }),
    ),
    mailbox: Type.Optional(
      Type.String({
        description: "Which mailbox, when the user has more than one",
      }),
    ),
  },
  { additionalProperties: false },
);

interface State {
  readonly uid_validity: string;
  readonly last_uid: number;
}

// New mail as routine triggers, and Sessions that send from a mailbox, with
// replies to what they sent coming back to them (ADR 0062).
export const server = defineServer(email, (context) => {
  const {
    config,
    events,
    log,
    routes,
    schedule,
    sessions,
    store,
    tools,
    clock,
  } = context;

  const mailboxes = config.collection("mailboxes");
  const errors = new Map<string, string>();
  const answered = questionReplies(context, mailboxes);

  const threadOf = (mailbox: string, messageId: string): string =>
    `${mailbox}:${messageId}`;

  // A reply to mail a Session sent goes to that Session, and so do replies
  // to that reply. Other mail is an event.
  const received = (mailbox: Mailbox, mail: Mail): void => {
    if (mail.inReplyTo !== "" && answered(mailbox, mail)) {
      return;
    }

    const sessionId =
      mail.inReplyTo === ""
        ? undefined
        : sessions.boundTo(threadOf(mailbox.name, mail.inReplyTo));

    if (
      sessionId !== undefined &&
      sessions.send(sessionId, {
        text: `A reply to the mail you sent from ${mailbox.address}, from ${mail.from}, subject “${mail.subject}” (Message-ID ${mail.messageId}):\n\n${mail.text}`,
        turn: true,
        notice: { kind: "email_reply", data: { from: mail.from } },
      }) === "queued"
    ) {
      sessions.bind(threadOf(mailbox.name, mail.messageId), sessionId);

      return;
    }

    const { uid: _uid, ...fields } = mail;

    events.emit(
      "received",
      { mailbox: mailbox.name, ...fields, to: [...mail.to] },
      { to: mailbox.users },
    );
  };

  const poll = async (mailbox: Mailbox): Promise<void> => {
    const seen = store.get<State>(
      "select uid_validity, last_uid from email_state where mailbox = ?",
      mailbox.name,
    );

    const checked = await check(
      mailbox,
      seen && { uidValidity: seen.uid_validity, last: seen.last_uid },
      clock.now(),
    );

    for (const mail of checked.mail) {
      received(mailbox, mail);
    }

    store.run(
      "insert into email_state (mailbox, uid_validity, last_uid) values (?, ?, ?) on conflict (mailbox) do update set uid_validity = excluded.uid_validity, last_uid = excluded.last_uid",
      mailbox.name,
      checked.uidValidity,
      checked.last,
    );

    if (checked.mail.length > 0) {
      log("new mail", { mailbox: mailbox.name, count: checked.mail.length });
    }
  };

  const checkOne = async (mailbox: Mailbox): Promise<void> => {
    try {
      await poll(mailbox);
      errors.delete(mailbox.name);
    } catch (failure) {
      const error =
        failure instanceof Error ? failure.message : String(failure);

      errors.set(mailbox.name, error);
      log("couldn't check a mailbox", { mailbox: mailbox.name, error });
    }
  };

  schedule.every(
    "poll",
    () => config.get().pollSeconds * 1000,
    async () => {
      for (const mailbox of mailboxes.list()) {
        await checkOne(mailbox);
      }
    },
  );

  const usable = (audience: readonly Owner[]): readonly Mailbox[] =>
    mailboxes
      .list()
      .filter(({ users }) => users.some((user) => audience.includes(user)));

  // From a mailbox the admin who invited can send from, so the invite
  // comes from someone the person may know.
  events.on("PersonInvited", (invite) => {
    const [mailbox] = usable(invite.to);

    if (mailbox === undefined) {
      return;
    }

    const expires = new Date(invite.expiresAt).toUTCString().slice(5, 16);

    send(mailbox, {
      to: invite.email,
      subject: `${invite.invitedBy.name} invited you to Pipoca`,
      text: `${invite.invitedBy.name} invited you to Pipoca${invite.admin ? " as an admin" : ""}.\n\nJoin with this link: ${invite.link}\n\nIt works once, until ${expires}.\n`,
    }).then(
      () => {
        log("invite emailed", { mailbox: mailbox.name });
      },
      (failure: unknown) => {
        log("couldn't email an invite", {
          mailbox: mailbox.name,
          error: failure instanceof Error ? failure.message : String(failure),
        });
      },
    );
  });

  tools.define({
    name: "email_send",
    description:
      "Sends an email from one of the user's mailboxes, or replies to one by its Message-ID. Replies to what you send come back to this Session as messages.",
    params: sendMail,
    exposure: "direct",
    annotations: { readOnly: false, destructive: false },
    when: {
      available: (session) => usable([session.ownedBy]).length > 0,
    },
    run: async (input, { session, owner }) => {
      const mine = usable([owner]);

      const only = mine.length === 1 ? mine[0]?.name : undefined;

      const mailbox = mine.find(({ name }) => name === (input.mailbox ?? only));

      if (mailbox === undefined) {
        throw new ToolError(
          `name one of these mailboxes: ${mine.map(({ name }) => name).join(", ")}`,
        );
      }

      const messageId = await send(mailbox, {
        to: input.to,
        subject: input.subject,
        text: input.text,
        ...(input.in_reply_to !== undefined && {
          inReplyTo: input.in_reply_to,
        }),
      }).catch((failure: unknown) => {
        throw failure instanceof MailRefused
          ? new ToolError(failure.message)
          : failure;
      });

      sessions.bind(threadOf(mailbox.name, messageId), session.id);

      return `Sent from ${mailbox.address} to ${input.to} (Message-ID ${messageId}). Replies come back here.`;
    },
  });

  const viewOf = (mailbox: Mailbox): MailboxView => ({
    name: mailbox.name,
    address: mailbox.address,
    error: errors.get(mailbox.name) ?? null,
  });

  routes.get("mailboxes", { auth: "admin" }, () =>
    mailboxes.list().map(viewOf),
  );

  routes.post(
    "mailboxes",
    { auth: "admin", body: newMailbox, status: 201, changes: ["mailboxes"] },
    async ({ body, caller }) => {
      if (mailboxes.get(body.name) !== undefined) {
        throw new BadRequest(`there is a mailbox ${body.name} already`);
      }

      const mailbox: Mailbox = {
        ...body,
        address: body.address.trim(),
        users: [caller.owner],
      };

      await verify(mailbox).catch((failure: unknown) => {
        throw failure instanceof MailRefused
          ? new BadRequest(failure.message)
          : failure;
      });

      mailboxes.put(mailbox);
      log("mailbox added", { name: mailbox.name });
      await checkOne(mailbox);

      return viewOf(mailbox);
    },
  );

  routes.delete(
    "mailboxes/:name",
    { auth: "admin", changes: ["mailboxes"] },
    ({ params }) => {
      const { name } = params;

      if (!mailboxes.remove(name)) {
        throw new NotFound(`no mailbox ${name}`);
      }

      store.run("delete from email_state where mailbox = ?", name);
      log("mailbox removed", { name });

      return { removed: name };
    },
  );
});
