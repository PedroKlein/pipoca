import {
  action,
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

// An issue or pull request a routine's run proposes to write on.
const target = {
  repository: Type.String({
    minLength: 1,
    description: "owner/name, or the repository's address",
  }),
  number: Type.Integer({ minimum: 1 }),
};

const from = {
  host: Type.String({ description: "The git host, such as github.com" }),
  repository: Type.String({ description: "owner/name" }),
  action: Type.String({
    description:
      "What happened, such as opened, labeled or closed. Polling an App without a webhook tells opened, closed and updated.",
  }),
  sender: Type.String({ description: "Who caused it" }),
  technicalUser: Type.String({
    description: "The GitHub App that heard it, by webhook or by polling",
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
    eventSeconds: Config.number({
      title: "Seconds between event checks",
      description:
        "How often each repository a GitHub App without a webhook is installed on is checked for its events. Unchanged answers don't count against the App's rate limit.",
      default: 60,
      min: 10,
      max: 3600,
    }),
    pollSeconds: Config.number({
      title: "Seconds between pull request checks",
      description:
        "How often each watched pull request is checked on its host. Each check makes five requests with its owner's token.",
      default: 60,
      min: 1,
      max: 3600,
    }),
    // No host is listed until an admin adds one (ADR 0072).
    hosts: Config.collection({
      key: "host",
      item: host,
      admin: true,
      title: "Hosts",
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
  // (ADR 0051). A team Session's watch has no user_id (ADR 0071).
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
  user_id text references users (id) on delete cascade,
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
  // 1: the name and email to commit as are per host, and what each person
  // had becomes their default, for repositories on hosts without their own
  // (ADR 0072). The default's host is empty.
  migrations: [
    `
create table git_hosts_commit_identities (
  user_id text not null references users (id) on delete cascade,
  host text not null,
  name text not null,
  email text not null,
  primary key (user_id, host)
) strict, without rowid;

insert into git_hosts_commit_identities (user_id, host, name, email)
  select user_id, '', name, email from git_hosts_commit_as;

drop table git_hosts_commit_as;
`,
    // 2: going on without a code host is an answer in setup (ADR 0072): the
    // server's, with no user, or a person's, with the hosts listed then.
    `
create table git_hosts_setup_answers (
  user_id text references users (id) on delete cascade,
  hosts text not null check (json_valid(hosts)),
  answered_at integer not null
) strict;
create unique index git_hosts_setup_answers_user on git_hosts_setup_answers (coalesce(user_id, ''));
`,
    // 3: an App's events come by webhook or by polling (ADR 0075). Each is
    // published once, and polling keeps where it got to in each repository.
    `
create table git_hosts_heard (
  key text primary key,
  heard_at integer not null
) strict, without rowid;
create index git_hosts_heard_at on git_hosts_heard (heard_at);

create table git_hosts_polled (
  technical_user text not null,
  repository text not null,
  state text not null check (json_valid(state)),
  primary key (technical_user, repository)
) strict, without rowid;
`,
    // 4: questions posted as comments on the issue or pull request their
    // work came from (ADR 0076), with the comment and the people they are
    // for, by id.
    `
create table git_hosts_questions (
  question_id text primary key,
  host text not null,
  repository text not null,
  number integer not null,
  comment_url text not null,
  people text not null check (json_valid(people)),
  posted_at integer not null
) strict;
create index git_hosts_questions_thread on git_hosts_questions (host, repository, number);
`,
  ],
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
        paths: Type.Array(Type.String(), {
          description: "The files the commits added, changed or removed",
        }),
      }),
    }),
    release: event({
      title: "Release",
      description: "A release was published, edited or deleted.",
      fields: Type.Object({
        ...from,
        tag: Type.String(),
        title: Type.String(),
        body: Type.String(),
        url: Type.String(),
        prerelease: Type.Boolean(),
        author: Type.String(),
      }),
    }),
    tag: event({
      title: "Tag",
      description: "A tag was created or deleted.",
      fields: Type.Object({
        ...from,
        tag: Type.String(),
      }),
    }),
    deployment: event({
      title: "Deployment",
      description: "A deployment was created.",
      fields: Type.Object({
        ...from,
        id: Type.Number(),
        environment: Type.String(),
        ref: Type.String(),
        sha: Type.String(),
        description: Type.String(),
      }),
    }),
  },
  // What a routine's runs may propose, applied as the identity the run
  // acts as (ADR 0076).
  actions: {
    pullRequest: action({
      title: "Open or update a pull request",
      description:
        "Pushes the commits on the run's workspace branch and opens a pull request from it, or updates the one it opened.",
      commits: true,
      input: Type.Object(
        {
          title: Type.String({ minLength: 1, maxLength: 256 }),
          body: Type.Optional(Type.String({ maxLength: 60_000 })),
          base: Type.Optional(
            Type.String({
              minLength: 1,
              description:
                "The branch to merge into, the default one if left out",
            }),
          ),
          draft: Type.Optional(Type.Boolean()),
        },
        { additionalProperties: false },
      ),
    }),
    comment: action({
      title: "Comment",
      description: "Comments on an issue or pull request.",
      input: Type.Object(
        { ...target, body: Type.String({ minLength: 1, maxLength: 60_000 }) },
        { additionalProperties: false },
      ),
    }),
    labels: action({
      title: "Add or remove labels",
      description: "Adds and removes labels on an issue or pull request.",
      input: Type.Object(
        {
          ...target,
          add: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
          remove: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
        },
        { additionalProperties: false },
      ),
    }),
    closeIssue: action({
      title: "Close an issue",
      input: Type.Object(
        {
          ...target,
          reason: Type.Optional(
            Type.Union([
              Type.Literal("completed"),
              Type.Literal("not_planned"),
            ]),
          ),
        },
        { additionalProperties: false },
      ),
    }),
    requestReview: action({
      title: "Request a review",
      description: "Asks people to review a pull request.",
      input: Type.Object(
        {
          ...target,
          reviewers: Type.Array(Type.String({ minLength: 1 }), {
            minItems: 1,
          }),
        },
        { additionalProperties: false },
      ),
    }),
  },
});
