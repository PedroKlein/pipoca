# 0067: Team plugins, Projects, routines and assistant

- Status: accepted, direction only (built with Team Sessions)
- Date: 2026-11-04

## Context

[ADR 0065](0065-team-hub-and-team-conversations.md) gave the team a hub of its own and said that plugins declare whether they work in personal work, team work or both. It left the plugin SDK, the hub's screens, and how work moves between a person and the team for later. Team routines were waiting on team features ([ADR 0059](0059-routines-and-wake-ups.md)), and each person's assistant is a Project of their own ([ADR 0052](0052-the-assistant-as-a-project.md)).

Today a plugin's server part gets `context.owner`, which is fixed to the one user v1 had. Plugins are installed per server, and only admins install them.

## Decision

### The plugin SDK knows about the team

- An owner is a person or the team, everywhere a plugin sees one: its callers, Sessions and `sessions.start`. This replaces the fixed `context.owner`. The SDK also gives plugins a check for whether a caller may see a given owner's records, to use on their own routes.
- A manifest says where the plugin works: `personal`, `team` or both. Without it, a plugin is personal only. Admins turn on team plugins in Team setup.
- A plugin can give the hub **panels**, which go in hub layouts, and whole hub **pages**, which are new screens.
- In a team Session, a Session part sees each message's author and target. Off-the-record messages never reach it ([ADR 0065](0065-team-hub-and-team-conversations.md#people-and-pi-share-one-conversation)). The `ask` plugin gets votes and questions addressed to a named person.
- A team plugin's Session part that needs a model or MCP login gets a proxy token, never the key ([ADR 0066](0066-team-credentials-and-usage.md)).

### Teams shape their hub

- Hub pages are layouts of the panels that plugins provide (decided 2026-11-04). Admins add pages and move panels on them without code, and layouts live in `pipoca.json` ([ADR 0039](0039-plugin-config-files.md)).
- A new kind of screen is a new plugin.
- Only admins install plugins or build them on the server (decided 2026-11-04). Anyone can write a plugin in a repository from their own Session, as they can today.

### Moving work between a person and the team

- Moving personal work to the team carries a handoff summary, not the transcript (decided 2026-11-04). Pi writes the summary, the person edits it, and the team Session starts from it with a fresh Workspace on team credentials. The personal transcript stays private.
- Forking team work to personal copies its transcript, since the person could already read it. The personal Session runs on the person's own Profile and logins.

### Team Projects

- A Project can belong to the team. Its coordinator and every thread belong to the team too, run on team Profiles and Environments, and follow ADR 0065's rules for who sees and steers them.

### Team routines

- Any user can create a team routine, as anyone can start team work ([ADR 0064](0064-one-team-per-server.md#team-work-is-open-to-the-team)). It runs on a team Profile and Environment and acts as a technical user that admins let the team use ([ADR 0060](0060-technical-users-and-github-apps.md#choosing-who-acts)).
- Team routines get no run cap beyond the ones routines already have. Budget warnings are the signal (decided 2026-11-04).

### Each person has a Team assistant

- Every person has a Team assistant in the hub, apart from their own assistant (decided 2026-11-04). It is the same kind of assistant Project as ADR 0052's, labelled as the team's and opened only from the hub.
- Its chat belongs to that person alone. What it starts, such as Sessions, Projects and routines, belongs to the team.
- It runs on a team Profile and the team's key through the proxy, so its spend is team usage under the person's name. Admins see its usage rows, never its messages, as with any personal record ([ADR 0049](0049-personal-environments-and-templates.md)).
- Its tools follow the person's role. Every user can start and look up team work. Admins can also change team setup, including creating team Profiles and Environments, change hub layouts, and build and install plugins in its workspace. Destructive calls still ask ([ADR 0050](0050-assistant-permission-prompts.md)).
- Its workspace is on a team runner, so it never sees the person's own logins or My defaults.

## Consequences

- A plugin written before this change keeps working, personal only, until its author declares team support.
- Plugin authors guard their own records with the SDK's check, and a route that skips it can show team records to the wrong person.
- Most hub changes need no code, and every new screen is still a plugin, so the kernel stays small.
- A person who moves work to the team loses whatever the summary leaves out.
- A team routine stuck in a loop keeps spending until someone acts on a warning.
- People have two assistants. The Team assistant is kept to the hub and labelled so the two aren't mixed up.
