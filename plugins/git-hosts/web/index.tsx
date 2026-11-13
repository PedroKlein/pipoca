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
  Checkbox,
  buttonClass,
  cardClass,
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
  TextInput,
  useConfirm,
} from "@pipoca/ui";
import type { RepositoryChoice } from "@pipoca/protocol";
import { type ReactElement, type SubmitEvent, useState } from "react";
import { gitHosts } from "../plugin";
import type {
  Account,
  PullWatch,
  TechnicalUserView,
  WatchedPull,
} from "../src/model";
import { CommitAs, HostRow, PullRequestChoices } from "./account";
import { HostsEditor } from "./hosts";
import { codeHostsStep, connectCodeStep } from "./setup";

export { HostsEditor } from "./hosts";

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
  setup: [codeHostsStep, connectCodeStep],
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
  branches: async (url, team, api) =>
    api.get<readonly string[]>(`${team ? "team/" : ""}branches`, { url }),
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

  if (value?.admin !== true) {
    return null;
  }

  return (
    <Page
      title="Git hosts"
      description="Only admins see this page. It lists the hosts people can connect and the bots routines act as. Everyone else connects their own account in Accounts."
    >
      <HostsEditor onChange={reload} />
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
    <>
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
      <CommitAs
        connected={value.hosts.filter(({ host }) =>
          value.connections.some((each) => each.host === host),
        )}
      />
    </>
  );
}

function CodeChoices(): ReactElement {
  return <PullRequestChoices />;
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
      ...(form.get("public") === "on" && { public: "true" }),
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
          <Checkbox
            name="public"
            className="md:col-span-2"
            label="Let other accounts install it"
            description="So it can work in more than one organization. On GitHub Enterprise that means accounts on this host only."
          />
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
