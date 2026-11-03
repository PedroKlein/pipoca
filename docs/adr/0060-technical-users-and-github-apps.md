# 0060: Technical users and GitHub Apps

- Status: accepted
- Date: 2026-11-03

## Context

Every git action in Pipoca today uses the token of the person who started the Session ([ADR 0043](0043-git-hosts.md)). For work that runs on its own, such as routines ([ADR 0059](0059-routines-and-wake-ups.md)) and the software factory ([ADR 0061](0061-software-factory.md)), that has costs:

- A pull request opened with the person's token is theirs, and GitHub doesn't let them approve their own pull request. Where a repository requires a review, they can't merge the factory's work.
- Comments are posted as the person, which people don't want by default ([ADR 0051](0051-pull-request-watching.md#the-person-chooses)).
- Events arrive by polling, up to a minute late, unless someone adds a webhook to each repository by hand.
- Every Session started on the person's token gets all of that token's reach.

Team Sessions already need a Pipoca GitHub App before they are built ([ADR 0054](0054-team-sessions.md#what-must-exist-before-team-sessions-are-built)). Pipoca is self-hosted, so there is no central App to install: each server needs its own, and a team may want more than one, such as a bot that pushes and opens pull requests and another that only reviews.

Cursor and Factory let an automation run as the person or as a service account, and Cursor lets only admins pick a service account. GitHub Apps can be created from a manifest in a couple of clicks, and Backstage keeps several Apps per host ([research](../research.md#bot-identities-on-github)).

## Decision

### Technical users

- Pipoca keeps a list of technical users: bot identities on a git host, registered by an admin (decided 2026-11-03). In a solo install the admin is the one person. A server can have several on each host.
- A technical user has a name, a host, a credential, the owners or repositories it may act in, and who may use it: the admin, named people, or later a team.
- Two kinds:
  - **A GitHub App**, preferred. The admin creates it from Settings > Git hosts with GitHub's manifest flow, which also works on GitHub Enterprise Server. GitHub returns the App's id, private key and webhook secret, and the server keeps them. The admin then installs the App on the organizations or repositories it should reach.
  - **A machine user with a token**, for hosts where Apps can't be created or that don't support them. GitHub's terms allow one free machine account per person, so a team pays for more.
- Technical users live in the `git-hosts` plugin, next to hosts, tokens and the pull request poller. The Slack and email plugins register their bots and mailboxes the same way ([ADR 0062](0062-slack-and-email.md)).

### Choosing who acts

- A routine, and later a Project or Team Session, says who it acts as: the person, which is the default, or a technical user by name (decided 2026-11-03).
- Pipoca picks by name, not by organization. Several Apps can be installed on the same organization.
- A person can choose only technical users they have been given.

### Tokens stay on the server

- For each Session that acts as a GitHub App, the server mints an installation token narrowed to that Session's repositories and to the permissions it needs. It lasts an hour and is refreshed the way people's tokens are today ([ADR 0045](0045-server-kept-logins.md)).
- The App's private key and a machine user's token never leave the server, and never reach a runner.

### Events

- Each App gets its own webhook URL under `git-hosts`, checked with its webhook secret. Events become `git-hosts` plugin events, the same ones polling produces, so a routine doesn't know which source fed it.
- Without a public URL, the server polls with an installation token instead.

### What the bot writes

- Commits and pull requests are authored by the bot, with the person who asked as `Co-authored-by`.
- Comments and reviews are posted as the bot. A Session acting as a person still follows that person's "reply as me" setting ([ADR 0051](0051-pull-request-watching.md#the-person-chooses)).

## Consequences

- People can approve and merge what a bot opened, and nothing is posted as them unless they chose it.
- A team can split reach and permissions across bots instead of sharing one powerful token.
- The server holds new secrets, the Apps' private keys, which must be stored like other credentials and backed up.
- Webhooks need a public URL, which installs on Kubernetes have and laptops don't. Polling stays as the fallback.
- On a GitHub Enterprise host, creating an App may need that host's admins.
- This settles the GitHub App question that Team Sessions were waiting on. Brokered model credentials, a usage record and team membership are still needed for them.
