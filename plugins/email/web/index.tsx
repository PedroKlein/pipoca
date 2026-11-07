import {
  ConfigForm,
  defineWeb,
  type NoticeProps,
  type SetupStep,
  useApi,
  useLoaded,
  useViewer,
} from "@pipoca/plugins/web";
import {
  Badge,
  Button,
  cardClass,
  Checkbox,
  cn,
  ErrorText,
  Field,
  TextInput,
  useConfirm,
} from "@pipoca/ui";
import { type ReactElement, type SubmitEvent, useState } from "react";
import { email } from "../plugin";
import type { MailboxView } from "../src/model";

// The team's mailboxes, in its server's setup (ADR 0072). Email links no
// one's own account, so there is no personal step.
const mailboxStep: SetupStep = {
  audience: "server",
  after: "where",
  teamOnly: true,
  title: "Email",
  summary: "A mailbox for routines and Sessions",
  heading: "Add a mailbox",
  description:
    "So your team can start routines from email and Sessions can send and answer mail. You can add one later in Settings, Integrations.",
  optional: true,
  done: async (api) =>
    (await api.get<readonly MailboxView[]>("mailboxes")).length > 0,
  changes: ["mailboxes"],
  Step: Mailboxes,
};

export const web = defineWeb(email, {
  settings: { group: "integrations", Section },
  slots: { "notice:email_reply": EmailReply },
  setup: [mailboxStep],
});

function Section(): ReactElement | null {
  if (!useViewer().person.admin) {
    return null;
  }

  return (
    <div className="flex flex-col gap-4">
      <Mailboxes />
      <ConfigForm plugin={email} path="pollSeconds" />
    </div>
  );
}

function Mailboxes(): ReactElement {
  const api = useApi(email);
  const [ask, asking] = useConfirm();

  const { value, reload } = useLoaded(
    async () => api.get<readonly MailboxView[]>("mailboxes"),
    "mailboxes",
    { changes: ["mailboxes"] },
  );

  // The deploy file, such as one Helm mounts, may set the mailboxes.
  const locked = useLoaded(
    async () =>
      api.get<{ readonly lockedIn?: string }>("/api/plugins/email/config"),
    "config",
    { topics: ["plugins"] },
  ).value?.lockedIn;

  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string>();

  const add = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);

    const field = (name: string): string => {
      const entry = form.get(name);

      return typeof entry === "string" ? entry.trim() : "";
    };

    const secure = form.get("secure") === "on";

    api
      .post("mailboxes", {
        name: field("name"),
        address: field("address"),
        user: field("user") || field("address"),
        password: field("password"),
        imap: {
          host: field("imapHost"),
          port: Number(field("imapPort") || (secure ? 993 : 143)),
          secure,
        },
        smtp: {
          host: field("smtpHost"),
          port: Number(field("smtpPort") || (secure ? 465 : 587)),
          secure,
        },
      })
      .then(
        () => {
          setAdding(false);
          setError(undefined);
          reload();
        },
        (reason: unknown) => {
          setError(reason instanceof Error ? reason.message : String(reason));
        },
      );
  };

  const remove = (mailbox: MailboxView): void => {
    void ask({
      title: `Remove ${mailbox.address}?`,
      description: `Routines stop hearing ${mailbox.address}, and Sessions can't send from it.`,
      confirm: "Remove",
      danger: true,
    }).then((yes) => {
      if (!yes) {
        return;
      }

      void api
        .delete(`mailboxes/${encodeURIComponent(mailbox.name)}`)
        .then(reload, reload);
    });
  };

  return (
    <div className="flex flex-col gap-2 text-ui">
      {asking}
      <p className="text-fg-dim">
        Mailboxes whose new mail becomes routine triggers, and that Sessions
        send from. The server checks them over IMAP and sends over SMTP.
      </p>
      <ul
        aria-label="Mailboxes"
        className={cn(cardClass, "flex flex-col gap-1 p-3")}
      >
        {value?.length === 0 && (
          <li className="text-fg-dim">No mailboxes yet.</li>
        )}
        {value?.map((mailbox) => (
          <li key={mailbox.name} className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <span className="flex-1 truncate text-fg">
                {mailbox.name}
                <span className="text-fg-dim"> · {mailbox.address}</span>
              </span>
              {locked === undefined ? (
                <Button
                  aria-label={`Remove ${mailbox.name}`}
                  onClick={() => {
                    remove(mailbox);
                  }}
                >
                  Remove
                </Button>
              ) : (
                <Badge>Set in deploy file</Badge>
              )}
            </div>
            <ErrorText size="caption">{mailbox.error}</ErrorText>
          </li>
        ))}
      </ul>
      {adding && (
        <form
          onSubmit={add}
          aria-label="New mailbox"
          className={cn(cardClass, "grid gap-4 p-5 md:grid-cols-2")}
        >
          <Field label="Name">
            <TextInput name="name" required placeholder="support" />
          </Field>
          <Field label="Address">
            <TextInput
              name="address"
              type="email"
              required
              placeholder="support@example.com"
            />
          </Field>
          <Field label="User (the address when empty)">
            <TextInput name="user" />
          </Field>
          <Field label="Password">
            <TextInput
              name="password"
              type="password"
              autoComplete="off"
              required
            />
          </Field>
          <Field label="IMAP server">
            <TextInput
              name="imapHost"
              required
              placeholder="imap.example.com"
            />
          </Field>
          <Field label="IMAP port (993 when empty)">
            <TextInput name="imapPort" inputMode="numeric" />
          </Field>
          <Field label="SMTP server">
            <TextInput
              name="smtpHost"
              required
              placeholder="smtp.example.com"
            />
          </Field>
          <Field label="SMTP port (465 when empty)">
            <TextInput name="smtpPort" inputMode="numeric" />
          </Field>
          <Checkbox
            name="secure"
            defaultChecked
            label="Use TLS from the start"
            className="md:col-span-2"
          />
          <div className="flex flex-wrap items-center gap-2 md:col-span-2">
            <Button variant="primary" type="submit">
              Add
            </Button>
            <Button
              onClick={() => {
                setAdding(false);
                setError(undefined);
              }}
            >
              Cancel
            </Button>
            <ErrorText size="caption">{error}</ErrorText>
          </div>
        </form>
      )}
      {!adding && locked === undefined && (
        <div>
          <Button
            onClick={() => {
              setAdding(true);
            }}
          >
            Add a mailbox
          </Button>
        </div>
      )}
      {locked !== undefined && (
        <p role="note" className="text-fg-dim">
          <code className="font-mono">{locked}</code> sets the mailboxes, so
          they are read-only here.
        </p>
      )}
    </div>
  );
}

function EmailReply({ text }: Omit<NoticeProps, "context">): ReactElement {
  return (
    <div className="flex flex-col gap-1 text-ui">
      <span className="text-label text-fg-dim">Reply by email</span>
      <span className="whitespace-pre-wrap text-fg">
        {text.split("\n\n").slice(1).join("\n\n")}
      </span>
    </div>
  );
}
