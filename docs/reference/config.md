---
title: Config file
description: Every key of the server's pipoca.json, with its default.
sidebar:
  order: 2
---

The server's `pipoca.json` lives in its config folder, `config/` next to the database unless `--config-dir` names another. Settings edits it, and so can you; the server reads it again when it changes. [Settings and the config file](../admin/settings-and-config.md) explains how it works, with secrets and the locked file. A key left out takes its default.

## Kernel keys

| Key                            | What it sets                                                                                                 | Default                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| `server.sessionDays`           | Days a browser stays signed in.                                                                              | `30`                                                            |
| `server.runnerTokenDays`       | Days a runner token lasts without being used.                                                                | `30`                                                            |
| `server.repositorySyncMinutes` | How often Profiles and templates that follow a repository sync.                                              | `15`                                                            |
| `server.usedBy`                | Who the server is for, `me` or `team`, as server setup's first step answers it.                              |                                                                 |
| `team.name`                    | The team's name, shown in the hub.                                                                           |                                                                 |
| `team.messagesRead`            | How many of the team's messages since its last turn Pi reads.                                                | `40`                                                            |
| `plugins.<id>.personal`        | Whether the plugin is on.                                                                                    | Built-in on, installed off, `local` solo only, `oidc` team only |
| `plugins.<id>.team`            | Whether the plugin is on in team work.                                                                       | Built-in on, installed off                                      |
| `hub.pages`                    | The team hub's pages and the panels on each.                                                                 | Every panel on Home                                             |
| `newcomers`                    | What new people get and which setup steps they must do.                                                      |                                                                 |
| `templates`                    | Environment templates, each with an `id`, a `name`, its settings and a key per plugin, such as `kubernetes`. | `[]`                                                            |

## Plugin keys

Each plugin's config is the key named by its id. Sizes are in bytes.

| Key                           | What it sets                                                                                      | Default                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `artifacts.maxFileBytes`      | The largest artifact.                                                                             | 50 MB                                                       |
| `artifacts.scriptHosts`       | Hosts an artifact may load scripts and styles from.                                               | `cdnjs.cloudflare.com`, `cdn.jsdelivr.net/npm`, `unpkg.com` |
| `ask.voteMinutes`             | How long a team vote stays open, unless whoever opens it says otherwise.                          | `60`                                                        |
| `email.pollSeconds`           | Seconds between mail checks.                                                                      | `60`                                                        |
| `email.mailboxes`             | The mailboxes admins add in Settings, passwords sealed.                                           |                                                             |
| `files.maxFileBytes`          | The largest Session file.                                                                         | 200 MB                                                      |
| `files.perPersonBytes`        | Session files per person before they're warned.                                                   | 10 GB                                                       |
| `files.snapshots.enabled`     | Keep unfinished work in repositories when a pod stops.                                            | `true`                                                      |
| `files.snapshots.maxBytes`    | The largest snapshot kept per checkout.                                                           | 500 MB                                                      |
| `git-hosts.hosts`             | The git hosts people can connect, with their OAuth apps.                                          |                                                             |
| `git-hosts.technicalUsers`    | GitHub Apps and machine users, keys sealed.                                                       |                                                             |
| `git-hosts.pollSeconds`       | Seconds between checks of each watched pull request.                                              | `60`                                                        |
| `git-hosts.eventSeconds`      | Seconds between event checks for a GitHub App without a webhook.                                  | `60`                                                        |
| `kubernetes.maxPodsPerPerson` | The most runner pods one person's Environments run at once, on top of each template's own limit.  | `10`                                                        |
| `logins.privateHosts`         | MCP servers on private addresses that sign-ins from Settings may reach, as `host` or `host:port`. | `[]`                                                        |
| `models.hidden`               | Models kept out of the model pickers, as `provider/id`.                                           | `[]`                                                        |
| `oidc.providers`              | The OpenID Connect providers people sign in with.                                                 | `[]`                                                        |
| `projects.maxFileBytes`       | The largest Project folder file.                                                                  | 200 MB                                                      |
| `projects.perProjectBytes`    | A Project folder's size before its people are warned.                                             | 5 GB                                                        |
| `projects.folderHistoryDays`  | Days earlier versions of Project folder files are kept.                                           | `30`                                                        |
| `push.answerMinutes`          | In team work, how long a question to a named person waits before the starter is told too.         | `10`                                                        |
| `routines.wakeUpDays`         | The furthest ahead a Session may schedule a wake-up.                                              | `30`                                                        |
| `slack.api`                   | Slack's Web API address.                                                                          | `https://slack.com/api`                                     |
| `slack.bots`                  | The Slack bots admins add in Settings, tokens sealed.                                             |                                                             |
| `usage.prices`                | Dollars per million tokens in and out, keyed by `provider/model`.                                 | `{}`                                                        |
| `usage.budgets.team`          | The team's monthly budget in dollars, 0 for none.                                                 | `0`                                                         |
| `usage.budgets.person`        | Each person's monthly cap of team work in dollars, 0 for none.                                    | `0`                                                         |

## An example

```json
{
  "server": { "sessionDays": 14 },
  "team": { "name": "Acme" },
  "plugins": { "slack": { "personal": false } },
  "usage": {
    "prices": { "openai/gpt-5": { "input": 1.25, "output": 10 } },
    "budgets": { "team": 500, "person": 100 }
  },
  "oidc": {
    "providers": [
      {
        "id": "okta",
        "label": "Sign in with Okta",
        "issuer": "https://acme.okta.com",
        "clientId": "0oa123",
        "accessGroup": "pipoca-users",
        "adminGroup": "pipoca-admins"
      }
    ]
  }
}
```
