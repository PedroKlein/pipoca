import { afterEach, expect, test } from "bun:test";
import {
  type PluginTest,
  person,
  testPlugin,
  until,
} from "@pipoca/plugins/testing";
import { SMTPServer } from "smtp-server";
import { email } from "../plugin";

interface Message {
  readonly uid: number;
  readonly from: string;
  readonly subject: string;
  readonly messageId: string;
  readonly inReplyTo: string;
  readonly body: string;
}

const people = [
  { id: "ana", name: "Ana", admin: true },
  { id: "bo", name: "Bo" },
];

const opened: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(opened.splice(0).map(async (close) => close()));
});

const quoted = (text: string): string => JSON.stringify(text);

const address = (mail: string): string => {
  const [mailbox, host] = mail.split("@");

  return `((NIL NIL ${quoted(mailbox ?? "")} ${quoted(host ?? "")}))`;
};

// One message as IMAP's FETCH answers it: a plain-text body of one part,
// which a client downloads as the message's header and text.
function fetched(message: Message, items: string): string {
  const body = Buffer.from(message.body);

  if (/BODY\.PEEK\[HEADER\]/i.test(items)) {
    const header = "Content-Type: text/plain; charset=utf-8\r\n\r\n";

    return `UID ${String(message.uid)} RFC822.SIZE ${String(header.length + body.length)} BODY[HEADER] {${String(header.length)}}\r\n${header} BODY[TEXT]<0> {${String(body.length)}}\r\n${message.body}`;
  }

  const envelope = `(${quoted("Tue, 3 Nov 2026 08:00:00 +0000")} ${quoted(message.subject)} ${address(message.from)} ${address(message.from)} ${address(message.from)} ${address("support@example.com")} NIL NIL ${message.inReplyTo === "" ? "NIL" : quoted(message.inReplyTo)} ${quoted(message.messageId)})`;

  return `UID ${String(message.uid)} ENVELOPE ${envelope} BODYSTRUCTURE ("TEXT" "PLAIN" ("CHARSET" "utf-8") NIL NIL "7BIT" ${String(body.length)} 1 NIL NIL NIL NIL)`;
}

// A mail server with one mailbox, support@example.com with the password
// "right": just enough IMAP for a client that logs in, opens INBOX and
// fetches by UID, and SMTP that keeps what it is sent.
async function fakeMail() {
  const inbox: Message[] = [
    {
      uid: 1,
      from: "old@example.com",
      subject: "From before",
      messageId: "<old@example.com>",
      inReplyTo: "",
      body: "Old mail.",
    },
  ];

  const sent: string[] = [];
  let checks = 0;

  const answer = (line: string): string => {
    const [tag = "*", command = "", ...rest] = line.split(" ");
    const done = `${tag} OK done\r\n`;

    switch (command.toUpperCase()) {
      case "CAPABILITY":
        return `* CAPABILITY IMAP4rev1\r\n${done}`;
      case "LOGIN":
        return rest.join(" ") === '"support@example.com" "right"'
          ? done
          : `${tag} NO [AUTHENTICATIONFAILED] wrong password\r\n`;
      case "SELECT":
      case "EXAMINE":
        checks++;

        return `* ${String(inbox.length)} EXISTS\r\n* OK [UIDVALIDITY 7] ok\r\n* OK [UIDNEXT ${String((inbox.at(-1)?.uid ?? 0) + 1)}] ok\r\n${tag} OK [READ-WRITE] done\r\n`;
      case "LOGOUT":
        return `* BYE\r\n${done}`;
      case "UID": {
        const [, range = "", ...items] = rest;
        const [low = "0", high = "*"] = range.split(":");

        const wanted = inbox.filter(
          ({ uid }) =>
            uid >= Number(low) &&
            (high === "*" || uid <= Number(high)) &&
            (range.includes(":") || uid === Number(low)),
        );

        return `${wanted
          .map(
            (message) =>
              `* ${String(inbox.indexOf(message) + 1)} FETCH (${fetched(message, items.join(" "))})\r\n`,
          )
          .join("")}${done}`;
      }

      default:
        return done;
    }
  };

  const imap = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open: (socket) => {
        socket.write("* OK fake IMAP ready\r\n");
      },
      data: (socket, data) => {
        for (const line of String(data).split("\r\n")) {
          if (line !== "") {
            socket.write(answer(line));
          }
        }
      },
    },
  });

  const smtp = new SMTPServer({
    disabledCommands: ["STARTTLS"],
    allowInsecureAuth: true,
    onAuth: ({ username, password }, _session, callback) => {
      if (username === "support@example.com" && password === "right") {
        callback(null, { user: username });
      } else {
        callback(new Error("wrong password"));
      }
    },
    onData: (stream, _session, callback) => {
      const chunks: Buffer[] = [];

      stream.on("data", (chunk: Buffer) => chunks.push(chunk));

      stream.on("end", () => {
        sent.push(Buffer.concat(chunks).toString());
        callback();
      });
    },
  });

  const smtpPort = await new Promise<number>((resolve) => {
    smtp.listen(0, "127.0.0.1", () => {
      resolve((smtp.server.address() as { port: number }).port);
    });
  });

  opened.push(async () => {
    imap.stop(true);

    await new Promise<void>((resolve) => {
      smtp.close(resolve);
    });
  });

  return {
    inbox,
    sent,
    checks: () => checks,
    servers: {
      imap: { host: "127.0.0.1", port: imap.port, secure: false },
      smtp: { host: "127.0.0.1", port: smtpPort, secure: false },
    },
  };
}

async function started(
  config?: Readonly<Record<string, unknown>>,
): Promise<PluginTest> {
  const t = await testPlugin(email, {
    people,
    ...(config !== undefined && { config }),
  });

  opened.push(t.close);

  return t;
}

async function addMailbox(
  t: PluginTest,
  mail: Awaited<ReturnType<typeof fakeMail>>,
  password = "right",
): Promise<Response> {
  return t.as("ana").raw("POST", "mailboxes", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "support",
      address: "support@example.com",
      user: "support@example.com",
      password,
      ...mail.servers,
    }),
  });
}

test("a mailbox is saved only once its logins work, and its new mail is an event", async () => {
  const mail = await fakeMail();
  const t = await started();

  const refused = await addMailbox(t, mail, "wrong");

  expect(refused.status).toBe(400);
  expect(await refused.text()).toContain("the IMAP server refused");
  expect(await t.as("ana").get("mailboxes")).toEqual([]);

  expect((await addMailbox(t, mail)).status).toBe(201);

  // The first check only learns where the mailbox is.
  expect(mail.checks()).toBe(1);

  mail.inbox.push({
    uid: 2,
    from: "alice@example.com",
    subject: "Can't log in",
    messageId: "<new@example.com>",
    inReplyTo: "",
    body: "It says my password is wrong.",
  });

  await t.clock.advance("60s");

  expect(t.emitted("email.received")).toEqual([
    {
      fields: {
        mailbox: "support",
        from: "alice@example.com",
        fromName: "",
        to: ["support@example.com"],
        subject: "Can't log in",
        date: "2026-11-03T08:00:00.000Z",
        messageId: "<new@example.com>",
        inReplyTo: "",
        text: "It says my password is wrong.",
      },
      to: [person("ana")],
    },
  ]);

  expect(await t.as("ana").get("mailboxes")).toEqual([
    { name: "support", address: "support@example.com", error: null },
  ]);
});

test("mailboxes are checked as often as the config says, by hand edits too", async () => {
  process.env["PIPOCA_TEST_MAIL_PASSWORD"] = "right";

  const mail = await fakeMail();

  const config = {
    pollSeconds: 60,
    mailboxes: [
      {
        name: "support",
        address: "support@example.com",
        user: "support@example.com",
        password: { env: "PIPOCA_TEST_MAIL_PASSWORD" },
        ...mail.servers,
      },
    ],
  };

  const t = await started(config);

  await t.clock.advance("59s");

  expect(mail.checks()).toBe(0);

  await t.clock.advance("1s");
  await until(() => mail.checks() === 1);

  expect(process.env["PIPOCA_TEST_MAIL_PASSWORD"]).toBeUndefined();

  await t.editConfig({ ...config, pollSeconds: 5 });
  await t.clock.advance("60s");
  await until(() => mail.checks() === 2);
  await t.clock.advance("5s");
  await until(() => mail.checks() === 3);
});

test("a reply to mail a Session sent reaches it, even while it is offline", async () => {
  const mail = await fakeMail();
  const t = await started();

  await addMailbox(t, mail);

  const session = await t.session({ owner: person("ana") });

  const result = await t.tool(
    "email_send",
    {
      to: "alice@example.com",
      subject: "Your login",
      text: "Try resetting your password.",
    },
    { session },
  );

  expect(result.isError).toBe(false);

  const messageId = /Message-ID (<[^>]+>)/.exec(result.text)?.[1] ?? "";

  expect(mail.sent).toHaveLength(1);
  expect(mail.sent[0]).toContain("Subject: Your login");
  expect(mail.sent[0]).toContain(`Message-ID: ${messageId}`);

  await session.online(false);

  mail.inbox.push({
    uid: 2,
    from: "alice@example.com",
    subject: "Re: Your login",
    messageId: "<reply@example.com>",
    inReplyTo: messageId,
    body: "That worked, thanks!",
  });

  await t.clock.advance("60s");
  await until(() => session.queued().length === 1);

  expect(t.emitted("email.received")).toEqual([]);

  await session.online(true);

  const [reply] = await until(
    () => session.delivered(),
    (delivered) => delivered.length === 1,
  );

  expect(reply?.text).toEndWith("\n\nThat worked, thanks!");
  expect(reply?.turn).toBe(true);

  expect(reply?.notice).toMatchObject({
    kind: "email_reply",
    data: { from: "alice@example.com" },
  });
});

test("email_send is offered only to people who may send from a mailbox", async () => {
  const mail = await fakeMail();
  const t = await started();

  await addMailbox(t, mail);

  const session = await t.session({ owner: person("bo") });

  expect(
    t.tool(
      "email_send",
      { to: "a@example.com", subject: "Hi", text: "Hi" },
      { session },
    ),
  ).rejects.toThrow("email_send isn't offered in this Session");
});

test("an invite goes out by mail from a mailbox the inviting admin sends from", async () => {
  const mail = await fakeMail();
  const t = await started();

  await addMailbox(t, mail);

  t.emit({
    type: "PersonInvited",
    email: "cy@example.com",
    link: "https://pipoca.example.com/#join/abc",
    invitedBy: { id: "ana", name: "Ana" },
    admin: false,
    expiresAt: "2026-11-12T08:00:00.000Z",
  });

  await until(() => mail.sent.length > 0);

  expect(mail.sent[0]).toContain("To: cy@example.com");
  expect(mail.sent[0]).toContain("Subject: Ana invited you to Pipoca");
  expect(mail.sent[0]?.replace(/=\r\n/g, "")).toContain("/#join/abc");
});
