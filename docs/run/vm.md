---
title: On a VM
description: Keep your server on an always-on machine and connect to it from your laptop.
sidebar:
  order: 3
---

A solo server on an always-on machine, such as a VM, keeps Sessions going while your laptop sleeps. Your laptop connects to it over SSH and joins it as a runner, so Sessions can still work in your local checkouts while it's connected ([ADR 0053](../adr/0053-ways-to-run-pipoca.md)).

## Connect from your laptop

With `pipoca` installed on your laptop and SSH access to the VM:

```sh
cd ~/code && pipoca connect me@my-vm
```

`pipoca connect` does the rest:

1. If the VM has no `pipoca` on its `PATH` or in `~/.pipoca/bin`, it downloads the release of its own version for the VM's system from GitHub into `~/.pipoca/bin`, checks it against the release's `SHA256SUMS` (downloaded on your laptop, so a second path vouches for it), and installs `pipoca up` there as a service. The VM needs `curl`. Set `PIPOCA_RELEASES` to download from a mirror instead.
2. It holds an SSH tunnel from `127.0.0.1:7420` on your laptop to the server's port on the VM, and starts `ssh` again whenever the tunnel drops. The tunnel never shares a `ControlMaster` connection from your SSH config, so `connect` can tell when it drops.
3. It signs you in by running `pipoca link` on the VM over SSH, so it needs nothing but your SSH access, and opens the browser through the tunnel.
4. It runs your laptop as a runner through the tunnel, in an Environment named after it, sharing the folder you ran it in or the ones you pass with `--folder`.

| Option                     | What it does                                                            | Default                    |
| -------------------------- | ----------------------------------------------------------------------- | -------------------------- |
| `--folder <path>`          | A folder of this machine Sessions can work in. Repeat it for more.      | The current folder         |
| `--port <n>`               | The server's port on the VM.                                            | `7420`                     |
| `--local-port <n>`         | The tunnel's port on your laptop.                                       | `7420`                     |
| `--no-open`                | Don't open the browser.                                                 |                            |
| `--print-link`             | Print the sign-in link instead of opening the browser.                  |                            |
| `--remote-pipoca <path>`   | `pipoca` on the VM, when a plain `ssh me@my-vm pipoca` doesn't find it. |                            |
| `--remote-database <path>` | The database of the server there, when it runs with `--database`.       |                            |
| `--name <name>`            | This machine's runner name there.                                       | Its host name              |
| `--data-dir <path>`        | Where this machine keeps its Sessions, in a folder named by `--name`.   | `~/.pipoca/servers/<host>` |

To keep the connection up at every login, run `pipoca service install connect me@my-vm` with the same options. It opens no browser. To sign in, run `pipoca link` on the VM (`~/.pipoca/bin/pipoca link` when `connect` installed it) and open the link it prints, which reaches the server through the tunnel when both ports are the same.

## On the VM

The server on the VM is the same solo server as [on your laptop](solo.md). If you'd rather set it up yourself, install `pipoca` there and run `pipoca service install up` in the folder Sessions should work in. A server that `connect` installed shares the VM user's home folder, since the service is installed from there.

Sessions on the VM use the VM's own tools, so set these up as the user that runs the server:

- **git**, with access to the repositories you'll clone, or connect a [git host](../admin/git-hosts.md) in Settings > Accounts so Sessions clone and push as you.
- **Whatever your projects need** to build and test. The service keeps the `PATH` it was installed from, so install it from a shell that has your tools.
- **Nothing from your own Pi setup.** Sessions take their packages, instructions and settings from their [Profile](../use/profiles.md), and logins live on the server.

The service is a systemd user unit, which stops when you log out unless lingering is on:

```sh
loginctl enable-linger "$USER"
journalctl --user -u pipoca -f
```

`curl -s 127.0.0.1:7420/healthz` on the VM returns the running version and the Pi version it bundles, or a 503 when the database can't be read.

## Sessions on the VM

In New session, pick the VM's Environment, **This machine**, in the Environment chip. Pick a folder on the VM, or paste a repository URL to get a fresh clone on the Session's own branch. The **Start from** chip picks the branch, tag or commit the branch starts at.

Sessions in your laptop's Environment run only while `connect` is running. A Session in a clone picks up where it stopped when the laptop comes back; with several machines in one pool, it moves to another one ([Runner pools](../admin/environments.md#runner-pools)).

## Update it

The running server keeps its binary busy, so put the new one next to it and move it into place, then restart the service:

```sh
ssh me@my-vm 'curl -fsSL -o ~/.pipoca/bin/pipoca.new https://github.com/PedroKlein/pipoca/releases/download/v<version>/pipoca-linux-x64 \
  && chmod +x ~/.pipoca/bin/pipoca.new && mv ~/.pipoca/bin/pipoca.new ~/.pipoca/bin/pipoca \
  && systemctl --user restart pipoca'
```

Use `pipoca-linux-arm64` on an ARM VM, and update `pipoca` on your laptop to the same version. Running Sessions are interrupted and reload from their transcript; a tool that was running is recorded as interrupted by a restart. See [Upgrading](../admin/upgrading.md).
