---
title: Command line
description: Every pipoca command and its options.
sidebar:
  order: 1
---

One `pipoca` binary is the server, the runner and the tools around them. `pipoca --help` lists the commands, and `pipoca <command> --help` explains one.

## `pipoca up`

Runs Pipoca for yourself on this machine and opens it. It starts a server for you alone, with Sessions running on this machine in the folders you share, and opens your browser signed in. When one is already running, it only opens it. See [On your laptop](../run/solo.md).

| Option              | What it does                                           | Default               |
| ------------------- | ------------------------------------------------------ | --------------------- |
| `--folder <path>`   | A folder Sessions can work in. Repeat it for more.     | The current folder    |
| `--port <n>`        | The port to serve on.                                  | `7420`                |
| `--database <path>` | Where the server keeps its data.                       | `~/.pipoca/server.db` |
| `--print-link`      | Print the sign-in link instead of opening the browser. |                       |

```sh
cd ~/code && pipoca up
```

## `pipoca connect`

Uses Pipoca on another machine over SSH. It tunnels to the server on a machine you reach with SSH, such as a VM, and opens your browser signed in through it. This machine joins it too, so Sessions can also run here, in the folders you share. A machine with no `pipoca` gets this version from GitHub, installed in `~/.pipoca/bin` and started as a service. The tunnel comes back whenever it drops. See [On a VM](../run/vm.md).

```text
pipoca connect <user@host> [options]
```

| Option                     | What it does                                                          | Default                    |
| -------------------------- | --------------------------------------------------------------------- | -------------------------- |
| `--folder <path>`          | A folder of this machine Sessions can work in. Repeat it for more.    | The current folder         |
| `--port <n>`               | The server's port on the other machine.                               | `7420`                     |
| `--local-port <n>`         | The tunnel's port here.                                               | `7420`                     |
| `--no-open`                | Don't open the browser.                                               |                            |
| `--print-link`             | Print the sign-in link instead of opening the browser.                |                            |
| `--remote-pipoca <path>`   | `pipoca` on the other machine, when it isn't on its `PATH`.           |                            |
| `--remote-database <path>` | The database of the server there, when it runs with `--database`.     |                            |
| `--name <name>`            | This machine's name there.                                            | Its host name              |
| `--data-dir <path>`        | Where this machine keeps its Sessions, in a folder named by `--name`. | `~/.pipoca/servers/<host>` |

`PIPOCA_RELEASES` makes it download a missing `pipoca` from a mirror instead of GitHub.

## `pipoca link`

Prints a link that signs you in to the server `pipoca up` started on this machine. The link works once, within ten minutes. Only your own system user can ask.

| Option              | What it does                  | Default               |
| ------------------- | ----------------------------- | --------------------- |
| `--open`            | Open the link in the browser. |                       |
| `--database <path>` | The database of that server.  | `~/.pipoca/server.db` |

## `pipoca service`

Starts `pipoca up` or `pipoca connect` at every login. It installs a launchd agent on macOS (`~/Library/LaunchAgents/dev.pipoca.plist`) or a systemd user unit on Linux (`~/.config/systemd/user/pipoca.service`) that runs the command at login and starts it again when it stops. It opens no browser; get a link with `pipoca link`. Folders default to the folder you install it from.

```text
pipoca service install up [up's options]
pipoca service install connect <user@host> [connect's options]
pipoca service uninstall
```

## `pipoca server`

Runs a server for a team, or one you configure yourself. It starts with no runner of its own; its log shows a one-time setup link for its first user. Machines join it with `pipoca agent`, or a plugin starts runners for it, such as Kubernetes pods. See [For a team](../run/team.md).

```text
[PIPOCA_SECRET_KEY=<32 bytes, base64>] pipoca server [options]
```

| Option                   | What it does                                                                                    | Default                        |
| ------------------------ | ----------------------------------------------------------------------------------------------- | ------------------------------ |
| `--host <address>`       | The address to listen on.                                                                       | `127.0.0.1`                    |
| `--port <n>`             | The port to serve on.                                                                           | `7420`                         |
| `--url <url>`            | The address people reach it at, behind a proxy.                                                 |                                |
| `--database <path>`      | Where it keeps its data.                                                                        | `~/.pipoca/server.db`          |
| `--sso-only`             | Sign in only with single sign-on, not passwords.                                                |                                |
| `--trust-proxy`          | Read the client's address from `X-Forwarded-For`.                                               |                                |
| `--supervise`            | Start it again when a plugin asks for a restart.                                                |                                |
| `--solo`                 | Serve only you, with a runner on this machine, as `pipoca up` does.                             |                                |
| `--folder <path>`        | With `--solo` or `--provider`, a folder Sessions can work in.                                   |                                |
| `--plugins <path>`       | The folder of installed plugins.                                                                | `plugins` next to the database |
| `--config-dir <path>`    | The folder of config files.                                                                     | `config` next to the database  |
| `--locked-config <path>` | A `pipoca.json` whose keys Settings can't change, such as Helm's.                               |                                |
| `--provider <name>`      | Also run Sessions on this machine, as a runner with this name, in the Environment of that name. |                                |
| `--data-dir <path>`      | With `--provider`, where Sessions are kept.                                                     | `~/.pipoca/server`             |
| `--extension <path>`     | With `--provider`, a Pi extension every Session loads. Repeat it for more.                      |                                |

`PIPOCA_SECRET_KEY` seals secrets and logins with a key of your own (`openssl rand -base64 32`); without it the server makes one in `server.db.key` next to the database.

## `pipoca agent`

Runs Sessions on this machine for a server. It joins a server as a runner of one of its Environments, with the key the Environments page shows, and runs that Environment's Sessions here. See [Environments and runners](../admin/environments.md).

```text
PIPOCA_KEY=<Environment key> pipoca agent [options]
```

| Option                       | What it does                                                                     | Default                                                                                 |
| ---------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `--server <url>`             | The server to join.                                                              | `http://127.0.0.1:7420`                                                                 |
| `--folder <path>`            | A folder Sessions can work in. Repeat it for more.                               | The current folder                                                                      |
| `--name <name>`              | This machine's name there.                                                       | Its host name                                                                           |
| `--capacity <n>`             | How many Sessions run here at once.                                              |                                                                                         |
| `--exit-when-idle <seconds>` | Stop after this long with no Session.                                            |                                                                                         |
| `--data-dir <path>`          | Where Sessions are kept.                                                         | `~/.pipoca/agent` for this machine's own server, `~/.pipoca/servers/<host>` for another |
| `--extension <path>`         | A Pi extension every Session loads. Repeat it for more.                          |                                                                                         |
| `--session-binary <path>`    | A Linux `pipoca` binary for container Sessions, when the agent runs from source. |                                                                                         |

`PIPOCA_TOKEN` takes a runner token instead of a key, as runners that a plugin starts get.

## Files it keeps

| Path                        | What                                                                      |
| --------------------------- | ------------------------------------------------------------------------- |
| `~/.pipoca/server.db`       | The server's SQLite database.                                             |
| `~/.pipoca/server.db.key`   | The key that seals secrets and logins, unless `PIPOCA_SECRET_KEY` is set. |
| `~/.pipoca/config/`         | `pipoca.json`, Profiles, My defaults and routines.                        |
| `~/.pipoca/plugins/`        | Installed plugins.                                                        |
| `~/.pipoca/runners/`        | Runners the server starts on its own machine, by Environment.             |
| `~/.pipoca/agent/`          | An agent's Sessions and workspaces, for this machine's own server.        |
| `~/.pipoca/servers/<host>/` | An agent's Sessions and workspaces, for another server.                   |
| `~/.pipoca/bin/pipoca`      | The `pipoca` that `connect` installed on a machine that had none.         |
