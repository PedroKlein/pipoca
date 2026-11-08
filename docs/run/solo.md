---
title: On your laptop
description: Run Pipoca for yourself with pipoca up.
sidebar:
  order: 2
---

A solo install is a Pipoca server for one person, on their own machine ([ADR 0053](../adr/0053-ways-to-run-pipoca.md)). It has no other users, no People page and no setup link.

## Install

Install it with Homebrew, `brew install pedroklein/pipoca/pipoca`, or take the binary for your system from a [release](https://github.com/PedroKlein/pipoca/releases). The [desktop app](desktop-and-phone.md) does the same as this page without a terminal.

## Start it

```sh
cd ~/code && pipoca up
```

`pipoca up` starts the server and opens the browser signed in. It makes an Environment named **This machine**, whose runner the server starts when a Session needs one and stops after five idle minutes, so there is no agent to start by hand. Its Sessions work in the folder you ran `up` in, or in the folders you pass with `--folder`, and in any folder inside them.

When the server is already running, `pipoca up` only opens it. `pipoca link` prints a one-time sign-in link instead, say for your phone, and `pipoca link --open` opens it. The link works once, within ten minutes, and only your own system user can get one, through a socket next to the database.

`pipoca server --solo` is the same server without opening the browser.

| Option              | What it does                                                         | Default               |
| ------------------- | -------------------------------------------------------------------- | --------------------- |
| `--folder <path>`   | A folder Sessions can work in. Repeat it for more.                   | The current folder    |
| `--port <n>`        | The port to serve on, on `127.0.0.1`.                                | `7420`                |
| `--database <path>` | Where the server keeps its data. Config sits in `config/` beside it. | `~/.pipoca/server.db` |
| `--print-link`      | Print the sign-in link instead of opening the browser.               |                       |

Any Environment can run Sessions on this machine: its **This machine** section turns it on, with how many Sessions run at once and which folders they work in.

## Keep it running

```sh
cd ~/code && pipoca service install up
```

This runs `pipoca up`, with the same options, at every login and again if it stops: a launchd agent on macOS (`~/Library/LaunchAgents/dev.pipoca.plist`, logging to `~/Library/Logs/pipoca.log`) and a systemd user unit on Linux (`~/.config/systemd/user/pipoca.service`). A service opens no browser, so use `pipoca link --open` to sign in. It keeps the `PATH` you installed it from, so it finds `docker` and `ssh`. `pipoca service uninstall` removes it.

## Where your work goes

Each Session gets its own Git worktree of the checkout you pick, on a branch named `pipoca/` plus the last 8 characters of the Session's id, so your own checkout stays as it is. Tick **Share the folder** in the folder chip to work in the folder itself. A pasted repository URL gets a fresh clone. [Sessions](../use/sessions.md#workspaces) has the details.

The server keeps its database in `~/.pipoca/server.db`, its config in `~/.pipoca/config/`, and the runner it starts keeps worktrees and Session data in `~/.pipoca/runners/<Environment id>/`. Logins are sealed with a key in `server.db.key` next to the database, or the one you give in `PIPOCA_SECRET_KEY` (`openssl rand -base64 32`). Losing the key loses every stored secret and login.

## From your phone

A solo server listens only on `127.0.0.1`. To reach it from your phone, put both on your own private network, such as Tailscale, and open the link `pipoca link` prints. [The desktop app and your phone](desktop-and-phone.md) covers notifications.

## When you outgrow it

To keep Sessions going while the laptop sleeps, move the server to a VM and keep the laptop as a runner: see [On a VM](vm.md). To share it with others, run a [team server](team.md).
