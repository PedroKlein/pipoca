import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  protocolVersion,
  versionHeader,
  type Work,
  type WorkPoll,
} from "@pipoca/protocol";
import type { TCPSocketListener } from "bun";
import { SMTPServer } from "smtp-server";
import { serve } from "./serve";
import { readSse } from "./sse";
import { runnerCredentials } from "./testdata/runners";
import { firstUser } from "./testdata/sign-in";

interface Message {
  readonly uid: number;
  readonly from: string;
  readonly subject: string;
  readonly messageId: string;
  readonly inReplyTo: string;
  readonly body: string;
}

let logs: string[];
let server: ReturnType<typeof serve>;
let pedro: () => Promise<string>;
let imap: TCPSocketListener;
let smtp: SMTPServer;
let smtpPort: number;
let inbox: Message[];
let selected: number;
let sent: string[];
let streams: AsyncGenerator[];
let configDir: string;

const quoted = (text: string): string => JSON.stringify(text);

const address = (email: string): string => {
  const [mailbox, host] = email.split("@");

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

// Just enough IMAP for a client that logs in, opens INBOX and fetches by UID.
function answer(line: string): string {
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
      selected++;

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
}

beforeEach(async () => {
  logs = [];
  selected = 0;
  sent = [];
  streams = [];

  inbox = [
    {
      uid: 1,
      from: "old@example.com",
      subject: "From before",
      messageId: "<old@example.com>",
      inReplyTo: "",
      body: "Old mail.",
    },
  ];

  imap = Bun.listen({
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

  smtp = new SMTPServer({
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

  smtpPort = await new Promise<number>((resolve) => {
    smtp.listen(0, "127.0.0.1", () => {
      resolve((smtp.server.address() as { port: number }).port);
    });
  });

  configDir = mkdtempSync(join(tmpdir(), "pipoca-config-"));

  server = serve({
    port: 0,
    database: ":memory:",
    configDir,
    sessions: { pollWaitMs: 0 },
    log: (message, fields) => {
      logs.push(`${message} ${JSON.stringify(fields)}`);
    },
  });

  pedro = firstUser(server, logs);
});

afterEach(async () => {
  await Promise.all(streams.map(async (stream) => stream.return(undefined)));
  await server.stop();
  imap.stop(true);

  await new Promise<void>((resolve) => {
    smtp.close(resolve);
  });
});

async function api(
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return fetch(new URL(path, server.url), {
    method,
    headers: {
      cookie: await pedro(),
      ...(body !== undefined && { "content-type": "application/json" }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}

async function addMailbox(password = "right"): Promise<Response> {
  return api("POST", "/api/plugins/email/mailboxes", {
    name: "support",
    address: "support@example.com",
    user: "support@example.com",
    password,
    imap: { host: "127.0.0.1", port: imap.port, secure: false },
    smtp: { host: "127.0.0.1", port: smtpPort, secure: false },
  });
}

async function until(done: () => boolean): Promise<void> {
  for (let tries = 0; tries < 300 && !done(); tries++) {
    await Bun.sleep(20);
  }
}

test("an admin adds a mailbox, and its new mail reaches routines", async () => {
  expect((await addMailbox("wrong")).status).toBe(400);
  expect((await addMailbox()).status).toBe(201);

  expect(readFileSync(join(configDir, "pipoca.json"), "utf8")).not.toContain(
    '"right"',
  );

  await api("PATCH", "/api/plugins/email", { settings: { pollSeconds: 1 } });

  // The first check only learns where the mailbox is.
  await until(() => selected > 0);

  await api("PUT", "/api/plugins/routines/routines/support", {
    title: "Answer support mail",
    triggers: [{ event: "email.received", filter: { mailbox: "support" } }],
    run: {
      prompt: "Answer the mail.",
      workspace: { kind: "folder", path: "/srv/a" },
    },
    key: ["messageId"],
  });

  inbox.push({
    uid: 2,
    from: "alice@example.com",
    subject: "Can't log in",
    messageId: "<new@example.com>",
    inReplyTo: "",
    body: "It says my password is wrong.",
  });

  const heard = (): readonly string[] =>
    logs.filter((line) => line.startsWith("routine heard an event"));

  await until(() => heard().length > 0);

  expect(heard()).toHaveLength(1);
  expect(heard()[0]).toContain('"key":"<new@example.com>"');
}, 15_000);

test("a Session sends mail from the mailbox, and replies to it come back to it", async () => {
  await addMailbox();
  await api("PATCH", "/api/plugins/email", { settings: { pollSeconds: 1 } });
  await until(() => selected > 0);

  const token = await runnerCredentials(server, pedro).token(
    "laptop",
    "laptops",
  );

  await api("POST", "/api/sessions", {
    workspace: { kind: "folder", path: "/srv/a" },
  });

  const agent = async (path: string, body?: unknown): Promise<Response> =>
    fetch(new URL(path, server.url), {
      method: body === undefined ? "GET" : "POST",
      headers: {
        [versionHeader]: String(protocolVersion),
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });

  const poll: WorkPoll = { running: [], folders: ["/srv/a"], models: [] };
  const work = (await (await agent("/agent/work", poll)).json()) as Work;
  const [started] = work.start;
  const session = `/agent/sessions/${started?.sessionId ?? ""}`;

  const commands = readSse(
    await agent(
      `${session}/commands?generation=${String(started?.generation ?? 0)}`,
    ),
    10_000,
  );

  streams.push(commands);

  const next = async (type: string): Promise<Record<string, unknown>> => {
    for (;;) {
      const read: IteratorResult<unknown> = await commands.next();

      if (read.done === true) {
        throw new Error(`no ${type} command`);
      }

      const command = read.value as Record<string, unknown>;

      if (command["type"] === type) {
        return command;
      }
    }
  };

  await agent(`${session}/tool-calls`, {
    generation: started?.generation,
    id: "call-1",
    name: "email_send",
    input: {
      to: "alice@example.com",
      subject: "Your login",
      text: "Try resetting your password.",
    },
  });

  const result = (await next("tool_result"))["result"] as {
    text: string;
    isError: boolean;
  };

  expect(result.isError).toBe(false);

  const messageId = /Message-ID (<[^>]+>)/.exec(result.text)?.[1] ?? "";

  expect(sent).toHaveLength(1);
  expect(sent[0]).toContain("Subject: Your login");
  expect(sent[0]).toContain(`Message-ID: ${messageId}`);

  inbox.push({
    uid: 2,
    from: "alice@example.com",
    subject: "Re: Your login",
    messageId: "<reply@example.com>",
    inReplyTo: messageId,
    body: "That worked, thanks!",
  });

  const reply = await next("notice");

  expect(reply["text"]).toEndWith("\n\nThat worked, thanks!");

  expect(reply["notice"]).toMatchObject({
    plugin: "email",
    kind: "email_reply",
  });
}, 15_000);

test("an invite by email goes out from a mailbox the admin sends from", async () => {
  await addMailbox();

  const invited = await api("POST", "/api/invites", {
    emails: ["ana@example.com"],
    admin: false,
    days: 7,
  });

  const [made] = (await invited.json()) as { token: string }[];

  await until(() => sent.length > 0);

  expect(sent).toHaveLength(1);
  expect(sent[0]).toContain("ana@example.com");
  expect(sent[0]).toContain("invited you to Pipoca");

  expect(sent[0]?.replace(/=\r\n/g, "")).toContain(
    `/#join/${made?.token ?? "?"}`,
  );
}, 15_000);
