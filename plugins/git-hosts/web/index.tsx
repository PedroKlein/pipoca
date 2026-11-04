import {
  json,
  type NoticeProps,
  type PullRequestProps,
  useLoaded,
  type WebContext,
  type WebPlugin,
} from "@pipoca/plugins/web";
import {
  Badge,
  Button,
  Field,
  fieldClass,
  Icon,
  initialsOf,
  PageTitle,
  Picker,
  Row,
  Rows,
  Section,
  Switch,
} from "@pipoca/ui";
import { type ReactElement, type SubmitEvent, useState } from "react";
import type {
  Account,
  HostInput,
  HostView,
  Preferences,
  PullWatch,
  TechnicalUserView,
} from "../src/model";

export const gitHosts: WebPlugin = {
  name: "git-hosts",
  SettingsSection,
  settingsGroup: "server",
  settingsParts: { General: CodeChoices, Accounts },
  setupStep: {
    title: "Your code",
    summary: "GitHub or another git host",
    heading: "Connect your code",
    description:
      "Sessions clone, push and open pull requests as you. Connect the hosts where your repositories live.",
    optional: true,
    done: async (context) => {
      const account = await json<Account>(context.request("account"));

      return account.hosts.length === 0 || account.connections.length > 0;
    },
    Step: CodeStep,
  },
  PullRequest,
  notices: { pull_request: PullRequestNotice },
  repositories: async (context, query) =>
    json(context.request(`repositories?q=${encodeURIComponent(query)}`)),
};

// Admins pick the hosts people can connect and the bots routines act as
// (ADR 0063).
function SettingsSection({
  context,
}: {
  readonly context: WebContext;
}): ReactElement | null {
  const { value, reload } = useLoaded(
    async () => json<Account>(context.request("account")),
    "account",
  );

  if (value?.admin !== true) {
    return null;
  }

  return (
    <>
      <PageTitle description="The hosts people can connect and the bots routines act as. Everyone connects their own account in Accounts.">
        Git hosts
      </PageTitle>
      <Hosts context={context} onChange={reload} />
      <TechnicalUsers
        context={context}
        hosts={value.hosts.map(({ host }) => host)}
      />
    </>
  );
}

function Accounts({
  context,
}: {
  readonly context: WebContext;
}): ReactElement | null {
  const { value, reload } = useLoaded(
    async () => json<Account>(context.request("account")),
    "account",
  );

  if (value === undefined) {
    return null;
  }

  return (
    <Section title="Code">
      <Rows label="Your git hosts">
        {value.hosts.length === 0 && (
          <Row
            title="No hosts yet"
            description="An admin adds the hosts people can connect."
          />
        )}
        {value.hosts.map((host) => (
          <HostRow
            key={host.host}
            context={context}
            host={host}
            login={
              value.connections.find((each) => each.host === host.host)?.login
            }
            onChange={reload}
          />
        ))}
      </Rows>
    </Section>
  );
}

function CodeStep({ context }: { readonly context: WebContext }): ReactElement {
  return (
    <div className="-mt-8 flex flex-col">
      <Accounts context={context} />
      <CodeChoices context={context} />
    </div>
  );
}

function CodeChoices({
  context,
}: {
  readonly context: WebContext;
}): ReactElement {
  return (
    <>
      <CommitAs context={context} />
      <PullRequestChoices context={context} />
    </>
  );
}

interface Identity {
  readonly name: string;
  readonly email: string;
}

// The name and email the person's Sessions commit as, on every runner.
function CommitAs({
  context,
}: {
  readonly context: WebContext;
}): ReactElement | null {
  const { value, reload } = useLoaded(
    async () => json<Identity | null>(context.request("commit-as")),
    "commit-as",
  );

  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);

  if (value === undefined) {
    return null;
  }

  const submit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);

    json(
      context.request("commit-as", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: form.get("name"),
          email: form.get("email"),
        }),
      }),
    ).then(
      () => {
        setError(undefined);
        setSaved(true);
        reload();
      },
      (failure: unknown) => {
        setSaved(false);
        setError(failure instanceof Error ? failure.message : String(failure));
      },
    );
  };

  return (
    <Section title="Commit as">
      <form
        aria-label="Commit as"
        onSubmit={submit}
        onChange={() => {
          setSaved(false);
        }}
        className="flex flex-col gap-2"
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name">
            <input
              name="name"
              defaultValue={value?.name ?? ""}
              autoComplete="name"
              className={fieldClass}
            />
          </Field>
          <Field label="Email">
            <input
              name="email"
              type="email"
              defaultValue={value?.email ?? ""}
              autoComplete="email"
              className={fieldClass}
            />
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <p className="flex-1 text-caption text-fg-dim">
            Sessions on every machine commit with these. Leave both empty to use
            each machine&apos;s own git config.
          </p>
          <Button type="submit">Save</Button>
        </div>
        <p role="status" className="text-caption">
          {error !== undefined ? (
            <span className="text-failed">{error}</span>
          ) : (
            saved && <span className="text-fg-dim">Saved</span>
          )}
        </p>
      </form>
    </Section>
  );
}

// What a Session may do on its own about the pull requests it watches
// (ADR 0051).
function PullRequestChoices({
  context,
}: {
  readonly context: WebContext;
}): ReactElement | null {
  const { value, reload } = useLoaded(
    async () => json<Preferences>(context.request("preferences")),
    "preferences",
  );

  const [error, setError] = useState<string>();

  if (value === undefined) {
    return null;
  }

  const save = (change: Partial<Preferences>): void => {
    setError(undefined);

    json(
      context.request("preferences", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...value, ...change }),
      }),
    ).then(reload, (failure: unknown) => {
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
      {error !== undefined && (
        <p role="alert" className="text-label text-failed">
          {error}
        </p>
      )}
    </Section>
  );
}

// A watched pull request's checks, reviews and conflicts, with Auto-fix and
// Merge, beside it on the Changes panel (ADR 0051).
function PullRequest({
  context,
  session,
  url,
}: PullRequestProps): ReactElement | null {
  const { value, reload } = useLoaded(
    async () =>
      json<readonly PullWatch[]>(
        context.request(
          `pull-requests?session=${encodeURIComponent(session.id)}`,
        ),
      ),
    `pull-requests ${session.id}`,
    { topics: ["git-hosts.pull-requests"] },
  );

  const [error, setError] = useState<string>();
  const watch = value?.find((each) => each.url === url);

  if (watch === undefined) {
    return null;
  }

  const problem = error ?? watch.error;

  const post = (action: string, body: unknown): void => {
    setError(undefined);

    json(
      context.request(`pull-requests/${watch.id}/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    ).then(reload, (failure: unknown) => {
      setError(failure instanceof Error ? failure.message : String(failure));
    });
  };

  return (
    <div className="flex flex-wrap items-center justify-end gap-1.5">
      <PullBadges watch={watch} />
      <Picker
        label="Pull request"
        options={[{ value: "auto-fix", label: "Auto-fix" }]}
        selected={watch.autoFix ? ["auto-fix"] : []}
        multiple
        actions={
          watch.state === "open"
            ? [
                {
                  label: "Merge",
                  run: () => {
                    post("merge", {});
                  },
                },
              ]
            : []
        }
        onChange={(values) => {
          post("auto-fix", { on: values.includes("auto-fix") });
        }}
      >
        <Icon name="more" className="size-3.5" />
      </Picker>
      {problem !== null && (
        <p role="alert" className="w-full text-right text-label text-failed">
          {problem}
        </p>
      )}
    </div>
  );
}

function PullBadges({
  watch: { state, checks, conflicts, changesRequested },
}: {
  readonly watch: PullWatch;
}): ReactElement {
  if (state !== "open") {
    return (
      <Badge state="done">{state === "merged" ? "Merged" : "Closed"}</Badge>
    );
  }

  return (
    <>
      {checks.failed > 0 && (
        <Badge state="failed">{`${String(checks.failed)} failed`}</Badge>
      )}
      {checks.failed === 0 && checks.pending > 0 && (
        <Badge state="working">Checks running</Badge>
      )}
      {checks.failed === 0 && checks.pending === 0 && checks.passed > 0 && (
        <Badge state="done">Checks passed</Badge>
      )}
      {changesRequested && <Badge state="waiting">Changes requested</Badge>}
      {conflicts === true && <Badge state="failed">Conflicts</Badge>}
    </>
  );
}

// The news Pipoca sent the Session about a pull request it watches.
function PullRequestNotice({ data }: NoticeProps): ReactElement {
  const { url, news } = (data ?? {}) as {
    url?: unknown;
    news?: unknown;
  };

  const lines = Array.isArray(news)
    ? news.filter((line): line is string => typeof line === "string")
    : [];

  return (
    <div className="flex min-w-0 flex-col gap-1 px-2 py-1 text-label text-fg-dim">
      <p className="flex min-w-0 items-center gap-2">
        <Icon name="git-pull-request" className="size-4 shrink-0" />
        <span className="truncate">
          News on{" "}
          <a
            href={typeof url === "string" ? url : undefined}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-fg"
          >
            {typeof url === "string"
              ? url.replace(/^https:\/\//, "")
              : "a pull request"}
          </a>
        </span>
      </p>
      {lines.length > 0 && (
        <ul className="ml-6 list-disc">
          {lines.map((line) => (
            <li key={line} className="break-words">
              {line}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function HostRow({
  context,
  host,
  login,
  onChange,
}: {
  readonly context: WebContext;
  readonly host: Account["hosts"][number];
  readonly login: string | undefined;
  readonly onChange: () => void;
}): ReactElement {
  const [pasting, setPasting] = useState(false);
  const [error, setError] = useState<string>();

  const connect = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const token = new FormData(event.currentTarget).get("token");

    json(
      context.request("connect", {
        method: "POST",
        body: JSON.stringify({ host: host.host, token }),
      }),
    ).then(
      () => {
        setPasting(false);
        setError(undefined);
        onChange();
      },
      (reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
  };

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
                location.assign(
                  `/api/plugins/git-hosts/sign-in/${encodeURIComponent(host.host)}`,
                );
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
            void json(
              context.request(`connections/${encodeURIComponent(host.host)}`, {
                method: "DELETE",
              }),
            ).then(onChange, onChange);
          }}
        >
          Disconnect
        </Button>
      )}
      {pasting && login === undefined && (
        <form
          onSubmit={connect}
          aria-label={`Connect ${host.label} with a token`}
          className="flex basis-full flex-wrap items-center gap-2"
        >
          <input
            name="token"
            type="password"
            autoComplete="off"
            aria-label="Personal access token"
            placeholder="Personal access token with repo scope"
            className={`${fieldClass} flex-1`}
          />
          <Button variant="primary" type="submit">
            Connect
          </Button>
          <Button
            onClick={() => {
              setPasting(false);
            }}
          >
            Cancel
          </Button>
          {error !== undefined && (
            <p role="alert" className="w-full text-caption text-failed">
              {error}
            </p>
          )}
        </form>
      )}
    </Row>
  );
}

function Hosts({
  context,
  onChange,
}: {
  readonly context: WebContext;
  readonly onChange: () => void;
}): ReactElement {
  const { value, reload } = useLoaded(
    async () => json<readonly HostView[]>(context.request("hosts")),
    "hosts",
  );

  const [editing, setEditing] = useState<HostView | "new">();

  const changed = (): void => {
    setEditing(undefined);
    reload();
    onChange();
  };

  const remove = (host: HostView): void => {
    if (!confirm(`Sessions will stop signing in to ${host.host}.`)) {
      return;
    }

    void json(
      context.request(`hosts/${encodeURIComponent(host.host)}`, {
        method: "DELETE",
      }),
    ).then(changed, changed);
  };

  return (
    <Section
      title="Hosts"
      description="People connect their own account on each, in Accounts"
      actions={
        editing === undefined && (
          <Button
            onClick={() => {
              setEditing("new");
            }}
          >
            <Icon name="plus" />
            Add host
          </Button>
        )
      }
    >
      {editing !== undefined && (
        <HostForm
          key={editing === "new" ? "new" : editing.host}
          host={editing === "new" ? undefined : editing}
          save={async (input) => {
            await json(
              context.request(
                editing === "new"
                  ? "hosts"
                  : `hosts/${encodeURIComponent(editing.host)}`,
                { method: "POST", body: JSON.stringify(input) },
              ),
            );

            changed();
          }}
          cancel={() => {
            setEditing(undefined);
          }}
        />
      )}
      <Rows label="Hosts">
        {value?.length === 0 && (
          <Row
            title="No hosts yet"
            description="Add GitHub, GitHub Enterprise or another host."
          />
        )}
        {value?.map((host) => (
          <Row
            key={host.host}
            initials={initialsOf(host.label)}
            title={
              <>
                {host.label}
                <Badge state="offline">
                  {host.clientId === "" ? "Tokens" : "OAuth app"}
                </Badge>
              </>
            }
            description={<span className="font-mono">{host.host}</span>}
          >
            <Button
              variant="ghost"
              aria-label={`Edit ${host.host}`}
              onClick={() => {
                setEditing(host);
              }}
            >
              Edit
            </Button>
            <Button
              variant="ghost"
              aria-label={`Remove ${host.host}`}
              onClick={() => {
                remove(host);
              }}
            >
              Remove
            </Button>
          </Row>
        ))}
      </Rows>
      <p className="text-caption text-fg-dim">
        For a Connect button, register an OAuth app on the host with{" "}
        <code className="font-mono text-mono-sm">
          {location.origin}/api/plugins/git-hosts/callback
        </code>{" "}
        as its callback URL. Hosts are kept in the server&apos;s pipoca.json.
      </p>
    </Section>
  );
}

function HostForm({
  host,
  save,
  cancel,
}: {
  readonly host: HostView | undefined;
  readonly save: (input: HostInput) => Promise<void>;
  readonly cancel: () => void;
}): ReactElement {
  const [error, setError] = useState<string>();

  const submit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);

    const text = (name: string): string => {
      const value = form.get(name);

      return typeof value === "string" ? value : "";
    };

    save({
      host: host?.host ?? text("host"),
      label: text("label"),
      clientId: text("clientId"),
      clientSecret:
        form.get("removeSecret") === "on" ? null : text("clientSecret"),
    }).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason));
    });
  };

  return (
    <form
      onSubmit={submit}
      aria-label={host ? `Edit ${host.host}` : "New host"}
      className="grid gap-4 rounded-lg border border-line bg-elevated shadow-xs p-5 md:grid-cols-2"
    >
      <Field label="Host">
        <input
          name="host"
          defaultValue={host?.host ?? ""}
          disabled={host !== undefined}
          placeholder="github.example.com"
          className={fieldClass}
        />
      </Field>
      <Field label="Label">
        <input
          name="label"
          defaultValue={host?.label ?? ""}
          placeholder="Company GitHub"
          className={fieldClass}
        />
      </Field>
      <Field label="OAuth app client ID (optional)">
        <input
          name="clientId"
          defaultValue={host?.clientId ?? ""}
          className={fieldClass}
        />
      </Field>
      <Field label={secretLabel(host)}>
        <input
          name="clientSecret"
          type="password"
          autoComplete="off"
          className={fieldClass}
        />
      </Field>
      {host?.hasClientSecret === true && (
        <label className="flex items-center gap-2 text-fg-dim">
          <input type="checkbox" name="removeSecret" />
          Remove the client secret
        </label>
      )}
      <div className="flex flex-wrap items-center gap-2 md:col-span-2">
        <Button variant="primary" type="submit">
          {host ? "Save" : "Add host"}
        </Button>
        <Button onClick={cancel}>Cancel</Button>
        {error !== undefined && (
          <p role="alert" className="text-caption text-failed">
            {error}
          </p>
        )}
      </div>
    </form>
  );
}

function secretLabel(host: HostView | undefined): string {
  const env = host?.clientSecretEnv ?? null;

  if (env !== null) {
    return `Client secret (from ${env}; leave empty to keep it)`;
  }

  return host?.hasClientSecret === true
    ? "Client secret (set; leave empty to keep it)"
    : "OAuth app client secret";
}

// Bot identities that routines and the factory act as instead of a person
// (ADR 0060).
function TechnicalUsers({
  context,
  hosts,
}: {
  readonly context: WebContext;
  readonly hosts: readonly string[];
}): ReactElement {
  const { value, reload } = useLoaded(
    async () =>
      json<readonly TechnicalUserView[]>(context.request("technical-users")),
    "technical-users",
  );

  const [adding, setAdding] = useState<"app" | "token">();
  const [error, setError] = useState<string>();

  const text = (form: FormData, name: string): string => {
    const field = form.get(name);

    return typeof field === "string" ? field.trim() : "";
  };

  const createApp = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);

    const params = new URLSearchParams({
      host: text(form, "host"),
      name: text(form, "name"),
      organization: text(form, "organization"),
    });

    location.assign(
      `/api/plugins/git-hosts/technical-users/new-app?${params.toString()}`,
    );
  };

  const addMachineUser = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);

    json(
      context.request("technical-users", {
        method: "POST",
        body: JSON.stringify({
          host: text(form, "host"),
          name: text(form, "name"),
          token: text(form, "token"),
        }),
      }),
    ).then(
      () => {
        setAdding(undefined);
        setError(undefined);
        reload();
      },
      (reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
  };

  const remove = (user: TechnicalUserView): void => {
    if (!confirm(`Routines acting as ${user.name} will stop.`)) {
      return;
    }

    void json(
      context.request(`technical-users/${encodeURIComponent(user.name)}`, {
        method: "DELETE",
      }),
    ).then(reload, reload);
  };

  const hostField = (
    <Field label="Host">
      <select name="host" className={fieldClass}>
        {hosts.map((host) => (
          <option key={host} value={host}>
            {host}
          </option>
        ))}
      </select>
    </Field>
  );

  return (
    <Section
      title="Technical users"
      description="Bots routines act as, so their pull requests and comments aren't yours"
      actions={
        adding === undefined && (
          <>
            <Button
              onClick={() => {
                setAdding("token");
              }}
            >
              Add a machine user
            </Button>
            <Button
              onClick={() => {
                setAdding("app");
              }}
            >
              <Icon name="plus" />
              Create a GitHub App
            </Button>
          </>
        )
      }
    >
      <Rows label="Technical users">
        {value?.length === 0 && (
          <Row
            title="No technical users yet"
            description="A GitHub App is best: its keys stay on this server."
          />
        )}
        {value?.map((user) => (
          <Row
            key={user.name}
            initials={initialsOf(user.name)}
            title={
              <>
                {user.name}
                <Badge state="offline">
                  {user.kind === "app" ? "GitHub App" : "Machine user"}
                </Badge>
              </>
            }
            description={
              <span className="flex flex-col gap-0.5">
                <span>
                  {user.login} on {user.host}
                  {user.installedOn !== null &&
                    (user.installedOn.length === 0
                      ? " · not installed yet"
                      : ` · installed on ${user.installedOn.join(", ")}`)}
                </span>
                {user.error !== null && (
                  <span className="text-failed">{user.error}</span>
                )}
              </span>
            }
          >
            {user.installUrl !== null && (
              <a
                href={user.installUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-control items-center rounded-md px-3 text-ui font-medium text-fg-dim hover:bg-hover hover:text-fg"
              >
                Install
              </a>
            )}
            <Button
              variant="ghost"
              aria-label={`Remove ${user.name}`}
              onClick={() => {
                remove(user);
              }}
            >
              Remove
            </Button>
          </Row>
        ))}
      </Rows>
      {adding === "app" && (
        <form
          onSubmit={createApp}
          aria-label="New GitHub App"
          className="grid gap-4 rounded-lg border border-line bg-elevated shadow-xs p-5 md:grid-cols-2"
        >
          {hostField}
          <Field label="App name">
            <input
              name="name"
              required
              placeholder="Acme Pipoca bot"
              className={fieldClass}
            />
          </Field>
          <Field label="Organization that owns it (optional)">
            <input name="organization" className={fieldClass} />
          </Field>
          <p className="text-label text-fg-dim md:col-span-2">
            The host asks you to confirm the App, then sends you back here.
            Install it on the accounts it should work in after that.
          </p>
          <div className="flex gap-2 md:col-span-2">
            <Button variant="primary" type="submit">
              Continue on the host
            </Button>
            <Button
              onClick={() => {
                setAdding(undefined);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
      {adding === "token" && (
        <form
          onSubmit={addMachineUser}
          aria-label="New machine user"
          className="grid gap-4 rounded-lg border border-line bg-elevated shadow-xs p-5 md:grid-cols-2"
        >
          {hostField}
          <Field label="Name">
            <input
              name="name"
              required
              placeholder="ci-bot"
              className={fieldClass}
            />
          </Field>
          <Field label="The account's personal access token">
            <input
              name="token"
              type="password"
              autoComplete="off"
              required
              className={fieldClass}
            />
          </Field>
          <div className="flex flex-wrap items-center gap-2 md:col-span-2">
            <Button variant="primary" type="submit">
              Add
            </Button>
            <Button
              onClick={() => {
                setAdding(undefined);
                setError(undefined);
              }}
            >
              Cancel
            </Button>
            {error !== undefined && (
              <p role="alert" className="text-caption text-failed">
                {error}
              </p>
            )}
          </div>
        </form>
      )}
    </Section>
  );
}
