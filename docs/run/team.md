---
title: For a team
description: Run one Pipoca server that a team signs in to.
sidebar:
  order: 4
---

A team server is one Pipoca server that several people sign in to ([ADR 0064](../adr/0064-one-team-per-server.md)). Each person has their own Sessions, Environments, Profiles and logins, which nobody else reads, admins included. On top of that the team has work of its own, with a hub that everyone shares: see [Team work](../use/team.md).

One server is one team, with two roles: admins, who manage the server and what the team owns, and users. Two teams run two servers.

## Start the server

On a machine the team can reach, behind HTTPS:

```sh
PIPOCA_SECRET_KEY=$(openssl rand -base64 32) \
pipoca server --host 0.0.0.0 --url https://pipoca.example.com --trust-proxy
```

Keep the secret key somewhere safe and give the server the same one every time: it seals every secret, login and key the server keeps. Without `PIPOCA_SECRET_KEY`, the server makes one in `server.db.key` next to the database. Losing the key loses every stored secret.

| Option             | What it does                                                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--host <address>` | The address to listen on. Use `0.0.0.0` behind a proxy or in a container. Default `127.0.0.1`.                                                          |
| `--url <url>`      | Where people open it, when that differs from the address it listens on, so links and sign-in callbacks point there.                                     |
| `--trust-proxy`    | Count failed sign-ins by the client address the proxy in front adds last to `X-Forwarded-For`. Set it only when every request comes through that proxy. |
| `--supervise`      | Run the server as a child process and start it again when it asks to restart, such as after a plugin is turned on.                                      |
| `--sso-only`       | Sign in only with single sign-on, never a password.                                                                                                     |

[Command line](../reference/cli.md#pipoca-server) lists the rest. To run it on Kubernetes instead, see [In Kubernetes](kubernetes.md).

The server needs a supervisor that starts it again when it exits with code 75, as Restart now on the Plugins page asks: `--supervise`, or a systemd unit with `Restart=on-failure`.

## Set it up

The first time it starts, the server logs a setup link (`open the setup link to create the first user`). Open it to create your user, who is the first admin; the link works once. Server setup then asks who the server is for, **A team**, and goes through what the server shares ([ADR 0072](../adr/0072-server-setup-and-personal-setup.md)):

- **Plugins**: which built-in plugins stay on, and any to add.
- **Server default Profile**: the base under every Session on the server, with the team's packages, skills and instructions. See [Profiles](../use/profiles.md#layers).
- **Shared model keys**: the providers the server pays for. Everyone can still sign in with their own accounts.
- **Where Sessions run**: people's own machines, shared team machines, or pods when the `kubernetes` plugin is on.
- **New people**: what each new person gets, and which setup steps they must do.
- Steps from plugins that are on, such as **Sign-in** from `oidc` and **Code hosts** from `git-hosts`.

Then comes your own setup, which everyone does: your code hosts, your models and your default Profile. Every step can be changed later in Settings.

## Add people

- **Invite them** from Settings > People: an invite link for each email address, or one link anyone can join with, each with an expiry.
- **Sign them in with single sign-on** through any OpenID Connect provider, letting in the groups or emails you choose. See [Single sign-on](../admin/single-sign-on.md).

A browser stays signed in for 30 days. Ten wrong passwords for a name from one address lock that name there until 15 minutes after the first of them, and 50 wrong passwords from one address, for any names, lock that address.

## Where Sessions run

Each person's Sessions run on runners only they use, so one person's credentials never share a machine with another's ([ADR 0049](../adr/0049-personal-environments-and-templates.md)):

- **Their own machine.** A person makes an Environment in Settings > Environments and starts `pipoca agent` with the key it shows. The runner connects out to the server, so the machine needs no open port.
- **A template.** Admins share an Environment's settings as a template, and each person makes their own Environment from it, with their own secrets and runners.
- **Pods.** With the `kubernetes` plugin, a pod template starts runner pods for each person's Environment on demand.

Team work runs on the team's own Environments, whose runners host only team Sessions. [Environments and runners](../admin/environments.md) covers all of it.

## Next

- Give the team a code host and a bot: [Git hosts](../admin/git-hosts.md).
- Share model keys and set budgets: [Models and logins](../admin/models-and-logins.md).
- Learn what people see: [Team work](../use/team.md).
