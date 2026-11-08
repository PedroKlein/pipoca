import type { Collection, Person, ServerContext } from "@pipoca/plugins";
import type { email } from "../plugin";
import { type Mail, type Mailbox, send } from "./mail";

interface Posted {
  readonly question_id: string;
  readonly addresses: string;
}

// A person's address: the one Pipoca knows, or their name when they sign in
// by email, as through OIDC.
function addressOf(person: Person): string | undefined {
  const address =
    person.email ?? (/^[^@\s]+@[^@\s]+$/.test(person.name) ? person.name : "");

  return address === "" ? undefined : address.toLowerCase();
}

// A question goes back as a reply to the mail its work came from, copied to
// the people who may answer it. Anyone can be copied on a mail, so only a
// reply from the owner's or the assignees' address answers it (ADR 0076).
export function questionReplies(
  {
    store,
    clock,
    provide,
    questions,
    log,
  }: Pick<
    ServerContext<typeof email>,
    "store" | "clock" | "provide" | "questions" | "log"
  >,
  mailboxes: Collection<Mailbox>,
): (mailbox: Mailbox, mail: Mail) => boolean {
  provide.replies({
    post: async ({ id, session, origin, text, answerers }) => {
      const { fields } = origin;
      const mailbox = mailboxes.get(String(fields["mailbox"]));

      const addresses = [
        ...new Set(answerers.flatMap((person) => addressOf(person) ?? [])),
      ];

      if (
        origin.event !== "email.received" ||
        mailbox === undefined ||
        !mailbox.users.includes(session.ownedBy) ||
        addresses.length === 0
      ) {
        return false;
      }

      const from = String(fields["from"]).toLowerCase();
      const subject = String(fields["subject"]);

      const messageId = await send(mailbox, {
        to: [...new Set([from, ...addresses])].join(", "),
        subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
        text: `${text.replaceAll("**", "")}\n\nReply to this mail to answer.`,
        inReplyTo: String(fields["messageId"]),
      });

      store.run(
        "insert into email_questions (question_id, mailbox, message_id, addresses, posted_at) values (?, ?, ?, ?, ?)",
        id,
        mailbox.name,
        messageId,
        JSON.stringify(addresses),
        clock.now(),
      );

      return true;
    },
  });

  // Whether the mail answered a question, and so is neither a reply to a
  // Session nor an event.
  return (mailbox, mail) => {
    const rows = store.all<Posted>(
      "select question_id, addresses from email_questions where mailbox = ? and message_id = ?",
      mailbox.name,
      mail.inReplyTo,
    );

    for (const row of rows) {
      if (
        !(JSON.parse(row.addresses) as string[]).includes(
          mail.from.toLowerCase(),
        )
      ) {
        continue;
      }

      store.run(
        "delete from email_questions where question_id = ?",
        row.question_id,
      );

      if (
        questions.answer(row.question_id, { text: mail.text, by: mail.from })
      ) {
        log("question answered by mail", {
          id: row.question_id,
          mailbox: mailbox.name,
        });

        return true;
      }
    }

    return false;
  };
}
