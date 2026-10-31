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
  Picker,
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
} from "../src/model";

export const gitHosts: WebPlugin = {
  name: "git-hosts",
  SettingsSection,
  PullRequest,
  notices: { pull_request: PullRequestNotice },
  repositories: async (context, query) =>
    json(context.request(`repositories?q=${encodeURIComponent(query)}`)),
};

function SettingsSection({
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
    <Section title="Git hosts">
      <p className="text-ui text-fg-dim">
        Your Sessions clone, push, use gh and install Profile packages as the
        accounts you connect here.
      </p>
      <ul
        aria-label="Your git hosts"
        className="flex flex-col gap-2 rounded-lg border border-line bg-elevated shadow-xs p-3 text-ui"
      >
        {value.hosts.length === 0 && (
          <li className="text-fg-dim">No hosts are listed yet.</li>
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
      </ul>
      <PullRequestChoices context={context} />
      {value.admin && <Hosts context={context} onChange={reload} />}
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
    <div className="flex flex-col gap-2">
      <h3 className="text-label font-medium text-fg-strong">Pull requests</h3>
      <Switch
        label="Auto-fix the pull requests my Sessions open"
        checked={value.autoFix}
        onChange={(autoFix) => {
          save({ autoFix });
        }}
      />
      <Switch
        label="Let Sessions reply on review threads as me"
        checked={value.reply}
        onChange={(reply) => {
          save({ reply });
        }}
      />
      <p className="text-label text-fg-dim">
        With auto-fix on, a Session hears when its pull request's checks fail,
        someone reviews it or it conflicts, and pushes fixes. Replies end with
        “via Pipoca”.
      </p>
      {error !== undefined && (
        <p role="alert" className="text-label text-failed">
          {error}
        </p>
      )}
    </div>
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
    <li className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="flex-1 truncate text-fg">
          {host.label}
          <span className="text-fg-dim">
            {host.label === host.host ? "" : ` · ${host.host}`}
            {login === undefined ? " · not connected" : ` · you are ${login}`}
          </span>
        </span>
        {login === undefined ? (
          <>
            {host.oauth && (
              <Button
                variant="primary"
                onClick={() => {
                  location.assign(
                    `/api/plugins/git-hosts/sign-in/${encodeURIComponent(host.host)}`,
                  );
                }}
              >
                Connect
              </Button>
            )}
            {!pasting && (
              <Button
                onClick={() => {
                  setPasting(true);
                }}
              >
                Use a token
              </Button>
            )}
          </>
        ) : (
          <Button
            aria-label={`Disconnect ${host.label}`}
            onClick={() => {
              void json(
                context.request(
                  `connections/${encodeURIComponent(host.host)}`,
                  { method: "DELETE" },
                ),
              ).then(onChange, onChange);
            }}
          >
            Disconnect
          </Button>
        )}
      </div>
      {pasting && login === undefined && (
        <form
          onSubmit={connect}
          aria-label={`Connect ${host.label} with a token`}
          className="flex flex-wrap items-center gap-2"
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
    </li>
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
    <div className="flex flex-col gap-2 text-ui">
      <p className="text-fg-dim">
        Hosts people can connect, kept in the server's pipoca.json. For a
        Connect button, register an OAuth app on the host with{" "}
        <code className="font-mono text-mono-sm">
          {location.origin}/api/plugins/git-hosts/callback
        </code>{" "}
        as its callback URL.
      </p>
      <ul
        aria-label="Hosts"
        className="flex flex-col gap-1 rounded-lg border border-line bg-elevated shadow-xs p-3"
      >
        {value?.map((host) => (
          <li key={host.host} className="flex items-center gap-2">
            <span className="flex-1 truncate text-fg">
              {host.label}
              <span className="text-fg-dim">
                {" "}
                · {host.host}
                {host.clientId === "" ? " · tokens" : " · OAuth app"}
              </span>
            </span>
            <Button
              onClick={() => {
                setEditing(host);
              }}
            >
              Edit
            </Button>
            <Button
              aria-label={`Remove ${host.host}`}
              onClick={() => {
                remove(host);
              }}
            >
              Remove
            </Button>
          </li>
        ))}
      </ul>
      {editing === undefined ? (
        <div>
          <Button
            onClick={() => {
              setEditing("new");
            }}
          >
            Add host
          </Button>
        </div>
      ) : (
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
    </div>
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
