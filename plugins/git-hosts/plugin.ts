import {
  Config,
  definePlugin,
  event,
  Secret,
  type Static,
  Type,
} from "@pipoca/plugins";

// The host goes into git's config keys and gh's hosts.yml, so it is only a
// name and an optional port.
export const hostPattern = "^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?$";

const host = Type.Object({
  host: Type.String({ pattern: hostPattern }),
  label: Type.Optional(Type.String()),
  // The REST API's base address, https://<host>/api/v3 unless it says.
  api: Type.Optional(Type.String({ pattern: "^https?://" })),
  // An OAuth app on the host, for a Connect button instead of a token.
  // GitHub's OAuth apps need a secret, so without one people paste a token.
  oauth: Type.Optional(
    Type.Object({
      clientId: Type.String({ minLength: 1 }),
      clientSecret: Type.Optional(Secret({ env: true })),
    }),
  ),
});

export type HostItem = Static<typeof host>;

// A bot identity on a git host that an admin registered (ADR 0060): a
// GitHub App, or a machine user by its token. users are who may have their
// Sessions act as it, and "team" makes it the one team work signs in as on
// its host.
const technicalUser = Type.Object({
  name: Type.String(),
  host: Type.String(),
  users: Config.audience(),
  login: Type.Optional(Type.String()),
  token: Type.Optional(Secret({ env: true })),
  app: Type.Optional(
    Type.Object({
      id: Type.Number(),
      slug: Type.String(),
      // The App's page on the host, where it is installed.
      url: Type.String(),
      privateKey: Secret({ env: true }),
      webhookSecret: Type.Optional(Secret({ env: true })),
      // Where the host sends the App's events, under hooks/.
      hook: Type.String(),
    }),
  ),
});

export type TechnicalUserItem = Static<typeof technicalUser>;

const from = {
  host: Type.String({ description: "The git host, such as github.com" }),
  repository: Type.String({ description: "owner/name" }),
  action: Type.String({
    description: "What happened, such as opened, labeled or closed",
  }),
  sender: Type.String({ description: "Who caused it" }),
  technicalUser: Type.String({
    description: "The GitHub App whose webhook sent it",
  }),
};

const authored = {
  author: Type.String(),
  member: Type.Boolean({
    description:
      "Whether the author is an owner, member or collaborator of the repository",
  }),
  number: Type.Number(),
};

export const gitHosts = definePlugin({
  id: "git-hosts",
  title: "Git hosts",
  description:
    "Lets each person connect their own GitHub and GitHub Enterprise accounts, so their Sessions clone, push, use gh and install Profile packages as them. Admins list the hosts in Settings.",
  config: Config.object({
    pollSeconds: Config.number({
      title: "Seconds between pull request checks",
      description:
        "How often each watched pull request is checked on its host. Each check makes five requests with its owner's token.",
      default: 60,
      min: 1,
      max: 3600,
    }),
    // With no list in the file, github.com is the one host (ADR 0043).
    hosts: Config.collection({
      key: "host",
      item: host,
      admin: true,
      title: "Hosts",
      default: [{ host: "github.com", label: "GitHub" }],
    }),
    technicalUsers: Config.collection({
      key: "name",
      item: technicalUser,
      admin: true,
      title: "Technical users",
    }),
  }),
  // Each person connects their own account on each host, and the runner
  // signs git and gh in with it in that person's Sessions (ADR 0043).
  // Watched pull requests and each person's choices are runtime data
  // (ADR 0051).
  schema: `
create table git_hosts_connections (
  user_id text not null references users (id) on delete cascade,
  host text not null,
  login text not null,
  token text not null,
  connected_at integer not null,
  primary key (user_id, host)
) strict, without rowid;

create table git_hosts_commit_as (
  user_id text primary key references users (id) on delete cascade,
  name text not null,
  email text not null
) strict, without rowid;

create table git_hosts_watches (
  id text primary key,
  session_id text not null references sessions (id) on delete cascade,
  user_id text not null references users (id) on delete cascade,
  url text not null,
  host text not null,
  repository text not null,
  number integer not null,
  auto_fix integer not null check (auto_fix in (0, 1)),
  briefed integer not null default 0 check (briefed in (0, 1)),
  seen text check (json_valid(seen)),
  view text check (json_valid(view)),
  unique (session_id, url)
) strict;
create index git_hosts_watches_user on git_hosts_watches (user_id);

create table git_hosts_preferences (
  user_id text primary key references users (id) on delete cascade,
  auto_fix integer not null check (auto_fix in (0, 1)),
  reply integer not null check (reply in (0, 1))
) strict, without rowid;
`,
  events: {
    issue: event({
      title: "Issue",
      description:
        "An issue was opened, labelled, edited or closed in a repository a GitHub App is installed on.",
      fields: Type.Object({
        ...from,
        ...authored,
        title: Type.String(),
        body: Type.String(),
        url: Type.String(),
        labels: Type.Array(Type.String()),
        label: Type.String({ description: "The label added or removed" }),
      }),
    }),
    comment: event({
      title: "Comment",
      description: "Someone commented on an issue or pull request.",
      fields: Type.Object({
        ...from,
        ...authored,
        pullRequest: Type.Boolean(),
        body: Type.String(),
        command: Type.String({
          description: "The comment's leading /command, such as /pipoca",
        }),
        url: Type.String(),
      }),
    }),
    pull_request: event({
      title: "Pull request",
      description:
        "A pull request was opened, labelled, updated, closed or merged.",
      fields: Type.Object({
        ...from,
        ...authored,
        title: Type.String(),
        body: Type.String(),
        url: Type.String(),
        branch: Type.String(),
        base: Type.String(),
        merged: Type.Boolean(),
        labels: Type.Array(Type.String()),
        label: Type.String(),
      }),
    }),
    review: event({
      title: "Review",
      description: "Someone reviewed a pull request.",
      fields: Type.Object({
        ...from,
        ...authored,
        state: Type.String({
          description: "approved, changes_requested or commented",
        }),
        body: Type.String(),
        url: Type.String(),
      }),
    }),
    check: event({
      title: "Check run",
      description: "A check run started or finished.",
      fields: Type.Object({
        ...from,
        name: Type.String(),
        conclusion: Type.String({
          description: "success, failure and so on, empty while it runs",
        }),
        branch: Type.String(),
        sha: Type.String(),
        numbers: Type.Array(Type.Number()),
        url: Type.String(),
      }),
    }),
    push: event({
      title: "Push",
      description: "Commits were pushed to a branch.",
      fields: Type.Object({
        ...from,
        branch: Type.String(),
        sha: Type.String(),
      }),
    }),
  },
});
