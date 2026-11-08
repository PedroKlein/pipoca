---
title: Choosing a setup
description: The ways to run Pipoca, and which one fits you.
sidebar:
  order: 1
---

Pipoca is one binary that is both a server and a runner. Where you put each one makes the setups below ([ADR 0053](../adr/0053-ways-to-run-pipoca.md)). You can start with one and move to another later.

| Setup                          | For                 | Server                    | Sessions run on                              | Start with                               |
| ------------------------------ | ------------------- | ------------------------- | -------------------------------------------- | ---------------------------------------- |
| [On your laptop](solo.md)      | You                 | Your laptop               | Your laptop                                  | `pipoca up`                              |
| [On a VM](vm.md)               | You                 | A VM or any always-on box | The VM, and your laptop while it's connected | `pipoca connect me@my-vm`                |
| [For a team](team.md)          | A team              | A shared machine          | Each person's runners, and the team's own    | `pipoca server --url https://…`          |
| [In Kubernetes](kubernetes.md) | A team, or just you | A pod                     | Runner pods started on demand, or any runner | `helm install pipoca deploy/helm/pipoca` |

## Questions that decide it

**Who uses it?** A solo install, made by `pipoca up` or the desktop app, has one person: no People page, no sign-in for others, no team hub. A team server has admins and users, each with their own Sessions, plus team work that everyone shares ([ADR 0064](../adr/0064-one-team-per-server.md)). One server is one team; two teams run two servers.

**Should Sessions keep going while your laptop sleeps?** On a solo laptop install they stop when the laptop does, and carry on when it wakes. Put the server on a VM and run Sessions there, and they keep going.

**Where does the code live?** A Session works where its runner runs. A runner on your laptop works in the folders you share, as worktrees of your own checkouts. A runner on a VM or in a pod works in fresh clones of the repositories you name, so it needs git access to them, which [git hosts](../admin/git-hosts.md) give it.

**Who holds the model logins?** Logins are kept on the server, sealed with its key, and reach a runner only for the Sessions that use them ([ADR 0045](../adr/0045-server-kept-logins.md)). On a team server, each person's logins serve only their own Sessions, and team work uses keys the server holds behind a proxy, so runners never see them ([ADR 0066](../adr/0066-team-credentials-and-usage.md)).

**Is it reachable from the internet?** A solo install listens only on `127.0.0.1`. Reach it from your phone through your own private network, such as Tailscale. A team server needs HTTPS in front of it, from your gateway, an Ingress or a reverse proxy.

## Mixing them

Every setup has the same parts, so they mix. A team server in Kubernetes can have people's laptops join as runners. A VM server can start containers. Several machines can join one Environment as a pool. [Environments and runners](../admin/environments.md) covers how.
