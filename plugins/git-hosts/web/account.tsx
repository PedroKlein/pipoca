import { useApi, useLoaded } from "@pipoca/plugins/web";
import {
  Badge,
  Button,
  cardClass,
  cn,
  ErrorText,
  Field,
  initialsOf,
  Row,
  Rows,
  Section,
  Select,
  Switch,
  TextInput,
} from "@pipoca/ui";
import { type ReactElement, type SubmitEvent, useState } from "react";
import { gitHosts } from "../plugin";
import type {
  Account,
  CommitIdentities,
  HostEmails,
  Identity,
  Preferences,
} from "../src/model";

export type HostChoice = Account["hosts"][number];

// The name and email the person's Sessions commit as on every runner: on
// each host they connected, and by default on the others (ADR 0072).
export function CommitAs({
  connected,
}: {
  readonly connected: readonly HostChoice[];
}): ReactElement | null {
  const api = useApi(gitHosts);

  const { value, reload } = useLoaded(
    async () => api.get<CommitIdentities>("commit-as"),
    "commit-as",
    { changes: ["commit-as"] },
  );

  if (value === undefined) {
    return null;
  }

  return (
    <Section title="Commit as">
      <p className="text-caption text-fg-dim">
        Sessions on every machine commit with these, picked by the
        repository&apos;s host. Leave one empty to use the default, and the
        default empty to use each machine&apos;s own git config.
      </p>
      {connected.map((host) => (
        <HostIdentity
          key={host.host}
          host={host}
          identity={value.hosts.find((each) => each.host === host.host)}
          onSaved={reload}
        />
      ))}
      <IdentityForm
        label={connected.length === 0 ? "Commit as" : "Default"}
        description={
          connected.length === 0 ? undefined : "For repositories on other hosts"
        }
        identity={value.default ?? undefined}
        emails={undefined}
        onSaved={reload}
      />
    </Section>
  );
}

// The emails come from the host. When it can't list them, any email does.
export function HostIdentity({
  host,
  identity,
  plain = false,
  onSaved,
}: {
  readonly host: HostChoice;
  readonly identity: Identity | undefined;
  readonly plain?: boolean;
  readonly onSaved: () => void;
}): ReactElement | null {
  const api = useApi(gitHosts);

  const { value } = useLoaded(
    async () =>
      api
        .get<HostEmails>(`emails/${encodeURIComponent(host.host)}`)
        .catch(() => null),
    `emails/${host.host}`,
    { changes: ["account"] },
  );

  if (value === undefined) {
    return null;
  }

  return (
    <IdentityForm
      label={host.label}
      {...(plain && {
        plain,
        description: `Filled from your ${host.label} account. The list holds its verified emails.`,
      })}
      host={host.host}
      identity={identity}
      suggestedName={value?.name ?? undefined}
      emails={
        value === null || value.emails.length === 0 ? undefined : value.emails
      }
      onSaved={onSaved}
    />
  );
}

export function IdentityForm({
  label,
  description,
  plain = false,
  host,
  identity,
  suggestedName,
  emails,
  onSaved,
}: {
  readonly label: string;
  readonly description?: string | undefined;
  // Without its card and title, inside another card such as a setup step's.
  readonly plain?: boolean;
  // Missing for the default.
  readonly host?: string;
  readonly identity: Identity | undefined;
  readonly suggestedName?: string | undefined;
  // The emails to pick from, or undefined to type one.
  readonly emails: readonly string[] | undefined;
  readonly onSaved: () => void;
}): ReactElement {
  const api = useApi(gitHosts);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);

  const choices =
    emails === undefined
      ? undefined
      : [
          ...emails,
          ...(identity !== undefined && !emails.includes(identity.email)
            ? [identity.email]
            : []),
        ];

  const submit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = form.get("email");

    api
      .post("commit-as", {
        ...(host !== undefined && { host }),
        // Picking "Use the default" clears the host's own.
        name: choices !== undefined && email === "" ? "" : form.get("name"),
        email,
      })
      .then(
        () => {
          setError(undefined);
          setSaved(true);
          onSaved();
        },
        (failure: unknown) => {
          setSaved(false);

          setError(
            failure instanceof Error ? failure.message : String(failure),
          );
        },
      );
  };

  return (
    <form
      aria-label={`Commit as on ${label}`}
      onSubmit={submit}
      onChange={() => {
        setSaved(false);
      }}
      className={cn(!plain && cn(cardClass, "p-4"), "flex flex-col gap-3")}
    >
      {!plain && (
        <div className="flex flex-wrap items-baseline gap-x-2.5">
          <h3 className="text-ui font-medium text-fg-strong">{label}</h3>
          {description !== undefined && (
            <span className="text-label text-fg-dim">{description}</span>
          )}
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name">
          <TextInput
            name="name"
            defaultValue={identity?.name ?? suggestedName ?? ""}
            autoComplete="name"
          />
        </Field>
        <Field label="Email">
          {choices === undefined ? (
            <TextInput
              name="email"
              type="email"
              defaultValue={identity?.email ?? ""}
              autoComplete="email"
            />
          ) : (
            <Select name="email" defaultValue={identity?.email ?? ""}>
              <option value="">Use the default</option>
              {choices.map((email) => (
                <option key={email} value={email}>
                  {email}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        {plain && description !== undefined && (
          <p className="basis-full text-caption text-fg-dim">{description}</p>
        )}
        <p role="status" className="flex-1 text-caption">
          {error !== undefined ? (
            <ErrorText inline size="inherit">
              {error}
            </ErrorText>
          ) : (
            saved && <span className="text-fg-dim">Saved</span>
          )}
        </p>
        <Button type="submit">Save</Button>
      </div>
    </form>
  );
}

// What a Session may do on its own about the pull requests it watches
// (ADR 0051).
export function PullRequestChoices(): ReactElement | null {
  const api = useApi(gitHosts);

  const { value, reload } = useLoaded(
    async () => api.get<Preferences>("preferences"),
    "preferences",
  );

  const [error, setError] = useState<string>();

  if (value === undefined) {
    return null;
  }

  const save = (change: Partial<Preferences>): void => {
    setError(undefined);

    api
      .post("preferences", { ...value, ...change })
      .then(reload, (failure: unknown) => {
        setError(failure instanceof Error ? failure.message : String(failure));
      });
  };

  return (
    <Section title="Pull requests">
      <Rows>
        <Row
          title="Fix my pull requests"
          description="When checks fail, a review comes in or it conflicts, the Session that opened it pushes a fix."
        >
          <Switch
            label="Auto-fix the pull requests my Sessions open"
            labelHidden
            checked={value.autoFix}
            onChange={(autoFix) => {
              save({ autoFix });
            }}
          />
        </Row>
        <Row
          title="Reply on review threads as me"
          description="Replies end with “via Pipoca”."
        >
          <Switch
            label="Let Sessions reply on review threads as me"
            labelHidden
            checked={value.reply}
            onChange={(reply) => {
              save({ reply });
            }}
          />
        </Row>
      </Rows>
      <ErrorText>{error}</ErrorText>
    </Section>
  );
}

export function HostRow({
  host,
  login,
  onChange,
}: {
  readonly host: Account["hosts"][number];
  readonly login: string | undefined;
  readonly onChange: () => void;
}): ReactElement {
  const api = useApi(gitHosts);
  const [pasting, setPasting] = useState(false);

  return (
    <Row
      initials={initialsOf(host.label)}
      title={
        <>
          {host.label}
          {login !== undefined && <Badge state="done">Connected</Badge>}
        </>
      }
      description={[
        ...(login === undefined ? [] : [`@${login}`]),
        ...(host.label === host.host ? [] : [host.host]),
      ].join(" · ")}
    >
      {login === undefined ? (
        <div className="flex gap-2">
          {!pasting && (
            <Button
              variant="ghost"
              onClick={() => {
                setPasting(true);
              }}
            >
              Use a token
            </Button>
          )}
          {host.oauth && (
            <Button
              onClick={() => {
                signIn(host.host);
              }}
            >
              Connect
            </Button>
          )}
        </div>
      ) : (
        <Button
          variant="ghost"
          aria-label={`Disconnect ${host.label}`}
          onClick={() => {
            void api
              .delete(`connections/${encodeURIComponent(host.host)}`)
              .then(onChange, onChange);
          }}
        >
          Disconnect
        </Button>
      )}
      {pasting && login === undefined && (
        <TokenForm
          host={host}
          onDone={(connected) => {
            setPasting(false);

            if (connected) {
              onChange();
            }
          }}
        />
      )}
    </Row>
  );
}

// The host's sign-in through its OAuth app, which comes back to then's
// setup step or to Accounts.
export function signIn(host: string, then?: "setup" | "server-setup"): void {
  location.assign(
    `/api/ext/${gitHosts.id}/sign-in/${encodeURIComponent(host)}${then === undefined ? "" : `?then=${then}`}`,
  );
}

// A personal access token, the fallback to the host's OAuth app.
export function TokenForm({
  host,
  onDone,
}: {
  readonly host: HostChoice;
  readonly onDone: (connected: boolean) => void;
}): ReactElement {
  const api = useApi(gitHosts);
  const [error, setError] = useState<string>();

  const connect = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const token = new FormData(event.currentTarget).get("token");

    api.post("connect", { host: host.host, token }).then(
      () => {
        setError(undefined);
        onDone(true);
      },
      (reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
  };

  return (
    <form
      onSubmit={connect}
      aria-label={`Connect ${host.label} with a token`}
      className="flex basis-full flex-wrap items-center gap-2"
    >
      <TextInput
        name="token"
        type="password"
        autoComplete="off"
        aria-label="Personal access token"
        placeholder="Personal access token with repo scope"
        className="flex-1"
      />
      <Button variant="primary" type="submit">
        Connect
      </Button>
      <Button
        onClick={() => {
          onDone(false);
        }}
      >
        Cancel
      </Button>
      <ErrorText size="caption" className="w-full">
        {error}
      </ErrorText>
    </form>
  );
}
