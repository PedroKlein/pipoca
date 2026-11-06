import {
  ConfigForm,
  defineWeb,
  type NoticeProps,
  useApi,
  useLoaded,
  useViewer,
} from "@pipoca/plugins/web";
import {
  Button,
  cardClass,
  cn,
  ErrorText,
  Field,
  fieldClass,
  useConfirm,
} from "@pipoca/ui";
import { type ReactElement, type SubmitEvent, useState } from "react";
import { email } from "../plugin";
import type { MailboxView } from "../src/model";

export const web = defineWeb(email, {
  settings: { group: "integrations", Section },
  slots: { "notice:email_reply": EmailReply },
});

function Section(): ReactElement | null {
  if (!useViewer().admin) {
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
  );

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
              <Button
                aria-label={`Remove ${mailbox.name}`}
                onClick={() => {
                  remove(mailbox);
                }}
              >
                Remove
              </Button>
            </div>
            {mailbox.error !== null && (
              <p className="text-caption text-failed">{mailbox.error}</p>
            )}
          </li>
        ))}
      </ul>
      {adding ? (
        <form
          onSubmit={add}
          aria-label="New mailbox"
          className={cn(cardClass, "grid gap-4 p-5 md:grid-cols-2")}
        >
          <Field label="Name">
            <input
              name="name"
              required
              placeholder="support"
              className={fieldClass}
            />
          </Field>
          <Field label="Address">
            <input
              name="address"
              type="email"
              required
              placeholder="support@example.com"
              className={fieldClass}
            />
          </Field>
          <Field label="User (the address when empty)">
            <input name="user" className={fieldClass} />
          </Field>
          <Field label="Password">
            <input
              name="password"
              type="password"
              autoComplete="off"
              required
              className={fieldClass}
            />
          </Field>
          <Field label="IMAP server">
            <input
              name="imapHost"
              required
              placeholder="imap.example.com"
              className={fieldClass}
            />
          </Field>
          <Field label="IMAP port (993 when empty)">
            <input name="imapPort" inputMode="numeric" className={fieldClass} />
          </Field>
          <Field label="SMTP server">
            <input
              name="smtpHost"
              required
              placeholder="smtp.example.com"
              className={fieldClass}
            />
          </Field>
          <Field label="SMTP port (465 when empty)">
            <input name="smtpPort" inputMode="numeric" className={fieldClass} />
          </Field>
          <label className="flex items-center gap-2 text-fg-dim md:col-span-2">
            <input type="checkbox" name="secure" defaultChecked />
            Use TLS from the start
          </label>
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
      ) : (
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
