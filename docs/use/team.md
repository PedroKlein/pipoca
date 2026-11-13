---
title: Team work
description: The team hub, team Sessions where people and Pi share one conversation, and moving work between you and the team.
sidebar:
  order: 9
---

On a [team server](../run/team.md), each person has their own work, which nobody else reads, and the team has work of its own ([ADR 0064](../adr/0064-one-team-per-server.md), [ADR 0065](../adr/0065-team-hub-and-team-conversations.md), [ADR 0067](../adr/0067-team-plugins-projects-and-assistant.md)). Team Sessions, Projects and routines belong to the team, run on the team's Profiles and Environments, and use the team's model keys.

## The team hub

Team work has its own area, the team hub, apart from your own Sessions, Projects and Settings. **My work** goes back to yours. Its home shows what needs someone, what is running now, and panels that plugins add, such as recent activity, spend this month, the team's pull requests and its routines.

Admins lay the hub out without code: they add pages and pick the panels on each, and the layouts live in `pipoca.json` under `hub` ([ADR 0067](../adr/0067-team-plugins-projects-and-assistant.md#teams-shape-their-hub)). A plugin can also add whole pages to the hub. **Team setup** has the team's Profiles, Environments, the plugins on in team work, and the server's pages.

## Start team work

In New session, **Whose work** picks the team. Pick a team Profile, or leave it to the team's default, which an admin picks in Team setup; a person's My defaults, personal Profiles and personal logins never load in team work. Anyone on the team can start team Sessions, Projects and routines.

## Who sees and steers it

Every person on the team can see and steer team work by default. Whoever started it, or an admin, picks who steers it from **Who steers** in its menu:

- **Everyone steers**, the default.
- **View only**: everyone else can read it but not write to it.
- **Named people**: only the people named can steer it.

## People and Pi in one conversation

The composer in a team Session has three targets:

- **To Pi** sends the message to Pi, as in any Session.
- **To the team** is for people. Pi doesn't answer it, but reads it the next time someone sends To Pi.
- **Off the record** is seen by the team and never by Pi, now or in a summary.

Typing `@pipoca` in a message switches it to To Pi. The composer always shows the current target. When a message goes To Pi, Pi reads the team messages since its last turn, up to `team.messagesRead` (40 by default). Every message reaches Pi with its author's name.

A reply quotes the message it answers, in one flat timeline, and Pi sees what each reply answers.

### Questions and votes

Pi addresses each question to a named person, such as whoever started the work or asked for that part of it. Anyone who can steer may answer instead, and the answer shows who it was answered for. If nobody answers within `push.answerMinutes` (10 by default), whoever started the work is told too.

Anyone can open a vote: Pi when the team should decide, or a person about something being discussed. A vote card shows who picked what. The person who opened it or the Session's starter closes it, or it closes on a timeout, `ask.voteMinutes`. The result is posted as a team message, so Pi reads it the next time it's asked.

## Moving work between you and the team

- **Move to the team**, in a personal Session's menu, hands the work over with a summary, not the transcript. Pi writes a handoff summary, you edit it, and a team Session starts from it with a fresh workspace on team credentials. Your transcript stays private.
- **Fork to my own work**, in a team Session's menu, copies its transcript into a personal Session, which runs on your own Profile and logins.

## The team assistant

Every person has a **Team assistant** in the hub, apart from their own [assistant](assistant.md). Its chat belongs to you alone, and what it starts, such as Sessions, Projects and routines, belongs to the team. It runs on a team Profile and the team's keys, so its spend is team usage under your name. Its tools follow your role: everyone can start and look up team work, and admins can also change team setup and hub layouts and build and install plugins.

## Keys, usage and budgets

Team Sessions reach model providers through a proxy on the server, with a token for the Session; the runner never gets the key ([ADR 0066](../adr/0066-team-credentials-and-usage.md)). Each model call is recorded with who asked, the Session, the model, the tokens and the cost. Admins set a team budget and a monthly cap per person, which warn at 80% and 100% and never stop work. See [Models and logins](../admin/models-and-logins.md#team-keys-usage-and-budgets).

## Plugins in team work

A plugin says whether it works in personal work, team work or both. Admins choose which of the team-ready ones are on in team work, in Team setup's **Plugins in team work**. Built-in plugins start on there, installed ones off.
