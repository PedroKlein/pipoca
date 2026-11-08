---
title: Subagents
description: Let Pi split work across helpers, script longer flows as workflows, and track missions.
sidebar:
  order: 6
---

When Pi delegates to subagents (the `subagents` plugin, [ADR 0057](../adr/0057-pipocas-own-subagents.md), [ADR 0058](../adr/0058-subagents-v2.md)), each run shows as a card in the chat with its agents, progress and time. Open an agent to see its steps and output, and use **Steer** or **Stop** while it runs. The header's **Subagents** button opens every run of the Session in a side panel.

## Runs

Subagents run inside the Session, on its own model and logins. A run goes in the background by default, and runs its agents one at a time, in parallel, or as a chain where each step gets the previous one's output, at most 4 at once.

A run that a restart of the Session cut off, such as an upgrade, shows as interrupted, and its card's **Resume** button carries on with it.

## Agents

The built-in agents are `scout`, `worker`, `reviewer` and `delegate`. A Profile adds its own as Markdown files in `agents/`, and a trusted repository in `.pi/agents/`. A Profile's Overview lists its agents and workflows and edits each agent's description, model, thinking level and tools.

`/parallel-review`, `/review-loop`, `/parallel-research` and `/gather-context-and-clarify` are shortcuts that ask Pi to fan out.

## Workflows

For flows that are more than one chain or batch, such as a review loop, Pi can write a workflow: a short JavaScript script that starts runs with `runs.run` and `runs.all`, steers them with `runs.steer`, and reads `args`. It runs in a QuickJS sandbox with no files, shell or network, and shows as one card with a row per step.

Save workflows as `.js` files in a Profile's `workflows/` folder or a trusted repository's `.pi/workflows/`, and start one with `/workflow <name> [args as JSON]`. A workflow that a restart cut off runs again from the start on Resume, and the steps that had finished give back their output instead of running again.

## Missions

For work toward one objective over many runs, such as a feature that ends in a pull request, Pi can open a mission. The Subagents panel shows each mission with its runs, the links it produced, and the questions it put to you. Answer a question there with one of its options or your own words, and Pi picks your answer up. While a question waits on you, the Session shows as needing you. A workflow started for a mission keeps a small JSON `state` there between runs.

## The watchdog

A Profile can turn on a watchdog in its Pi `settings.json`:

```json
{ "subagents": { "watchdog": { "enabled": true } } }
```

with an optional `model` and `thinking`. At the end of each turn that changed the Git working tree, a second model reviews the change with read-only tools, the turn's prompts and any `WATCHDOG.md` from the repository's `.pi/` folder or the Profile. High findings go back to Pi to fix; low and medium ones show in the chat for you only. A high finding that comes back 3 turns in a row stops being sent until your next message.
