# 0061: The software factory

- Status: accepted
- Date: 2026-11-03

## Context

A software factory takes issues in and gives reviewed pull requests out, with the person only reviewing. The first sketch on 2026-11-02 sent each event to a Project's coordinator, which would start threads. That puts a model turn and a chat in the middle of something that should run by itself.

Cursor, Factory, Devin, the Copilot coding agent and GitHub Agentic Workflows all do it the other way: an event starts one agent run, keyed so the same issue doesn't start two, with no planning agent between the event and the run ([research](../research.md#automations-and-software-factories)). They differ in how the work is shaped. Devin picks a skill from a ticket's label, and Factory and GitHub ship a starter for each kind of work. OpenClaw built a server-side engine for fixed steps and removed it.

Pipoca already has the parts. Routines start Sessions from events ([ADR 0059](0059-routines-and-wake-ups.md)), subagent workflows run a script of steps inside a Session and survive restarts ([ADR 0058](0058-subagents-v2.md#workflows)), pull request watching fixes CI and review comments ([ADR 0051](0051-pull-request-watching.md)), and technical users give the work a bot identity ([ADR 0060](0060-technical-users-and-github-apps.md)).

## Decision

### A factory is routines

- A factory is routines with git host triggers, not a plugin of its own (decided 2026-11-03). Each event starts a Session, keyed by repository and issue or pull request.
- Small events don't start Sessions (decided 2026-11-03). An event whose key already has a Session goes to that Session as a message. Events within the quiet window are sent as one message, and a busy Session queues it. A comment on a pull request a Session is working on reaches that Session, as pull request watching does today.
- A routine's filters decide whether an event counts at all, such as only comments that mention `/pipoca`, or only reviews that request changes. A routine can also collect events and run on a schedule instead, as a digest.
- A routine's page is the factory's board: its runs by key, their state and their pull request.
- Projects stay for work the person steers. Filing a run as a thread in a Project, for the coordinator to see, is an opt-in run target that comes later.

### Steps come from workflows

- The steps a kind of work follows are a subagent workflow, and each step's instructions are an agent file with its own prompt, tools and model (decided 2026-11-03). They live in the Profile's `workflows/` and `agents/` folders or the repository's `.pi/`.
- A routine picks the workflow from the event: label `bug` runs `fix-bug`, label `feature` runs `spec-then-build`, a red `main` runs `ci-doctor`.
- There is no step engine on the server. Steps run inside the Session, where they can adapt when the work doesn't fit.
- If a factory becomes something people install and share, a bundle of routines, workflows and agent files with a page of its own, a `factories` plugin can package it. That waits until routines and workflows have been used.

### Starters

The plugin ships routines to copy and fill in:

- **Issue to pull request**: an issue labelled for Pipoca gets a Session that implements it and opens a pull request.
- **CI doctor**: `main` goes red, and a Session finds the cause and opens a fix or an issue.
- **Code health**: on a schedule, one small cleanup pull request.
- **Triage**: a new issue gets labels and a check for duplicates.

### Guards

- A run ends with an explicit complete or block. A run that just stops is shown as such.
- A run whose work is a pull request is done when the pull request's required checks pass at its head.
- A key with an open pull request doesn't start another run.
- Each routine has a cap on runs at once and on daily spend, and pauses after repeated failures ([ADR 0059](0059-routines-and-wake-ups.md#runs)).
- Issue and comment text is written by anyone who can reach the repository. Triggers fire only on labels and commands from repository members, and event-started runs get fewer tools than Sessions the person starts. Writes applied outside the agent, as GitHub's "safe outputs" are, can follow if that isn't enough.

## Consequences

- A factory is set up from a starter in minutes, and each kind of work can follow its own steps.
- Nothing new is built for the factory beyond the guards and starters. It depends on routines, workflows, pull request watching and technical users.
- There is no planning step that notices two issues touching the same code. Big work that needs splitting goes through a Project, as now.
- Run ends, required checks and the open pull request rule are new work in the routines plugin.
