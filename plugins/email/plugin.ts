import { Config, event, definePlugin, Secret, Type } from "@pipoca/plugins";

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

export const email = definePlugin({
  id: "email",
  title: "Email",
  description:
    "Turns new mail in a mailbox into routine triggers, and lets Sessions send mail and hear replies. Admins add mailboxes in Settings.",
  works: ["personal", "team"],
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
});
