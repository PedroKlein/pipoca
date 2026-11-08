import {
  action,
  Config,
  event,
  definePlugin,
  destination,
  Secret,
  Type,
} from "@pipoca/plugins";

const server = Type.Object({
  host: Type.String({ title: "Host", minLength: 1 }),
  port: Type.Integer({ title: "Port", minimum: 1, maximum: 65_535 }),
  // TLS from the start, as on ports 993 and 465. Otherwise the connection
  // upgrades with STARTTLS when the server offers it.
  secure: Type.Boolean({ title: "TLS from the start" }),
});

const mailbox = Type.Object({
  name: Type.String({ title: "Name" }),
  address: Type.String({ title: "Address", minLength: 3 }),
  user: Type.String({ title: "User", minLength: 1 }),
  password: Secret({ title: "Password", env: true }),
  imap: server,
  smtp: server,
  users: Config.audience(),
});

// A mail from one of the Session owner's mailboxes, or a reply to one.
export const sendMail = Type.Object(
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

export const email = definePlugin({
  id: "email",
  title: "Email",
  description:
    "Turns new mail in a mailbox into routine triggers, and lets Sessions send mail and hear replies. Admins add mailboxes in Settings.",
  config: Config.object({
    pollSeconds: Config.number({
      title: "Seconds between mail checks",
      default: 60,
      min: 1,
      max: 3600,
    }),
    mailboxes: Config.collection({
      title: "Mailboxes",
      key: "name",
      admin: true,
      item: mailbox,
    }),
  }),
  schema: `
create table email_state (
  mailbox text primary key,
  uid_validity text not null,
  last_uid integer not null
) strict;
`,
  // 1: questions sent as a reply to the mail their work came from
  // (ADR 0076), by the Message-ID they went out with, and the addresses
  // that may answer them.
  migrations: [
    `
create table email_questions (
  question_id text primary key,
  mailbox text not null,
  message_id text not null,
  addresses text not null check (json_valid(addresses)),
  posted_at integer not null
) strict;
create index email_questions_message on email_questions (mailbox, message_id);
`,
  ],
  events: {
    received: event({
      title: "Email received",
      description:
        "New mail arrived in a mailbox. Replies to mail a Session sent go to that Session instead.",
      fields: Type.Object({
        mailbox: Type.String({ description: "The mailbox it arrived in" }),
        from: Type.String({ description: "The sender's address" }),
        fromName: Type.String(),
        to: Type.Array(Type.String()),
        subject: Type.String(),
        date: Type.String(),
        messageId: Type.String(),
        inReplyTo: Type.String(),
        text: Type.String({
          description: "The plain-text body, cut at 8000 characters",
        }),
      }),
    }),
  },
  // What a routine's runs may propose (ADR 0076).
  actions: {
    send: action({
      title: "Send mail",
      description:
        "Sends a mail, or a reply, from one of the routine owner's mailboxes.",
      input: sendMail,
    }),
  },
  // Where a routine's run's result can go (ADR 0075).
  destinations: {
    mail: destination({
      title: "Mail",
      description:
        "Mails the result from one of the routine owner's mailboxes.",
      settings: Type.Object(
        {
          to: sendMail.properties.to,
          subject: Type.Optional(
            Type.String({
              minLength: 1,
              description: "The routine's title if left out",
            }),
          ),
          mailbox: sendMail.properties.mailbox,
        },
        { additionalProperties: false },
      ),
    }),
  },
});
