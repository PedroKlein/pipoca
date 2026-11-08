---
title: Slack and email
description: Start routines from Slack messages and mail, and let Sessions post and reply there.
sidebar:
  order: 10
---

The `slack` and `email` plugins turn messages into [routine](routines.md) triggers, and let Sessions write back ([ADR 0062](../adr/0062-slack-and-email.md)). Admins add bots and mailboxes in Settings > Integrations.

## Slack

An admin opens **Create the Slack app** in Settings > Integrations > Slack, which fills in the app's scopes, events and Socket Mode. They install it to the workspace, make an app-level token with `connections:write`, and add the bot with its name, bot token and app-level token. The server connects to Slack over Socket Mode, so Slack needs no address of the server, and keeps both tokens sealed in `pipoca.json` under `slack.bots`.

- The bot's events go to the routines of the admin who added it: `slack.mention`, `slack.message` (in channels the bot is in, or sent to it directly) and `slack.reaction`, each with its `channel`, `user` and `ts`. A routine can have a condition on a channel and key on `["channel", "ts"]`.
- A Session of that person gets `slack_post` to post to a channel or reply in a thread.
- Replies people write in a thread the Session posted to come back to that Session as messages.
- A routine's results can go to a channel with the `slack.channel` destination, and a run that proposes can post with the `slack.post` action.

## Email

An admin adds a mailbox in Settings > Integrations > Email with its address, login, IMAP server and SMTP server. The server tries both logins before it saves the mailbox, and keeps the password sealed in `pipoca.json` under `email.mailboxes`.

- The server checks each mailbox's inbox over IMAP every `pollSeconds` (60 by default). The first check only notes where the inbox is, so mail from before doesn't start runs.
- New mail goes to the routines of the admin who added the mailbox as `email.received`, with its `mailbox`, `from`, `subject`, `messageId`, `inReplyTo` and up to 8000 characters of its plain text. A routine can have a condition on a mailbox and key on `["messageId"]`.
- A Session of that person gets `email_send` to send mail or reply to one by its Message-ID.
- Replies to mail the Session sent come back to that Session as messages instead of starting runs.
- A routine's results can go out with the `email.mail` destination, and a run that proposes can send with the `email.send` action.
