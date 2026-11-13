---
title: Git hosts and technical users
description: Let people connect GitHub and GitHub Enterprise, and give routines a bot of their own.
sidebar:
  order: 4
---

## Git hosts

Admins list the git hosts people can connect in Settings > Git hosts (the `git-hosts` plugin, [ADR 0043](../adr/0043-git-hosts.md)). No host is listed until one is added. **Add GitHub** adds github.com, and **Add a host** takes a GitHub Enterprise host. **Set up Connect** registers an OAuth app on the host, so people get a Connect button instead of pasting a token; its callback is `<url>/api/ext/git-hosts/callback`. The hosts and their OAuth apps are kept in `pipoca.json` under `git-hosts.hosts`. A host inside your company network is marked with its **Private host** switch, and Pipoca then reaches it through an Environment that can ([Private hosts](private-hosts.md)).

Each person connects their own account in Settings > Accounts, and their Sessions then clone, push, use `gh` and install Profile packages as them. There they pick the name and email their Sessions commit as on each host they connected, from the emails the host verified, plus a default for repositories on other hosts. Connect asks for the `user:email` scope to list those emails; with a pasted token that lacks it, the account's public email is offered.

- A GitHub App only does team work: it never signs a person in, because a person's own Sessions must reach every repository they can ([ADR 0072](../adr/0072-server-setup-and-personal-setup.md#code-hosts)).
- An Environment's `GH_TOKEN` secret signs git in to github.com whether or not a host is listed.
- A Session that proposes, such as a routine run fired by outside input, gets none of the Environment's git tokens: `GH_TOKEN` only clones its workspace.

The same plugin watches the pull requests Sessions open: see [Changes and pull requests](../use/changes.md#let-the-session-look-after-it).

## Bots

Admins register bot identities, called technical users in the config, for work that runs on its own in Settings > Git hosts > Bots ([ADR 0060](../adr/0060-technical-users-and-github-apps.md)).

- **Create a GitHub App** sends you to the host with an App manifest, optionally for an organization. Once you confirm it there, the host sends you back and the server keeps the App's id, private key and webhook secret, sealed in `pipoca.json` under `git-hosts.technicalUsers`. Then install the App on the accounts it should work in with its **Install** link; the list shows where it is installed.
- **Add a machine user**, on a host where Apps can't be made, takes a bot account's personal access token instead.

A routine acts as one with `"as": "<name>"` in its `do`. Its Sessions sign git in as the bot on the bot's host, with a token the server mints for the App's installation on the repository's owner, and commit as the bot. Only the people listed in the technical user's `users` (at first, the admin who added it) can have their routines act as it; for anyone else the Session gets no git login. Team routines act as a technical user that admins let the team use.

### Events

An App created over HTTPS gets a webhook, at `<url>/api/ext/git-hosts/hooks/<hook>`, and its events become [routine](../use/routines.md) triggers for the people who may use it:

| Event                    | When                                                            |
| ------------------------ | --------------------------------------------------------------- |
| `git-hosts.issue`        | An issue was opened, labelled, edited or closed.                |
| `git-hosts.comment`      | Someone commented on an issue or pull request.                  |
| `git-hosts.pull_request` | A pull request was opened, labelled, updated, closed or merged. |
| `git-hosts.review`       | Someone reviewed a pull request.                                |
| `git-hosts.check`        | A check run started or finished.                                |
| `git-hosts.push`         | Commits were pushed to a branch, with the changed `paths`.      |
| `git-hosts.release`      | A release was published, edited or deleted.                     |
| `git-hosts.tag`          | A tag was created or deleted.                                   |
| `git-hosts.deployment`   | A deployment was created.                                       |

Each has its `repository`, its `number` where there is one, and whether the `author` is a `member` of the repository. A comment's leading `/command` is in `command`, such as:

```json
{
  "kind": "event",
  "event": "git-hosts.comment",
  "where": [
    { "field": "command", "is": "/pipoca" },
    { "field": "member", "is": true }
  ]
}
```

Anyone can open an issue on a public repository, so add a condition on `member` or on a label only members can add. By default, an event fires only when its author is a member.

The host only sends an App's events to a server it can reach over HTTPS, so on a laptop install the App gets no webhook. An App without a webhook is polled with its installation tokens instead, every `eventSeconds` (60 by default), and gives the same events. Polling can't tell each change apart, so its issues and pull requests say `opened`, `closed` or `updated`. An event the webhook and the poll both tell, or the host delivers twice, is published once.
