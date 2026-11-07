import {
  type SetupStep,
  type SetupStepProps,
  useApi,
  useLoaded,
} from "@pipoca/plugins/web";
import {
  Badge,
  Button,
  buttonClass,
  Checkbox,
  cn,
  ErrorText,
  Field,
  Icon,
  initialsOf,
  Notice,
  Row,
  Rows,
  TextInput,
  useConfirm,
} from "@pipoca/ui";
import {
  type ReactElement,
  type ReactNode,
  type SubmitEvent,
  useState,
} from "react";
import { gitHosts } from "../plugin";
import type {
  Account,
  CommitIdentities,
  HostView,
  Identity,
  SetupState,
  TechnicalUserView,
} from "../src/model";
import {
  type HostChoice,
  HostIdentity,
  IdentityForm,
  PullRequestChoices,
  signIn,
  TokenForm,
} from "./account";
import { ConnectSetup, HostForm, kindOf } from "./hosts";

// The admin's step in server setup: the hosts, how people sign in to each
// for their own work, and the App that does team work there (ADR 0072).
// It follows sign-in, which decides who the people with code are.
export const codeHostsStep: SetupStep = {
  audience: "server",
  after: { plugin: "oidc", or: "plugins" },
  title: "Code hosts",
  summary: "Where the team's code lives",
  heading: "Where does the team's code live?",
  description:
    "Add each host, how people sign in to it for their own work, and the App that does team work there. People sign in once per host, and the name and email they commit with come from that host.",
  optional: true,
  wide: true,
  done: async (api) => (await api.get<SetupState>("setup")).server,
  changes: ["setup", "hosts"],
  Step: CodeHostsStep,
};

// Each person's step: sign in to each host and pick who their commits there
// are from. On a server just for its person, it adds the hosts too.
export const connectCodeStep: SetupStep = {
  audience: "person",
  after: "welcome",
  title: "Your code",
  summary: "Sign in where your repositories live",
  heading: "Connect your code",
  description:
    "Sessions clone, push and open pull requests as you. Sign in to each host you use, and pick the name and email your commits there carry.",
  optional: true,
  done: async (api) => (await api.get<SetupState>("setup")).person,
  changes: ["setup", "account", "hosts"],
  Step: ConnectCodeStep,
};

const failure = (reason: unknown): string =>
  reason instanceof Error ? reason.message : String(reason);

function CodeHostsStep(): ReactElement | null {
  const api = useApi(gitHosts);

  const hosts = useLoaded(
    async () => api.get<readonly HostView[]>("hosts"),
    "hosts",
    { changes: ["hosts"] },
  );

  const state = useLoaded(async () => api.get<SetupState>("setup"), "setup", {
    changes: ["setup", "hosts"],
  });

  const bots = useLoaded(
    async () => api.get<readonly TechnicalUserView[]>("technical-users"),
    "technical-users",
    { changes: ["hosts"] },
  );

  if (hosts.value === undefined || state.value === undefined) {
    return null;
  }

  const { lockedIn, noHosts } = state.value;

  const changed = (): void => {
    hosts.reload();
    state.reload();
    bots.reload();
  };

  return (
    <div className="flex flex-col gap-3">
      {hosts.value.map((host) => (
        <HostCard
          key={host.host}
          host={host}
          app={bots.value?.find(
            (bot) => bot.kind === "app" && bot.host === host.host,
          )}
          locked={lockedIn !== null}
          onChange={changed}
        />
      ))}
      {lockedIn === null && (
        <AddHost
          listed={hosts.value.map(({ host }) => host)}
          onAdded={changed}
        />
      )}
      {hosts.value.length === 0 && lockedIn === null && (
        <Answer
          label="Go on with no code host for now"
          description="Sessions still work in folders and repositories on each machine. You can add hosts later in Settings, Git hosts."
          given={noHosts}
          save={async (on) => api.put("setup/server", { noHosts: on })}
          onSaved={state.reload}
        />
      )}
      <Notice icon={lockedIn === null ? "info" : "lock"}>
        {lockedIn === null ? (
          <>
            Nothing is added for you, and any mix of hosts works, such as only a
            GitHub Enterprise host. Saved to{" "}
            <code className="font-mono text-mono-sm">pipoca.json</code>, under{" "}
            <code className="font-mono text-mono-sm">{gitHosts.id}</code>.
          </>
        ) : (
          <>
            The deploy sets these in{" "}
            <code className="font-mono text-mono-sm">{lockedIn}</code>, so they
            show here and change there.
          </>
        )}
      </Notice>
    </div>
  );
}

// One host as server setup shows it: how people sign in to it, and the App
// team work uses there.
function HostCard({
  host,
  app,
  locked,
  onChange,
}: {
  readonly host: HostView;
  readonly app: TechnicalUserView | undefined;
  readonly locked: boolean;
  readonly onChange: () => void;
}): ReactElement {
  const api = useApi(gitHosts);
  const [ask, asking] = useConfirm();
  const [open, setOpen] = useState<"edit" | "sign-in" | "app">();
  const [error, setError] = useState<string>();
  const ready = host.clientId !== "" && host.hasClientSecret;

  const toggle = (part: "edit" | "sign-in" | "app"): void => {
    setOpen(open === part ? undefined : part);
  };

  const save = async (input: object): Promise<void> => {
    await api.post(`hosts/${encodeURIComponent(host.host)}`, input);

    onChange();
  };

  const remove = (): void => {
    void ask({
      title: `Remove ${host.host}?`,
      description: `Sessions will stop signing in to ${host.host}.`,
      confirm: "Remove",
      danger: true,
    }).then((yes) => {
      if (yes) {
        void api
          .delete(`hosts/${encodeURIComponent(host.host)}`)
          .then(onChange, onChange);
      }
    });
  };

  const useForTeam = (): void => {
    if (app !== undefined) {
      api
        .patch(`technical-users/${encodeURIComponent(app.name)}`, {
          team: true,
        })
        .then(onChange, (reason: unknown) => {
          setError(failure(reason));
        });
    }
  };

  return (
    <Rows label={host.label}>
      {asking}
      <Row
        initials={initialsOf(host.label)}
        title={
          <>
            {host.label}
            <Badge state={ready ? "done" : "waiting"}>
              {ready ? "Ready" : "No sign-in yet"}
            </Badge>
          </>
        }
        description={host.label === host.host ? kindOf(host.host) : host.host}
      >
        {!locked && (
          <>
            <Button
              variant="ghost"
              aria-label={`Edit ${host.host}`}
              onClick={() => {
                toggle("edit");
              }}
            >
              Edit
            </Button>
            <Button
              variant="ghost"
              iconOnly
              aria-label={`Remove ${host.host}`}
              onClick={remove}
            >
              <Icon name="x" />
            </Button>
          </>
        )}
      </Row>
      {open === "edit" && (
        <li className="border-t border-line p-4">
          <HostForm
            host={host}
            save={async (input) => {
              await save(input);
              setOpen(undefined);
            }}
            remove={undefined}
            cancel={() => {
              setOpen(undefined);
            }}
          />
        </li>
      )}
      <li className="flex flex-col border-t border-line px-4 pt-1.5 pb-3.5">
        <Group>How people sign in, for their own work</Group>
        <Way
          on={ready}
          title={
            <>
              OAuth app <Badge>Recommended</Badge>
            </>
          }
          description={
            ready
              ? `Client ID ${host.clientId}. One click for people, and it reaches every repository they can. Organization owners may need to approve it.`
              : `Make one on ${host.host} (we show you the exact values), then paste its client ID and secret.`
          }
        >
          {!locked && (
            <Button
              size="sm"
              variant={ready ? "default" : "primary"}
              aria-label={`Set up sign-in for ${host.host}`}
              onClick={() => {
                toggle("sign-in");
              }}
            >
              {ready ? "Manage" : "Set up"}
            </Button>
          )}
        </Way>
        {open === "sign-in" && (
          <div className="border-b border-line py-3">
            <ConnectSetup
              host={host}
              then="server-setup"
              save={async (clientId, clientSecret) =>
                save({ label: host.label, clientId, clientSecret })
              }
              close={() => {
                setOpen(undefined);
              }}
            />
          </div>
        )}
        <Way
          on
          title="Personal access token"
          description={
            ready
              ? "A fallback where the OAuth app isn't approved."
              : "Works with nothing else set up."
          }
        />
        <Group>Team work</Group>
        <Way
          on={app?.team === true}
          title={
            <>
              GitHub App
              {app !== undefined && !app.team && (
                <Badge state="waiting">Not used for team work</Badge>
              )}
            </>
          }
          description={appDescription(host, app)}
        >
          {typeof app?.installUrl === "string" && (
            <a
              href={app.installUrl}
              target="_blank"
              rel="noreferrer"
              className={buttonClass({ size: "sm" })}
            >
              Install
            </a>
          )}
          {app !== undefined && !app.team && !locked && (
            <Button size="sm" onClick={useForTeam}>
              Use for team work
            </Button>
          )}
          {app === undefined && !locked && (
            <Button
              size="sm"
              onClick={() => {
                toggle("app");
              }}
            >
              Create GitHub App
            </Button>
          )}
        </Way>
        {open === "app" && (
          <TeamAppForm
            host={host}
            cancel={() => {
              setOpen(undefined);
            }}
          />
        )}
        <ErrorText size="caption">{error}</ErrorText>
      </li>
    </Rows>
  );
}

function appDescription(
  host: HostView,
  app: TechnicalUserView | undefined,
): string {
  if (app === undefined) {
    return `Only needed for team work on ${host.label}. It pushes as its own bot and sends pull request events back. It never signs people in.`;
  }

  const where =
    app.installedOn === null || app.installedOn.length === 0
      ? "not installed yet"
      : `installed on ${app.installedOn.join(", ")}`;

  return `${app.login}, ${where}. Team work pushes as its bot, and pull request events come back through it.`;
}

// Going on without a host, which answers the step.
function Answer({
  label,
  description,
  given,
  save,
  onSaved,
}: {
  readonly label: string;
  readonly description: string;
  readonly given: boolean;
  readonly save: (on: boolean) => Promise<unknown>;
  readonly onSaved: () => void;
}): ReactElement {
  const [shown, setShown] = useState<boolean>();
  const [error, setError] = useState<string>();

  return (
    <div className="flex flex-col gap-1">
      <Checkbox
        label={label}
        description={description}
        checked={shown ?? given}
        onChange={(event) => {
          const on = event.currentTarget.checked;
          setShown(on);

          save(on).then(
            () => {
              setError(undefined);
              onSaved();
            },
            (reason: unknown) => {
              setShown(undefined);
              setError(failure(reason));
            },
          );
        }}
      />
      <ErrorText size="caption">{error}</ErrorText>
    </div>
  );
}

function Group({ children }: { readonly children: ReactNode }): ReactElement {
  return <p className="pt-2.5 pb-0.5 text-caption text-fg-dim">{children}</p>;
}

// A way to reach the host, ticked once it is set up.
function Way({
  on,
  title,
  description,
  children,
}: {
  readonly on: boolean;
  readonly title: ReactNode;
  readonly description: string;
  readonly children?: ReactNode;
}): ReactElement {
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-line py-2.5 last:border-b-0">
      <span
        className={cn(
          "grid size-5 shrink-0 place-items-center rounded-full",
          on ? "bg-done-tint text-done" : "border border-line text-transparent",
        )}
      >
        <Icon name="check" className="size-3" />
      </span>
      <span className="flex min-w-0 flex-1 basis-48 flex-col gap-0.5">
        <span className="flex items-center gap-1.5 text-ui font-medium text-fg-strong">
          {title}
        </span>
        <span className="text-label text-fg-dim">{description}</span>
      </span>
      {children}
    </div>
  );
}

// Creates the App on the host through its manifest flow (ADR 0060), and
// comes back to this step with it doing the team's work there.
function TeamAppForm({
  host,
  cancel,
}: {
  readonly host: HostView;
  readonly cancel: () => void;
}): ReactElement {
  const submit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);

    const text = (name: string): string => {
      const field = form.get(name);

      return typeof field === "string" ? field.trim() : "";
    };

    const params = new URLSearchParams({
      host: host.host,
      name: text("name"),
      organization: text("organization"),
      then: "server-setup",
    });

    location.assign(
      `/api/ext/${gitHosts.id}/technical-users/new-app?${params.toString()}`,
    );
  };

  return (
    <form
      onSubmit={submit}
      aria-label={`A GitHub App for ${host.label}`}
      className="flex flex-col gap-4 rounded-lg border border-dashed border-line-strong bg-elevated p-5"
    >
      <div className="flex flex-col gap-1">
        <h3 className="text-ui font-medium text-fg-strong">
          A GitHub App for {host.label}
        </h3>
        <p className="text-label text-fg-dim">
          For team work: it pushes as its own bot and sends pull request events
          back. People sign in for their own work through the OAuth app, so the
          App only needs installing where the team works.
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <Field
          label="Owner"
          hint="An organization keeps the App when you leave. Leave it empty for your own account."
        >
          <TextInput name="organization" placeholder="Organization" />
        </Field>
        <Field
          label="App name"
          hint="Shown on the commits and comments team work makes, as its bot."
        >
          <TextInput name="name" required defaultValue="Pipoca" />
        </Field>
      </div>
      <p className="text-caption text-fg-dim">
        It asks {host.label} for contents, pull requests and issues, read and
        write, and checks, statuses, actions and metadata, read. Team work
        reaches only repositories where the App is installed. People&apos;s own
        Sessions aren&apos;t limited by it.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" type="submit">
          Create on {host.host}
        </Button>
        <Button onClick={cancel}>Cancel</Button>
        <span className="text-caption text-fg-dim">
          {host.host} opens, you confirm, then pick where to install it. You
          come back here after.
        </span>
      </div>
    </form>
  );
}

// Adds a host: GitHub in one click, or any other by its name.
function AddHost({
  listed,
  onAdded,
}: {
  readonly listed: readonly string[];
  readonly onAdded: () => void;
}): ReactElement {
  const api = useApi(gitHosts);
  const [kind, setKind] = useState<"enterprise" | "other">();
  const [error, setError] = useState<string>();

  const add = async (input: object): Promise<void> => {
    await api.post("hosts", input);

    setError(undefined);
    setKind(undefined);
    onAdded();
  };

  if (kind !== undefined) {
    return (
      <HostForm
        host={undefined}
        {...(kind === "enterprise" && { label: "GitHub Enterprise" })}
        save={add}
        remove={undefined}
        cancel={() => {
          setKind(undefined);
        }}
      />
    );
  }

  return (
    <div
      role="group"
      aria-label="Add a host"
      className="flex flex-wrap items-center gap-2"
    >
      <span className="text-label text-fg-dim">Add a host</span>
      <Button
        onClick={() => {
          setKind("enterprise");
        }}
      >
        <Icon name="plus" />
        GitHub Enterprise
      </Button>
      {!listed.includes("github.com") && (
        <Button
          onClick={() => {
            add({ host: "github.com", label: kindOf("github.com") }).catch(
              (reason: unknown) => {
                setError(failure(reason));
              },
            );
          }}
        >
          <Icon name="plus" />
          GitHub
        </Button>
      )}
      <Button
        onClick={() => {
          setKind("other");
        }}
      >
        <Icon name="plus" />
        Other git host
      </Button>
      <ErrorText size="caption" className="w-full">
        {error}
      </ErrorText>
    </div>
  );
}

function ConnectCodeStep({ solo }: SetupStepProps): ReactElement | null {
  const api = useApi(gitHosts);

  const account = useLoaded(
    async () => api.get<Account>("account"),
    "account",
    { changes: ["account", "hosts"] },
  );

  const state = useLoaded(async () => api.get<SetupState>("setup"), "setup", {
    changes: ["setup", "account", "hosts"],
  });

  const identities = useLoaded(
    async () => api.get<CommitIdentities>("commit-as"),
    "commit-as",
    { changes: ["commit-as"] },
  );

  // On a server just for its person, they set up each host's sign-in too.
  const views = useLoaded(
    async () =>
      solo ? api.get<readonly HostView[]>("hosts") : Promise.resolve([]),
    `hosts ${String(solo)}`,
    { changes: ["hosts"] },
  );

  if (
    account.value === undefined ||
    state.value === undefined ||
    identities.value === undefined
  ) {
    return null;
  }

  const { hosts, connections } = account.value;

  const loginOn = (host: string): string | undefined =>
    connections.find((each) => each.host === host)?.login;

  const anyConnected = hosts.some(({ host }) => loginOn(host) !== undefined);

  const changed = (): void => {
    account.reload();
    state.reload();
    identities.reload();
    views.reload();
  };

  return (
    <div className="flex flex-col gap-3">
      {hosts.map((host) => (
        <ConnectHost
          key={host.host}
          host={host}
          login={loginOn(host.host)}
          identity={identities.value?.hosts.find(
            (each) => each.host === host.host,
          )}
          view={views.value?.find((each) => each.host === host.host)}
          onChange={changed}
        />
      ))}
      {hosts.length === 0 && !solo && (
        <Notice>
          No code host is set up on this server yet. An admin adds them, and
          this step comes back as a reminder on home when they do.
        </Notice>
      )}
      {solo && (
        <AddHost listed={hosts.map(({ host }) => host)} onAdded={changed} />
      )}
      {!anyConnected && (
        <Answer
          label={
            hosts.length === 0
              ? "Go on without a code host"
              : "Go on without signing in to one"
          }
          description="Sessions still work in folders and repositories on each machine."
          given={state.value.withoutHosts}
          save={async (on) => api.put("setup/person", { withoutHosts: on })}
          onSaved={state.reload}
        />
      )}
      <Elsewhere
        identity={identities.value.default ?? undefined}
        onSaved={changed}
      />
      <PullRequestChoices />
    </div>
  );
}

// A host the person signs in to, and once in, who their commits there are
// from.
function ConnectHost({
  host,
  login,
  identity,
  view,
  onChange,
}: {
  readonly host: HostChoice;
  readonly login: string | undefined;
  readonly identity: CommitIdentities["hosts"][number] | undefined;
  // The host's sign-in as an admin sets it up, on a server just for them.
  readonly view: HostView | undefined;
  readonly onChange: () => void;
}): ReactElement {
  const api = useApi(gitHosts);
  const [pasting, setPasting] = useState(false);
  const [settingUp, setSettingUp] = useState(false);

  return (
    <Rows label={host.label}>
      <Row
        initials={initialsOf(host.label)}
        title={
          <>
            {host.label}
            {login !== undefined && <Badge state="done">Connected</Badge>}
          </>
        }
        description={
          login === undefined
            ? `${host.label === host.host ? "" : `${host.host} · `}Not signed in`
            : `Signed in as ${login}`
        }
      >
        {login !== undefined && (
          <Button
            variant="ghost"
            aria-label={`Sign out of ${host.label}`}
            onClick={() => {
              void api
                .delete(`connections/${encodeURIComponent(host.host)}`)
                .then(onChange, onChange);
            }}
          >
            Sign out
          </Button>
        )}
        {login === undefined && host.oauth && (
          <Button
            variant="primary"
            onClick={() => {
              signIn(host.host, "setup");
            }}
          >
            Sign in with {host.label}
          </Button>
        )}
        {login === undefined && !host.oauth && !pasting && (
          <Button
            variant="primary"
            onClick={() => {
              setPasting(true);
            }}
          >
            Use a token
          </Button>
        )}
        {login === undefined && !host.oauth && view !== undefined && (
          <Button
            variant="ghost"
            aria-label={`Set up sign-in for ${host.host}`}
            onClick={() => {
              setSettingUp(!settingUp);
            }}
          >
            Set up sign-in
          </Button>
        )}
      </Row>
      {settingUp && view !== undefined && (
        <li className="border-t border-line p-4">
          <ConnectSetup
            host={view}
            save={async (clientId, clientSecret) => {
              await api.post(`hosts/${encodeURIComponent(host.host)}`, {
                label: view.label,
                clientId,
                clientSecret,
              });

              setSettingUp(false);
              onChange();
            }}
            close={() => {
              setSettingUp(false);
            }}
          />
        </li>
      )}
      {login === undefined && (pasting || host.oauth) && (
        <li className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3 text-label text-fg-dim">
          {pasting ? (
            <TokenForm
              host={host}
              onDone={(connected) => {
                setPasting(false);

                if (connected) {
                  onChange();
                }
              }}
            />
          ) : (
            <>
              Other ways:
              <Button
                variant="link"
                onClick={() => {
                  setPasting(true);
                }}
              >
                use a token
              </Button>
            </>
          )}
        </li>
      )}
      {login !== undefined && (
        <li className="flex flex-col gap-2 border-t border-line px-4 py-3.5">
          <p className="text-label font-medium text-fg">Commit as</p>
          <HostIdentity
            host={host}
            identity={identity}
            plain
            onSaved={onChange}
          />
        </li>
      )}
    </Rows>
  );
}

// Who commits are from in repositories on hosts without their own.
function Elsewhere({
  identity,
  onSaved,
}: {
  readonly identity: Identity | undefined;
  readonly onSaved: () => void;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const action = identity === undefined ? "Set a name" : "Change";

  return (
    <Rows label="Repositories anywhere else">
      <Row
        title="Repositories anywhere else"
        description={
          identity === undefined
            ? "Commit with each machine's own git config"
            : `Commit as ${identity.name} <${identity.email}>`
        }
      >
        <Button
          variant="ghost"
          onClick={() => {
            setOpen(!open);
          }}
        >
          {open ? "Close" : action}
        </Button>
      </Row>
      {open && (
        <li className="border-t border-line p-4">
          <IdentityForm
            label="Default"
            plain
            identity={identity}
            emails={undefined}
            onSaved={() => {
              setOpen(false);
              onSaved();
            }}
          />
        </li>
      )}
    </Rows>
  );
}
