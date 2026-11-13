---
title: Plugins
description: The built-in plugins, turning plugins on and off, and installing others.
sidebar:
  order: 6
---

Everything past Pipoca's small kernel is a plugin, the built-in ones included ([ADR 0015](../adr/0015-plugins.md), [ADR 0069](../adr/0069-plugin-sdk-v2.md)). No plugin is special: an admin can turn any of them off on the Plugins page, and the kernel never names one. When something the kernel needs, such as runners started on demand, has no plugin to provide it, the UI says what is missing.

## Built-in plugins

| Plugin       | What it does                                                                                | On by default          |
| ------------ | ------------------------------------------------------------------------------------------- | ---------------------- |
| `projects`   | Projects with a coordinator and threads, shared memory and files, and the Pipoca assistant. | Yes                    |
| `changes`    | A Session's changes as a diff, with line comments, and pull requests.                       | Yes                    |
| `subagents`  | Subagents a Session starts, workflows and missions.                                         | Yes                    |
| `checklist`  | The agent's checklist of its steps, above the composer.                                     | Yes                    |
| `diagrams`   | Mermaid diagrams drawn in chat, and guidance for the agent on when to use one.              | Yes                    |
| `ask`        | Questions to you in a form, and votes in team work.                                         | Yes                    |
| `routines`   | Routines on a schedule, an event or a webhook, and wake-ups. Requires `subagents`.          | Yes                    |
| `artifacts`  | Pages, documents and pictures Pi publishes, with versions and comments, shown in a sandbox. | Yes                    |
| `files`      | What Pi makes in `outputs/` and the files people give a Session, kept on the server.        | Yes                    |
| `slack`      | Slack messages as routine triggers, and posts and thread replies from Sessions.             | Yes                    |
| `email`      | Mail as routine triggers, and mail from Sessions.                                           | Yes                    |
| `models`     | Model aliases per Environment, with fallbacks when a model fails.                           | Yes                    |
| `logins`     | Model and MCP logins kept on the server, and the proxy for the team's keys.                 | Yes                    |
| `usage`      | Token use and cost in each Session's header, and team spend, budgets and the audit log.     | Yes                    |
| `oidc`       | Sign-in through OpenID Connect providers.                                                   | Only on a team server  |
| `local`      | Runners on the server's own machine.                                                        | Only on a solo install |
| `kubernetes` | Runner pods for an Environment when the server runs in a cluster.                           | Yes                    |
| `git-hosts`  | People's GitHub and GitHub Enterprise accounts, pull request watching, and technical users. | Yes                    |
| `push`       | Notifications on your devices when Pi finishes or needs you.                                | Yes                    |

Each plugin's card on the Plugins page shows what it needs, what needs it and the plugins it works with ([ADR 0077](../adr/0077-plugin-dependencies.md)). Turning off a plugin that others require turns them off too, and turning one on turns on the plugins it requires, after a confirm that lists them.

## Turn plugins on and off

The switches on the Plugins page and in server setup's Plugins step write `plugins` in `pipoca.json`, and take effect when the server next starts:

```json
{ "plugins": { "slack": { "personal": false }, "routines": { "team": true } } }
```

`personal` turns a plugin on or off, and `team` turns it on or off in team work. A plugin left out keeps its default: built-in plugins on, installed ones off, `local` only on a solo install and `oidc` only on a team server. In team work, built-in plugins start on and installed ones off; admins change that in Team setup's **Plugins in team work**. When the locked config file sets `plugins`, no switch changes from the page.

A plugin whose tables another version of it made fails to start and keeps its data. **Reset data**, next to the reason on the Plugins page, drops its tables, makes them again empty and starts it.

## Install a plugin

Installed plugins live in the `--plugins` folder, next to the database by default ([ADR 0022](../adr/0022-plugin-model-v2.md#installing-third-party-plugins)). Each is a folder named by its id whose `package.json` names its `definePlugin` file. There are three ways to put one there:

- **From git**: paste the repository's URL on the Plugins page. A branch, tag or commit after `#` pins it, such as `https://github.com/you/greeter.git#v1.0.0`. The plugin's `package.json` has to be at the top of the repository. Use an ssh URL with a key for a private repository.
- **From a tarball**: paste a `.tgz` URL. It must hold one folder, as `npm pack` makes.
- **In place**: ask the [assistant](../use/assistant.md) to write one. It writes the files into the plugins folder and builds them, but it can't turn the plugin on.

You can also put the folder in the plugins folder yourself, or link it there from where you develop it. A plugin installed from git or a tarball is pinned to its commit or SHA-256 in `.source.json` in its folder. **Update** fetches the newest version from the same URL, and **Remove** works once the plugin isn't running.

An installed plugin starts turned off, and none of its code runs. **Turn on** asks first, listing what its server part uses and where its parts run. A plugin that is on is installed and bundled into `.build` each time the server starts, using the server's own binary as `bun`, so the machine needs neither Bun nor npm, and a build error shows on the Plugins page. A new version that adds a part is turned off until you turn it on again.

A plugin runs with the server's own access, and nothing sandboxes it, so turn on only plugins you trust. An installed plugin can't sign people in.

## Restart the server

A change to the plugins takes effect when the server next starts. **Restart now** on the Plugins page makes the server exit with code 75 for whatever runs it to start it again: systemd with `Restart=on-failure`, `pipoca server --supervise`, or `bun run dev`. It asks first while a Session on the server's own runner is mid-turn, since that turn is interrupted.

The container image runs the server with `--supervise`, so in Kubernetes it restarts inside its container and the kubelet doesn't count a restart as a crash. The server knows systemd by `INVOCATION_ID`; `--supervise` and the dev loop set `PIPOCA_SUPERVISED=1` for the server they start, which you can set for any other supervisor that restarts on exit. Elsewhere it says to restart the server yourself.

To write a plugin of your own, see [Build plugins](../build-plugins/overview.md).
