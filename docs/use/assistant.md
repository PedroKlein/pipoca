---
title: The assistant
description: Ask the Pipoca assistant to start work and set things up, from the home screen or any MCP client.
sidebar:
  order: 4
---

The home screen and the sidebar's **Assistant** entry ask the Pipoca assistant (part of the `projects` plugin, [ADR 0052](../adr/0052-the-assistant-as-a-project.md)). Ask it to start a Session, set up a Project, an Environment or a Profile, find a Session you ran last week, or write a plugin.

## How it works

Each person has one assistant: a [Project](projects.md) of their own with no repositories, which stays out of the Project list. The first question makes it, and every later one goes to the same conversation.

- Its coordinator runs on the plugin's own Profile, with Pi's `read`, `grep`, `find` and `ls` but no shell or file writes, and does one-shot actions itself.
- Its tools manage Sessions, Environments, Profiles and Projects through the same routes as the web UI.
- For work you'll iterate on, such as building a Profile or a plugin, it starts a thread with all of Pi's tools in an empty workspace of its own. The thread builds the Profile or plugin as a folder in its workspace, then installs it with `install_profile` or `install_plugin`.
- It never sees secret values, runner keys or what a Profile's MCP servers hold.

When it starts or opens something, a wide screen goes there, a phone shows a notice with an **Open** button, and the chat keeps a card for it. When the assistant starts fresh, its earlier conversations stay listed behind **Earlier conversations** on the home screen and under the Assistant entry. **Start a session yourself** opens the New session form.

## What asks first

Before a tool call that changes something you'd want to check, such as changing an Environment or installing a plugin, the assistant shows a card with what the call changes and waits for you to allow it, once or for the rest of the Session ([ADR 0050](../adr/0050-assistant-permission-prompts.md)). Other tools run without asking.

Installing always asks, whether it makes a new Profile, writes into an existing one or installs a plugin. Only admins install plugins, and none of a plugin's code runs: it is built, and turning it on stays yours, on the Plugins page.

On a team server, each person also has a **Team assistant** in the team hub. See [Team work](team.md#the-team-assistant).

## MCP clients

The same tools are served over MCP at `/api/mcp`, so Pi or another MCP client on your laptop can manage Pipoca too. Make a token under Settings > Access tokens; it is shown once, with the command that adds the server, such as:

```sh
claude mcp add --transport http pipoca https://pipoca.example/api/mcp --header "Authorization: Bearer pcm_..."
```

A client acts as the user who made its token, and asking before risky tools is up to the client. Revoking the token cuts it off at once. The endpoint answers each request with one JSON reply and opens no event stream.
