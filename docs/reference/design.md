---
title: Design and decisions
description: Where to read how Pipoca is built and why.
sidebar:
  order: 5
---

- [Architecture](../architecture.md): the processes, how runners and Sessions talk to the server, storage and the plugin host.
- [Decision records](../adr/): every decision Pipoca's design rests on, numbered in the order they were made, with what was considered and why. Later records say which earlier ones they replace.
- [Vision](../vision.md): what Pipoca is trying to become, and its non-goals.
- [Design system](../design-system.md): the UI's tokens, components and writing rules, which plugins use too.
- [Open questions](../open-questions.md): what isn't decided yet.

The records most worth reading first:

| Record                                                                         | What it decides                                         |
| ------------------------------------------------------------------------------ | ------------------------------------------------------- |
| [0015: Plugins](../adr/0015-plugins.md)                                        | A small kernel, and every feature a plugin.             |
| [0053: Ways to run Pipoca](../adr/0053-ways-to-run-pipoca.md)                  | Solo, VM, team and Kubernetes installs from one binary. |
| [0064: One team per server](../adr/0064-one-team-per-server.md)                | Admins and users, team work open to the team.           |
| [0068: Clean rebuild](../adr/0068-clean-rebuild.md)                            | The database, route table and storage as they are now.  |
| [0069: Plugin SDK v2](../adr/0069-plugin-sdk-v2.md)                            | `definePlugin` and its three parts.                     |
| [0074: Profile layers](../adr/0074-profile-layers-you-can-see-and-turn-off.md) | How the base, My defaults and Profiles add up.          |
| [0075: Routines](../adr/0075-routines-groups-coordinators-and-agents.md)       | Routines with groups, coordinators and agents.          |
