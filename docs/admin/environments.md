---
title: Environments and runners
description: Where Sessions run, how runners join, and the setup, secrets, containers and pods an Environment can have.
sidebar:
  order: 2
---

An Environment is one person's or the team's settings for running Sessions, plus a pool of runners ([ADR 0032](../adr/0032-environments-and-runners.md), [ADR 0049](../adr/0049-personal-environments-and-templates.md)). Its settings are an isolation, an image, a setup script, variables and secrets. A runner is a `pipoca agent` process in the pool: it polls the server, runs each Session in its own process and keeps the Session's workspace.

A new Session runs in the Environment it names, as a Project's Sessions name the Project's. Otherwise it runs in the person's default Environment, or else in their first one. Team work picks only among the team's Environments.

## Join a machine

In Settings > Environments, make an Environment, such as one named `laptop`. The page shows its key once, in the command that starts an agent:

```sh
PIPOCA_KEY=pck_… pipoca agent --name laptop --server https://pipoca.example.com --folder ~/code
```

The agent connects out to the server, so the machine needs no open port. It only runs Sessions in the folders you list with `--folder`, or in folders inside them, and the folder chip lists the git checkouts it finds there. `--capacity` caps how many Sessions it runs at once. See [Command line](../reference/cli.md#pipoca-agent) for every option.

A solo install needs none of this: its **This machine** Environment's runner starts by itself ([On your laptop](../run/solo.md)).

### Keys and tokens

An agent joins the pool of the Environment whose key it holds, under its `--name`, and gets a token of its own for everything else ([ADR 0033](../adr/0033-v2-authentication-and-order.md)). Each Session it starts gets a token too, which reaches only that Session. The agent reads the key from `PIPOCA_KEY` and removes it from what its Sessions inherit.

- **Replace key** in Settings > Environments lets go of every agent that joined with the old key; start them again with the new one.
- A name belongs to one runner in an Environment. While a runner of that name is online there, the agent prints `a runner named <name> is online here` and exits with code 1; give it another `--name`, or stop the other one and wait until the Environments page shows it offline, about 30 seconds after its last poll. An agent that joins under the name of an offline runner takes it over, and the old runner's token stops working.
- The agent keeps its token in `runner.json` in its `--data-dir`, readable only by its user, so a restart against the same server with the same key comes back as the same runner without joining. It joins again when that token is gone or refused.
- A runner token that no agent has polled with for 30 days (`server.runnerTokenDays`) stops working. An agent started with the key just joins again; one started with `PIPOCA_TOKEN` alone needs a new token.
- A runner that a plugin starts, such as a Kubernetes pod, gets a token in `PIPOCA_TOKEN` instead, and `--exit-when-idle <seconds>` stops it once it has run no Session for that long.

A machine keeps each server's data apart ([ADR 0063](../adr/0063-settings-and-first-run-setup.md#one-data-folder-per-server-on-a-machine)). An agent for the machine's own server keeps its Sessions, Profiles and workspaces in `~/.pipoca/agent`, and one for another server in `~/.pipoca/servers/<host>`, as does `pipoca connect`. A runner that already ran in `~/.pipoca/agent` for that server stays there, since its worktrees hold absolute paths into it.

## Setup script, variables and secrets

An Environment can have a setup script, variables and secrets. Each agent runs the setup script once per version before the first Session that needs it, and a Session's processes and terminals get the variables and secrets. The API lists secret names only.

The server encrypts secrets with AES-GCM before it stores them, using the key in `PIPOCA_SECRET_KEY` (`openssl rand -base64 32`), or else one it makes in `server.db.key` next to the database. Losing the key loses every stored secret.

A `GH_TOKEN` secret also signs git in to github.com over https, both for cloning a Session's repositories and for the Session's own pushes, whether or not a [git host](git-hosts.md) is listed.

## Containers

With isolation **container**, each Session's Pi process runs in a container from the Environment's `image` (default `node:22-bookworm`; any image with glibc, bash and git works), as the agent's user, with the agent's data folder, its `--folder`s and the workspace mounted at the same paths. The agent needs Docker.

- The agent mounts its own Linux binary into the container, so a Linux agent needs nothing else.
- A released agent on a Mac copies the binary of its own version out of the Pipoca image (`ghcr.io/pedroklein/pipoca:v<version>`) into a Docker volume once.
- An agent run from source needs `--session-binary <path to a Linux pipoca binary>`.

The setup script then runs once in the image as root, and Sessions run in the image it leaves. Terminals open a shell in the Session's container.

## Runner pools

Several agents can join one Environment's pool with its key.

- A Session in a folder goes to an agent that lists the folder, and a Session that has run goes back to the agent it ran on.
- A clone or several-repositories Session moves to another agent in the pool if its agent stops polling for a minute. It starts again from its transcript in a fresh checkout of its branch, so only pushed work comes along.
- An agent that can't reach the server for 30 seconds stops those Sessions itself, so two agents never run one Session.

## Private hosts

Some hosts only some machines reach, such as a company's GitHub Enterprise inside its network ([ADR 0080](../adr/0080-private-hosts-reached-through-environments.md)).

- Admins list them under `privateHosts.hosts` in `pipoca.json`, each as `{ "host": "github.acme.internal", "ca": null, "teamWatch": false }`. A host is an exact name with an optional `:port`, 443 by default.
- A machine's owner names the private hosts it reaches with `--reach`, repeated for more: `PIPOCA_KEY=pck_… pipoca agent --reach github.acme.internal`. Names are exact, with no wildcards, IP addresses or `localhost`, and a name that resolves to a loopback or link-local address counts as not reached.
- The agent checks each one with a TLS connection at start and every 5 minutes, and the Environments page shows what each Environment reaches.
- A Session whose repository is on a private host starts only in an Environment with a runner that reached it, and only such a runner takes it. Elsewhere it's refused with `unreachable_host`.
- The server's own calls to a private host, such as a git host's API or a push, go through a relay: the agent keeps a socket open to the server, and the server opens a tunnel over it to the host's port. TLS runs from the server to the host, checked against the host's `ca` when it has one, so the machine forwards bytes it can't read. A person's calls go only through their own Environments, and the team's only through team Environments.
- The server checks each host with a TLS handshake of its own through the tunnel before using it, and the Environment's page lists the hosts confirmed and the last 50 tunnels with who they were for. Deleting the Environment or taking the host off the list closes its tunnels.
- Team routines watch a private host only when its `teamWatch` is true, since every user can start team routines.

## Templates

Admins can share an Environment's settings as a template ([ADR 0049](../adr/0049-personal-environments-and-templates.md)): a setup script, isolation, image, variables and model aliases, but never secrets or runners. Make one under Templates on the Environments page, or list them under `templates` in `pipoca.json`, for example from the chart's `config` value:

```json
{
  "templates": [
    {
      "id": "pods",
      "name": "Cluster pods",
      "setupScript": "apt-get install -y ripgrep",
      "variables": { "REGION": "eu" }
    }
  ]
}
```

Anyone can then make an Environment from a template, by picking it next to New Environment. That Environment is theirs, with their own secrets, variables and runners. Its setup script, isolation and image come from the template, and the template's variables sit under its own. A change to a template reaches each of those Environments when a Session next starts. If a template is deleted, its Environments go back to their own settings.

### Templates from a repository

A repository's `pipoca.json` can list templates under `"templates"`, each a JSON file in the repository with the template's `isolation`, `image`, `setupScript`, `variables` and `aliases`, never secrets. A `kubernetes` key in the file is left out, since only admins set a template's pod settings. The `aliases` are a model alias config like the one on the Models page, and Environments made from the template use them unless an admin gives the Environment its own. On the Environments page, an admin uses **From a repository** under Templates to bring the ones they pick. They follow the repository, every `server.repositorySyncMinutes`, and change only there.

## Runner pods

The `kubernetes` plugin starts runner pods for Environments made from a pod template, in the server's namespace. [In Kubernetes](../run/kubernetes.md#runner-pods) covers the settings. What happens around them:

- **Unfinished work.** With `"workspace": "pod"`, a workspace lives only as long as its pod. After every turn and as the pod stops, the `files` plugin keeps each checkout's unfinished work on the server: commits no remote has, and changed and new files that `.gitignore` doesn't exclude. The next pod clones the Session's branch and puts that work back, so ignored folders such as `node_modules` are rebuilt. `files.snapshots.maxBytes` (500 MB by default) is the most kept per checkout; over it the Session says so. `files.snapshots.enabled` turns this off.
- **Claims.** With `"workspace": "claim"`, each Session gets a pod of its own, named after it, whose home is a claim of `claimSize`. If that pod stops or is deleted, the plugin starts it again with the same claim, and the claim goes once the Session is archived.
- **Failures.** A pod that hasn't started after 10 minutes is deleted. When a pod fails, or stops without its agent ever reaching the server, the next pod for that Environment waits 10 seconds, twice as long after each failure in a row up to about 5 minutes, and the Environment's Kubernetes section shows why.
- **Security.** A pod runs under the container runtime's default seccomp profile, and the init container that copies the binary runs as uid 1000 with no capabilities. The runner container runs as its image's user, since a setup script may need root.
- **Upgrades.** After a `helm upgrade`, the server compares the Pipoca image each runner pod copied its binary from with its own, at start and on every pass. It deletes a pod whose image differs, even mid-turn, and the plugin starts a new one, so no pod runs an old binary against the new server. The pod gets a grace period of 30 seconds: its agent stops its Sessions first, waiting up to 10 seconds for each, and a tool cut off is recorded as interrupted by a restart. A `podPatch` that lowers `terminationGracePeriodSeconds` should leave more than 10 seconds.

## Who sees what

Each person sees and uses only their own Environments and Sessions. A runner that joins with a join key gets an Environment of the person who made the key. Admins see everyone's on the People page in Settings, as an outline, without variable values, folders or what a Session was first asked. Its owner or an admin can delete an Environment once all its Sessions are archived, which revokes its key and its runners' tokens and removes its archived Sessions. Admins can stop, archive and unarchive anyone's Session, but they can't read its transcript, open its terminal or send it a message.

The team's Environments are managed by admins in Team setup. Their runners host only team Sessions, and personal runners only personal ones, so one person's credentials never share a machine with anyone else's.
