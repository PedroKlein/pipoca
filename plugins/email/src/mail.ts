import { ImapFlow, type MessageStructureObject } from "imapflow";
import { createTransport, type Transporter } from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport";
import type { Static } from "@pipoca/plugins";
import type { email } from "../plugin";

export type Mailbox = Static<typeof email.config>["mailboxes"][number];

// What a mail server answered, in words for an admin or a Session.
export class MailRefused extends Error {}

const timeoutMs = 30_000;

// The longest text an event carries. Routines put events in a prompt.
const maxText = 8000;

export interface Mail {
  readonly uid: number;
  readonly from: string;
  readonly fromName: string;
  readonly to: readonly string[];
  readonly subject: string;
  readonly date: string;
  readonly messageId: string;
  readonly inReplyTo: string;
  readonly text: string;
}

export interface Checked {
  readonly uidValidity: string;
  // The highest UID the mailbox has, which the next check starts after.
  readonly last: number;
  readonly mail: readonly Mail[];
}

// The mail that came after the last UID seen. On a first check, or when the
// mailbox's UIDs were renumbered, it only learns where the mailbox is, so
// old mail doesn't start runs. Mail without a date takes now's.
export async function check(
  mailbox: Mailbox,
  seen: { readonly uidValidity: string; readonly last: number } | undefined,
  now: number,
): Promise<Checked> {
  const client = imapOf(mailbox);

  try {
    await client.connect();
  } catch (failure) {
    throw refused("IMAP", failure);
  }

  try {
    const lock = await client.getMailboxLock("INBOX");

    try {
      const opened = client.mailbox;
      const uidValidity = opened === false ? "" : String(opened.uidValidity);

      const top = opened === false ? 0 : opened.uidNext - 1;

      if (seen?.uidValidity !== uidValidity) {
        return { uidValidity, last: top, mail: [] };
      }

      if (top <= seen.last) {
        return { uidValidity, last: seen.last, mail: [] };
      }

      const fetched = await client.fetchAll(
        `${String(seen.last + 1)}:*`,
        { uid: true, envelope: true, bodyStructure: true },
        { uid: true },
      );

      const mail: Mail[] = [];

      for (const message of fetched) {
        if (message.uid <= seen.last) {
          continue;
        }

        const envelope = message.envelope ?? {};
        const [sender] = envelope.from ?? [];
        const part = textPart(message.bodyStructure);

        mail.push({
          uid: message.uid,
          from: sender?.address ?? "",
          fromName: sender?.name ?? "",
          to: (envelope.to ?? []).flatMap(({ address }) =>
            address === undefined ? [] : [address],
          ),
          subject: envelope.subject ?? "",
          date: new Date(envelope.date ?? now).toISOString(),
          messageId: envelope.messageId ?? "",
          inReplyTo: envelope.inReplyTo ?? "",
          text:
            part === undefined
              ? ""
              : clipped(await download(client, message.uid, part)),
        });
      }

      return {
        uidValidity,
        last: Math.max(seen.last, ...mail.map(({ uid }) => uid)),
        mail,
      };
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }
}

// Whether the mailbox's IMAP and SMTP logins work.
export async function verify(mailbox: Mailbox): Promise<void> {
  const client = imapOf(mailbox);

  try {
    await client.connect();
  } catch (failure) {
    throw refused("IMAP", failure);
  }

  await client.logout().catch(() => undefined);

  await transportOf(mailbox)
    .verify()
    .catch((failure: unknown) => {
      throw refused("SMTP", failure);
    });
}

export async function send(
  mailbox: Mailbox,
  mail: {
    readonly to: string;
    readonly subject: string;
    readonly text: string;
    readonly inReplyTo?: string;
  },
): Promise<string> {
  try {
    const sent = await transportOf(mailbox).sendMail({
      from: mailbox.address,
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      ...(mail.inReplyTo !== undefined && {
        inReplyTo: mail.inReplyTo,
        references: mail.inReplyTo,
      }),
    });

    return sent.messageId;
  } catch (failure) {
    throw refused("SMTP", failure);
  }
}

function imapOf(mailbox: Mailbox): ImapFlow {
  return new ImapFlow({
    host: mailbox.imap.host,
    port: mailbox.imap.port,
    secure: mailbox.imap.secure,
    auth: { user: mailbox.user, pass: mailbox.password },
    logger: false,
    connectionTimeout: timeoutMs,
    socketTimeout: timeoutMs,
  });
}

function transportOf(
  mailbox: Mailbox,
): Transporter<SMTPTransport.SentMessageInfo> {
  const options: SMTPTransport.Options = {
    host: mailbox.smtp.host,
    port: mailbox.smtp.port,
    secure: mailbox.smtp.secure,
    auth: { user: mailbox.user, pass: mailbox.password },
    connectionTimeout: timeoutMs,
  };

  return createTransport(options);
}

// The first plain-text part that isn't an attachment.
function textPart(
  node: MessageStructureObject | undefined,
): string | undefined {
  if (node === undefined) {
    return undefined;
  }

  if (node.type === "text/plain" && node.disposition !== "attachment") {
    return node.part ?? "1";
  }

  for (const child of node.childNodes ?? []) {
    const found = textPart(child);

    if (found !== undefined) {
      return found;
    }
  }

  return undefined;
}

async function download(
  client: ImapFlow,
  uid: number,
  part: string,
): Promise<string> {
  const { content } = await client.download(String(uid), part, { uid: true });

  if (content === undefined) {
    return "";
  }

  const chunks: Buffer[] = [];

  for await (const chunk of content) {
    chunks.push(Buffer.from(chunk as Uint8Array));
  }

  return Buffer.concat(chunks).toString("utf8");
}

function clipped(text: string): string {
  return text.length > maxText ? `${text.slice(0, maxText)}…` : text;
}

function refused(what: string, failure: unknown): MailRefused {
  return new MailRefused(
    `the ${what} server refused: ${failure instanceof Error ? failure.message : String(failure)}`,
  );
}
