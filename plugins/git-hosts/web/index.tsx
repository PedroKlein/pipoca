import {
  defineWeb,
  type MountedSession,
  type NoticeProps,
  useApi,
  useLoaded,
} from "@pipoca/plugins/web";
import {
  Badge,
  Button,
  buttonClass,
  cardClass,
  Checkbox,
  cn,
  ErrorText,
  Field,
  Icon,
  initialsOf,
  Page,
  Picker,
  Row,
  Rows,
  Section,
  Select,
  Step,
  Stepper,
  type StepState,
  Switch,
  TextInput,
  useConfirm,
} from "@pipoca/ui";
import type { RepositoryChoice } from "@pipoca/protocol";
import { type ReactElement, type SubmitEvent, useState } from "react";
import { gitHosts } from "../plugin";
import type {
  Account,
  HostInput,
  HostView,
  Preferences,
  PullWatch,
  TechnicalUserView,
  WatchedPull,
} from "../src/model";

// The pull request a Session opened, as the changes plugin's panel shows it
// (ADR 0051). Declared here as changes declares it, since a plugin imports
// no other plugin.
declare module "@pipoca/plugins/web" {
  interface Slots {
    "pullRequest.status": {
      readonly session: MountedSession;
      readonly url: string;
    };
  }
}

export const web = defineWeb(gitHosts, {
  settings: { group: "server", Section: SettingsSection },
  setup: [
    {
      audience: "person",
      after: "welcome",
      title: "Your code",
      summary: "GitHub or another git host",
      heading: "Connect your code",
      description:
        "Sessions clone, push and open pull requests as you. Connect the hosts where your repositories live.",
      optional: true,
      done: async (api) => {
        const account = await api.get<Account>("account");

        return account.hosts.length === 0 || account.connections.length > 0;
      },
      changes: ["account"],
      Step: CodeStep,
    },
  ],
  panels: { pulls: { title: "Pull requests", Panel: TeamPullRequests } },
  slots: {
    "settings.general": CodeChoices,
    "settings.accounts": Accounts,
    "pullRequest.status": PullRequest,
    "notice:pull_request": PullRequestNotice,
  },
  repositories: async (query, team, api) =>
    api.get<readonly RepositoryChoice[]>(`${team ? "team/" : ""}repositories`, {
      q: query,
    }),
});

// Admins pick the hosts people can connect and the bots routines act as
// (ADR 0063).
function SettingsSection(): ReactElement | null {
  const api = useApi(gitHosts);

  const { value, reload } = useLoaded(
    async () => api.get<Account>("account"),
    "account",
    { changes: ["account", "hosts"] },
  );

  const [adding, setAdding] = useState(false);

  if (value?.admin !== true) {
    return null;
  }

  return (
    <Page
      title="Git hosts"
      description="Only admins see this page. It lists the hosts people can connect and the bots routines act as. Everyone else connects their own account in Accounts."
      actions={
        !adding && (
          <Button
            onClick={() => {
              setAdding(true);
            }}
          >
            <Icon name="plus" />
            Add a host
          </Button>
        )
      }
    >
      <Hosts adding={adding} onAdding={setAdding} onChange={reload} />
      <Bots hosts={value.hosts.map(({ host }) => host)} />
    </Page>
  );
}

function Accounts(): ReactElement | null {
  const api = useApi(gitHosts);

  const { value, reload } = useLoaded(
    async () => api.get<Account>("account"),
    "account",
    { changes: ["account", "hosts"] },
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

function CodeStep(): ReactElement {
  return (
    <div className="-mt-8 flex flex-col">
      <Accounts />
      <CodeChoices />
    </div>
  );
}

function CodeChoices(): ReactElement {
  return (
    <>
      <CommitAs />
      <PullRequestChoices />
    </>
  );
}

interface Identity {
  readonly name: string;
  readonly email: string;
}

// The name and email the person's Sessions commit as, on every runner.
function CommitAs(): ReactElement | null {
  const api = useApi(gitHosts);

  const { value, reload } = useLoaded(
    async () => api.get<Identity | null>("commit-as"),
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

    api
      .post("commit-as", {
        name: form.get("name"),
        email: form.get("email"),
      })
      .then(
        () => {
          setError(undefined);
          setSaved(true);
          reload();
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
            <TextInput
              name="name"
              defaultValue={value?.name ?? ""}
              autoComplete="name"
            />
          </Field>
          <Field label="Email">
            <TextInput
              name="email"
              type="email"
              defaultValue={value?.email ?? ""}
              autoComplete="email"
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
            <ErrorText inline size="inherit">
              {error}
            </ErrorText>
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
function PullRequestChoices(): ReactElement | null {
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

// A watched pull request's checks, reviews and conflicts, with Auto-fix and
// Merge, beside it on the Changes panel (ADR 0051).
function PullRequest({
  session,
  url,
}: {
  readonly session: MountedSession;
  readonly url: string;
}): ReactElement | null {
  const api = useApi(gitHosts);

  const { value, reload } = useLoaded(
    async () =>
      api.get<readonly PullWatch[]>("pull-requests", { session: session.id }),
    `pull-requests ${session.id}`,
    { changes: ["pull-requests"] },
  );

  const [error, setError] = useState<string>();
  const watch = value?.find((each) => each.url === url);

  if (watch === undefined) {
    return null;
  }

  const problem = error ?? watch.error;

  const post = (action: string, body: unknown): void => {
    setError(undefined);

    api
      .post(`pull-requests/${watch.id}/${action}`, body)
      .then(reload, (failure: unknown) => {
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
        <ErrorText className="w-full text-right">{problem}</ErrorText>
      )}
    </div>
  );
}

// The pull requests team work watches, for the team hub.
function TeamPullRequests(): ReactElement {
  const api = useApi(gitHosts);

  const list = useLoaded(
    async () => api.get<readonly WatchedPull[]>("team/watched"),
    "team-pulls",
    { changes: ["pull-requests"] },
  ).value;

  if (list === undefined) {
    return <p className="text-label text-fg-dim">Loading…</p>;
  }

  if (list.length === 0) {
    return (
      <p className="text-label text-fg-dim">No pull requests to show yet.</p>
    );
  }

  return (
    <ul aria-label="Pull requests" className="flex flex-col gap-2.5">
      {list.map((pull) => (
        <li key={pull.id} className="flex flex-wrap items-center gap-1.5">
          <span className="flex min-w-0 flex-1 basis-40 flex-col">
            <a
              href={pull.url}
              target="_blank"
              rel="noreferrer"
              className="truncate text-label font-medium text-fg-strong hover:underline focus-visible:underline"
            >
              {pull.title}
            </a>
            <span className="text-caption text-fg-dim">{pull.repository}</span>
          </span>
          <PullBadges watch={pull} />
        </li>
      ))}
    </ul>
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
function PullRequestNotice({ data }: Pick<NoticeProps, "data">): ReactElement {
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
  const [error, setError] = useState<string>();

  const connect = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const token = new FormData(event.currentTarget).get("token");

    api.post("connect", { host: host.host, token }).then(
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
                  `/api/ext/${gitHosts.id}/sign-in/${encodeURIComponent(host.host)}`,
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
            void api
              .delete(`connections/${encodeURIComponent(host.host)}`)
              .then(onChange, onChange);
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
              setPasting(false);
            }}
          >
            Cancel
          </Button>
          <ErrorText size="caption" className="w-full">
            {error}
          </ErrorText>
        </form>
      )}
    </Row>
  );
}

function Hosts({
  adding,
  onAdding,
  onChange,
}: {
  readonly adding: boolean;
  readonly onAdding: (adding: boolean) => void;
  readonly onChange: () => void;
}): ReactElement {
  const api = useApi(gitHosts);
  const [ask, asking] = useConfirm();

  const { value, reload } = useLoaded(
    async () => api.get<readonly HostView[]>("hosts"),
    "hosts",
  );

  const [editing, setEditing] = useState<HostView>();
  const [settingUp, setSettingUp] = useState<string>();

  const changed = (): void => {
    setEditing(undefined);
    onAdding(false);
    reload();
    onChange();
  };

  const save = async (path: string, input: object): Promise<void> => {
    await api.post(path, input);

    reload();
    onChange();
  };

  const remove = (host: HostView): void => {
    void ask({
      title: `Remove ${host.host}?`,
      description: `Sessions will stop signing in to ${host.host}.`,
      confirm: "Remove",
      danger: true,
    }).then((yes) => {
      if (!yes) {
        return;
      }

      void api
        .delete(`hosts/${encodeURIComponent(host.host)}`)
        .then(changed, changed);
    });
  };

  const form = adding ? "new" : editing;
  const setUp = value?.find(({ host }) => host === settingUp);

  return (
    <Section title="Hosts">
      {asking}
      {form !== undefined && (
        <HostForm
          key={form === "new" ? "new" : form.host}
          host={form === "new" ? undefined : form}
          save={async (input) => {
            await save(
              form === "new"
                ? "hosts"
                : `hosts/${encodeURIComponent(form.host)}`,
              input,
            );

            changed();
          }}
          remove={
            form === "new"
              ? undefined
              : () => {
                  remove(form);
                }
          }
          cancel={() => {
            setEditing(undefined);
            onAdding(false);
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
                {host.clientId === "" ? (
                  <Badge state="waiting">Tokens only</Badge>
                ) : (
                  <Badge state="done">Sign-in ready</Badge>
                )}
              </>
            }
            description={hostDescription(host)}
          >
            <Button
              variant="ghost"
              aria-label={`Edit ${host.host}`}
              onClick={() => {
                onAdding(false);
                setEditing(host);
              }}
            >
              Edit
            </Button>
            {host.clientId === "" && settingUp !== host.host && (
              <Button
                variant="primary"
                aria-label={`Set up Connect for ${host.host}`}
                onClick={() => {
                  setSettingUp(host.host);
                }}
              >
                Set up Connect
              </Button>
            )}
          </Row>
        ))}
      </Rows>
      {setUp !== undefined && (
        <ConnectSetup
          host={setUp}
          save={async (clientId, clientSecret) => {
            await save(`hosts/${encodeURIComponent(setUp.host)}`, {
              host: setUp.host,
              label: setUp.label,
              clientId,
              clientSecret,
            });
          }}
          close={() => {
            setSettingUp(undefined);
          }}
        />
      )}
    </Section>
  );
}

function hostDescription(host: HostView): string {
  const where = host.label === host.host ? kindOf(host.host) : host.host;

  return host.clientId === ""
    ? `${where} · people paste a token until a Connect button is set up`
    : `${where} · OAuth app · ${String(host.connected)} ${host.connected === 1 ? "person" : "people"} connected`;
}

function kindOf(host: string): string {
  return host === "github.com" ? "GitHub" : "GitHub Enterprise";
}

// Registering an OAuth app on the host gives everyone a Connect button
// instead of pasting a token.
function ConnectSetup({
  host,
  save,
  close,
}: {
  readonly host: HostView;
  readonly save: (clientId: string, clientSecret: string) => Promise<void>;
  readonly close: () => void;
}): ReactElement {
  const [opened, setOpened] = useState(false);
  const [error, setError] = useState<string>();
  const saved = host.clientId !== "";
  const callback = `${location.origin}/api/ext/git-hosts/callback`;

  const submit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);

    const text = (name: string): string => {
      const field = form.get(name);

      return typeof field === "string" ? field.trim() : "";
    };

    save(text("clientId"), text("clientSecret")).then(
      () => {
        setError(undefined);
      },
      (reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
  };

  const stepState = (step: number): StepState => {
    const at = [true, opened, saved].lastIndexOf(true) + 1;

    if (step < at) {
      return "done";
    }

    return step === at ? "current" : "next";
  };

  return (
    <section
      aria-label={`Set up Connect for ${host.host}`}
      className="flex flex-col gap-4 rounded-lg border border-dashed border-line-strong bg-elevated p-5"
    >
      <div className="flex items-center gap-2">
        <h3 className="flex-1 text-ui font-medium text-fg-strong">
          Set up Connect for {host.host}
        </h3>
        <Button variant="ghost" onClick={close}>
          {saved ? "Done" : "Cancel"}
        </Button>
      </div>
      <Stepper>
        <Step
          number={1}
          state={stepState(1)}
          title={
            <a
              href={`https://${host.host}/settings/applications/new`}
              target="_blank"
              rel="noreferrer"
              onClick={() => {
                setOpened(true);
              }}
              className="underline decoration-line-strong underline-offset-4 hover:decoration-fg"
            >
              Open the host&apos;s new OAuth app page
            </a>
          }
        >
          <span>
            Name it Pipoca, with homepage{" "}
            <code className="font-mono text-mono-sm">{location.origin}</code>{" "}
            and callback URL{" "}
            <code className="font-mono text-mono-sm break-all">{callback}</code>
            .
          </span>
        </Step>
        <Step
          number={2}
          state={stepState(2)}
          title="Paste the Client ID and secret it shows"
        >
          {!saved && (
            <form
              onSubmit={submit}
              className="mt-2 grid gap-2 sm:grid-cols-[1fr_1fr_auto]"
            >
              <TextInput
                name="clientId"
                required
                aria-label="Client ID"
                placeholder="Client ID"
                onFocus={() => {
                  setOpened(true);
                }}
              />
              <TextInput
                name="clientSecret"
                type="password"
                autoComplete="off"
                required
                aria-label="Client secret"
                placeholder="Client secret"
              />
              <Button variant="primary" type="submit">
                Save
              </Button>
              <ErrorText size="caption" className="sm:col-span-3">
                {error}
              </ErrorText>
            </form>
          )}
        </Step>
        <Step
          number={3}
          state={stepState(3)}
          title="Try it"
          description="We'll sign you in once to check it works."
        >
          {saved && (
            <Button
              className="mt-2 self-start"
              onClick={() => {
                location.assign(
                  `/api/ext/${gitHosts.id}/sign-in/${encodeURIComponent(host.host)}`,
                );
              }}
            >
              Connect your account
            </Button>
          )}
        </Step>
      </Stepper>
    </section>
  );
}

function HostForm({
  host,
  save,
  remove,
  cancel,
}: {
  readonly host: HostView | undefined;
  readonly save: (input: HostInput) => Promise<void>;
  readonly remove: (() => void) | undefined;
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
      className={cn(cardClass, "grid gap-4 p-5 md:grid-cols-2")}
    >
      <Field label="Host">
        <TextInput
          name="host"
          defaultValue={host?.host ?? ""}
          disabled={host !== undefined}
          placeholder="github.example.com"
        />
      </Field>
      <Field label="Label">
        <TextInput
          name="label"
          defaultValue={host?.label ?? ""}
          placeholder="Company GitHub"
        />
      </Field>
      <Field label="OAuth app client ID (optional)">
        <TextInput name="clientId" defaultValue={host?.clientId ?? ""} />
      </Field>
      <Field label={secretLabel(host)}>
        <TextInput name="clientSecret" type="password" autoComplete="off" />
      </Field>
      {host?.hasClientSecret === true && (
        <Checkbox name="removeSecret" label="Remove the client secret" />
      )}
      <div className="flex flex-wrap items-center gap-2 md:col-span-2">
        <Button variant="primary" type="submit">
          {host ? "Save" : "Add host"}
        </Button>
        <Button onClick={cancel}>Cancel</Button>
        {remove !== undefined && (
          <Button
            variant="danger"
            className="ml-auto"
            aria-label={`Remove ${host?.host ?? ""}`}
            onClick={remove}
          >
            Remove host
          </Button>
        )}
        <ErrorText size="caption">{error}</ErrorText>
      </div>
    </form>
  );
}

function secretLabel(host: HostView | undefined): string {
  return host?.hasClientSecret === true
    ? "Client secret (set; leave empty to keep it)"
    : "OAuth app client secret";
}

function botDescription(user: TechnicalUserView): string {
  if (user.installedOn === null) {
    return `${user.host} · acts as ${user.login}`;
  }

  return user.installedOn.length === 0
    ? "Not installed yet · keys stay on this server"
    : `Installed on ${user.installedOn.join(", ")} · keys stay on this server`;
}

// Bot identities that routines and the factory act as instead of a person
// (ADR 0060).
function Bots({ hosts }: { readonly hosts: readonly string[] }): ReactElement {
  const api = useApi(gitHosts);
  const [ask, asking] = useConfirm();

  const { value, reload } = useLoaded(
    async () => api.get<readonly TechnicalUserView[]>("technical-users"),
    "technical-users",
  );

  const [adding, setAdding] = useState<"app" | "token">();
  const [managing, setManaging] = useState<string>();
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
      `/api/ext/${gitHosts.id}/technical-users/new-app?${params.toString()}`,
    );
  };

  const addMachineUser = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);

    api
      .post("technical-users", {
        host: text(form, "host"),
        name: text(form, "name"),
        token: text(form, "token"),
      })
      .then(
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
    void ask({
      title: `Remove ${user.name}?`,
      description: `Routines acting as ${user.name} will stop.`,
      confirm: "Remove",
      danger: true,
    }).then((yes) => {
      if (!yes) {
        return;
      }

      void api
        .delete(`technical-users/${encodeURIComponent(user.name)}`)
        .then(reload, reload);
    });
  };

  const setTeam = (user: TechnicalUserView, team: boolean): void => {
    void api
      .patch(`technical-users/${encodeURIComponent(user.name)}`, { team })
      .then(reload, reload);
  };

  const hostField = (
    <Field label="Host">
      <Select name="host">
        {hosts.map((host) => (
          <option key={host} value={host}>
            {host}
          </option>
        ))}
      </Select>
    </Field>
  );

  return (
    <Section
      title="Bots"
      description="Routines can open pull requests and comment as a bot instead of a person. Team work signs in to each host as the bot chosen for it."
    >
      {asking}
      <Rows label="Bots">
        {value?.length === 0 && (
          <Row
            title="No bots yet"
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
                {user.team && <Badge state="done">Team work</Badge>}
              </>
            }
            description={
              <span className="flex flex-col gap-0.5">
                <span>{botDescription(user)}</span>
                <ErrorText inline size="inherit">
                  {user.error}
                </ErrorText>
              </span>
            }
          >
            {managing === user.name ? (
              <>
                {user.installUrl !== null && (
                  <a
                    href={user.installUrl}
                    target="_blank"
                    rel="noreferrer"
                    className={buttonClass({ variant: "ghost" })}
                  >
                    Install
                  </a>
                )}
                <Button
                  variant="ghost"
                  onClick={() => {
                    setTeam(user, !user.team);
                  }}
                >
                  {user.team
                    ? "Stop team work signing in as it"
                    : `Team work signs in to ${user.host} as it`}
                </Button>
                <Button
                  variant="ghost"
                  aria-label={`Remove ${user.name}`}
                  onClick={() => {
                    remove(user);
                  }}
                >
                  Remove
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setManaging(undefined);
                  }}
                >
                  Done
                </Button>
              </>
            ) : (
              <Button
                variant="ghost"
                aria-label={`Manage ${user.name}`}
                onClick={() => {
                  setManaging(user.name);
                }}
              >
                Manage
              </Button>
            )}
          </Row>
        ))}
      </Rows>
      {adding === undefined && (
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() => {
              setAdding("app");
            }}
          >
            Create a GitHub App
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setAdding("token");
            }}
          >
            Add a machine user
          </Button>
        </div>
      )}
      {adding === "app" && (
        <form
          onSubmit={createApp}
          aria-label="New GitHub App"
          className={cn(cardClass, "grid gap-4 p-5 md:grid-cols-2")}
        >
          {hostField}
          <Field label="App name">
            <TextInput name="name" required placeholder="Acme Pipoca bot" />
          </Field>
          <Field label="Organization that owns it (optional)">
            <TextInput name="organization" />
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
          className={cn(cardClass, "grid gap-4 p-5 md:grid-cols-2")}
        >
          {hostField}
          <Field label="Name">
            <TextInput name="name" required placeholder="ci-bot" />
          </Field>
          <Field label="The account's personal access token">
            <TextInput
              name="token"
              type="password"
              autoComplete="off"
              required
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
            <ErrorText size="caption">{error}</ErrorText>
          </div>
        </form>
      )}
    </Section>
  );
}
