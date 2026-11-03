# 0062: Slack and email

- Status: accepted
- Date: 2026-11-03

## Context

Some automations start from a message, not from a git host: a request in a Slack channel, an alert email, a mail from a customer. Others end in one: a weekly report to a channel, a summary by mail. Slack and email have been listed as plugin ideas since the start ([extensibility](../extensibility.md)), and Pipoca's own UI stays where people work with Sessions.

Routines start from any plugin event ([ADR 0059](0059-routines-and-wake-ups.md)), so a plugin that turns messages into events is enough to trigger them. Cursor and Factory both take Slack triggers and post to Slack, and Cursor sends a reply in a Slack thread on to the run that posted there ([research](../research.md#automations-and-software-factories)).

## Decision

### Two plugins

- A `slack` plugin and an `email` plugin, built after routines (decided 2026-11-03). Each adds triggers and a way to reply. Routines don't change for them.
- **Slack** connects with Socket Mode, so the server reaches out to Slack and needs no public URL. A message in a channel, a mention of the bot or a reaction becomes a `slack.*` event. A Session posts and replies in threads with the plugin's tool.
- **Email** reads a mailbox over IMAP, polling or waiting for new mail, and sends over SMTP. New mail matching a filter becomes an `email.*` event. A Session sends mail with the plugin's tool.
- Both declare their event types with their fields, so the routine editor can filter on channel, sender or subject.

### Bots and mailboxes are technical users

- A Slack bot and a mailbox are technical users, registered by an admin and chosen by name, like GitHub bots ([ADR 0060](0060-technical-users-and-github-apps.md)). Their tokens and passwords stay on the server.

### Replies continue the run

- A reply in the Slack thread or mail thread a run posted to goes to that run's Session as a message, keyed like any routine run. A Slack thread then works as a chat with the Session.

### Reports don't need either plugin

- A report on its own, such as "post a summary to #team every Monday", is a scheduled routine whose Profile has a Slack or mail MCP server. The plugins are for triggers, threads and bots the server holds.

### Untrusted input

- Messages and mail come from anyone who can reach the channel or the mailbox. Triggers filter by sender and channel, and the runs they start get fewer tools than Sessions the person starts.

## Consequences

- People can start work from Slack or mail and get results there, without a public URL.
- Two more plugins hold long-lived credentials, a Slack bot token and a mailbox password.
- Sinks that deliver a run's result without the agent posting it ([ADR 0059](0059-routines-and-wake-ups.md#other-plugins-extend-routines)) are likely to be needed first by these plugins.
