---
title: Settings and the config file
description: Where each setting lives, and the pipoca.json file that holds them.
sidebar:
  order: 1
---

## Settings

Settings, in the account menu, is grouped by who it is for ([ADR 0063](../adr/0063-settings-and-first-run-setup.md)):

- **You**: General, Accounts, plugin pages such as Notifications, and Access tokens.
- **Workspace**: Environments, Profiles and plugin pages such as Models.
- **Server, for admins**: People, Plugins, Configuration and plugin pages such as Git hosts, Sign-in, Kubernetes and Integrations.

Each page has its own address, `#settings/<page>`, such as `#settings/environments`. A plugin's page is named by its id, such as `#settings/git-hosts` or `#settings/oidc`, and goes away while the plugin is off. On a team server, Team setup at `#team/setup` shows the team's Environments and Profiles and the same server pages.

## The config file

The server's config folder, next to the database unless `--config-dir` names another, holds `pipoca.json`: everything people set ahead of time, one source each ([ADR 0039](../adr/0039-plugin-config-files.md), [ADR 0068](../adr/0068-clean-rebuild.md#storage)). Settings edits it, and so can you; the server reads it again when it changes. Runtime data, such as people, Sessions and logins, lives in the SQLite database instead.

The kernel keeps these keys, which no plugin id can take:

```json
{
  "server": {
    "sessionDays": 30,
    "runnerTokenDays": 30,
    "repositorySyncMinutes": 15
  },
  "team": { "name": "Acme", "messagesRead": 40 },
  "plugins": { "slack": { "personal": true, "team": false } },
  "hub": { "pages": [] },
  "newcomers": {},
  "templates": [
    { "id": "pods", "name": "Pods", "kubernetes": { "maxPods": 5 } }
  ]
}
```

- `server` sets how long a browser stays signed in, how long a runner token lasts unused, and how often Profiles and templates that follow a repository sync.
- `team.messagesRead` is how many of the team's messages since its last turn Pi reads.
- `plugins` turns each plugin on or off (`personal`) and in team work (`team`). See [Plugins](plugins.md).
- `hub` holds the team hub's pages, `newcomers` what new people get, and `templates` the [Environment templates](environments.md#templates).

Every other key is a plugin's config, as its `definePlugin` declares it, and a field left out takes its default. The Plugins page and each plugin's Settings section edit them. [Config file](../reference/config.md) lists each built-in plugin's keys.

A template entry that doesn't fit is logged and left out. A plugin's switch or a field of another kernel key that doesn't fit is logged and takes its default, and the rest keep their values.

### Secrets in the file

A secret in the file is either `{ "sealed": "…" }`, as Settings saves it, or `{ "env": "NAME" }`, an environment variable the server reads once and then takes out of its environment. Sealed values need the server's secret key: `PIPOCA_SECRET_KEY`, or the key in `server.db.key` next to the database.

### A locked file

`--locked-config <path>` names a second `pipoca.json` whose keys win over the same keys in the config folder's file. Settings shows them as set in the config file without letting anyone change them. The Helm chart mounts its `lockedConfig` value there, for keys that should change only through a chart upgrade, such as sign-in. When the locked file sets `plugins`, no switch on the Plugins page changes.

## What else is in the config folder

Folders in the config folder hold the server base Profile (`base/`), Profiles (`profiles/<id>/`), each person's My defaults (`people/<id>/`) and routines (`routines/<owner>/`). They are plain files you can back up, read and edit.
