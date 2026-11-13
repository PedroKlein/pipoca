---
title: Private hosts
description: Reach a git host, issue tracker or MCP server inside your company network through a machine that can.
sidebar:
  order: 5
---

Some hosts only some machines reach, such as a company's GitHub Enterprise inside its network. The Pipoca server can't open them itself, so it reaches them through an Environment whose machine can ([ADR 0080](../adr/0080-private-hosts-reached-through-environments.md)). A person's calls go only through their own Environments, and the team's only through team Environments. Nobody's calls ever go through someone else's machine.

## List the host (admins)

Open Settings > **Private hosts** and press **Add a private host**:

- **Host** is the exact name, with `:port` when it isn't 443, such as `github.acme.internal`. Only https is relayed.
- **Certificate authority** is your company's CA in PEM, if the host's certificate isn't from a public CA. Pipoca trusts it for that host only, in its own calls and in the git it runs.
- **Team routines may watch it** stays off unless you allow it, since every user can start team routines.

A git host can also be marked private from its card in server setup or in Settings > Git hosts: the **Private host** switch adds it to the same list, and the card takes its CA too.

The list is kept in `pipoca.json` under `privateHosts.hosts`, each as `{ "host": "github.acme.internal", "ca": null, "teamWatch": false }`. Each row on the page shows how many people have an Environment that reaches the host, and how team work reaches it. Admins see names and status only, never the calls.

## Connect a machine that reaches it (everyone)

Each person who works on the host connects a VM or laptop on that network as one of their Environments. The join command in Settings > Environments, and the **Where should Pi work** step of setup, offer a checkbox for each listed host and add its `--reach`:

```sh
PIPOCA_KEY=pck_… pipoca agent --server https://pipoca.example.com --reach github.acme.internal
```

`--reach` is the machine owner's consent. The machine relays only to the hosts named there, and the server can't add more. Names are exact, with no wildcards, IP addresses or `localhost`. A name that resolves to a loopback or link-local address counts as not reached. The agent checks each one with a TLS connection at start and every 5 minutes.

Setup lists, for a machine that names private hosts, whether it joined, whether it reached each host, and whether Pipoca has confirmed it. Pipoca confirms a host with its own TLS handshake through the machine, on the first call that needs it.

For team work, an admin joins a shared VM on that network as a team Environment with the same `--reach`. The team's App polls for events and pushes through it. Without one, team calls to the host pause and say why, while people's own work is unaffected.

## What changes once it's reached

- **Accounts and setup** show the host as Private and say what it is reached through. Signing in to it waits until a machine of yours reaches it, and then goes through that machine.
- **New session**: picking a repository on the host splits the Environments into those that reach it and those that can't, and picks one that reaches it.
- **Routines** on a repository on the host warn when their Environment can't reach it, and offer one that can. A team routine that watches a URL on a private host is refused unless an admin allowed team routines to watch it.
- **The repo picker, pull request watching and pushes** to the host all go through your machine while it is online. While it's offline they pause and say so.

## What the machine sees

The machine passes encrypted traffic only. TLS runs from the server to the host, checked against the host's CA, so the machine sees which host each relay goes to, when, and how much, but never the content or the tokens.

An Environment's page lists the private hosts its machines reach, whether Pipoca confirmed each one, and its recent relays: the time, the plugin and what the call did (such as "Git hosts · repo picker search"), who it was for, the bytes and the duration. Revoking the machine's runner or deleting the Environment closes its relays at once, and so does taking the host off the list.

For how a plugin calls a private host, see [Calling out](../build-plugins/server.md#calling-out).
