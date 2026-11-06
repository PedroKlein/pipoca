# Pipoca concepts

The words Pipoca uses, what each one means in the code today, and where it is decided. The [guide](guide.md) says how to use each part, and [architecture.md](architecture.md) how they fit together.

## The installation

### Server

The one `pipoca server` process. It serves the web app, the API under `/api`, the runner API under `/runner` and MCP at `/api/mcp`, and keeps runtime data in one SQLite database (`~/.pipoca/server.db` by default) and config in `pipoca.json` ([ADR 0068](adr/0068-clean-rebuild.md)). One server is one team ([ADR 0064](adr/0064-one-team-per-server.md)). A solo install is a server for one person, started with `pipoca up` or `--solo` ([ADR 0053](adr/0053-ways-to-run-pipoca.md)).

Older ADRs call the server the Control Plane, and one installation a Cell. Both mean the server.

### Kernel and plugins

The kernel is what every server has: people and sign-in with a password, Sessions and their transcripts, Environments and runners, Profiles, Workspaces, terminals, change events, the route table, the plugin host and the web shell. Everything else is a plugin, the built-in ones included ([ADR 0015](adr/0015-plugins.md)).

A plugin is one `definePlugin` in `plugin.ts`, with up to three parts: `server`, `session` (a Pi extension) and `web` ([ADR 0069](adr/0069-plugin-sdk-v2.md)). No plugin is special: an admin can turn any of them off, and the kernel never names a plugin. What the kernel needs from plugins, such as runners started on demand or a sign-in provider, comes through `ctx.provide`, and the UI says what is missing when no plugin provides it. [plugins.md](plugins.md) shows how to write one.

### Config, data and secrets

- `pipoca.json`, in the config folder (`~/.pipoca/config/` by default), holds what people set ahead of time: server options, plugin switches, each plugin's typed config, templates ([ADR 0039](adr/0039-plugin-config-files.md)). Settings edits it, and so can you.
- SQLite holds what the server makes while it runs: people, Sessions, Environments, logins, plugin tables. The kernel and each plugin declare their schema, and the server upgrades it in place with their migrations ([ADR 0070](adr/0070-schema-migrations.md)).
- Folders in the config folder hold Profiles and routines.
- A secret is sealed with the server's key (`{ "sealed": "…" }`) or names an environment variable (`{ "env": "NAME" }`).

### Owner

Who a record belongs to: one person or the team. TypeScript has one `Owner` type, `"person:<id>"` or `"team"`, and SQL stores `owner_user_id`, with NULL for the team. A Session also has the plugin that keeps it (`owner`, such as a Project), the person who started it (`startedBy`) and who its git acts as (`actsAs`).

An actor records who did something: `user:<id>`, `session:<id>` or `plugin:<id>`.

## Where Sessions run

### Environment

One person's or the team's settings for running Sessions (isolation, image, setup script, variables, secrets) plus a pool of runners ([ADR 0032](adr/0032-environments-and-runners.md), [ADR 0049](adr/0049-personal-environments-and-templates.md)). Its kind (machine, Docker or Kubernetes) follows from its isolation and from the plugin that starts its runners. An Environment has no revisions: a Session gets its current settings each time it starts.

### Environment selection

A new Session runs in the Environment it names, as a Project's Sessions name the Project's. Otherwise it runs in the person's default Environment, or else in their first one. Team work picks only among the team's Environments.

### Template

An admin's shared Environment settings, without secrets or runners. People make Environments from it. A Kubernetes template also holds pod settings.

### Runner

A `pipoca agent` process in an Environment's pool. It polls the server, runs each Session in its own process and keeps the Session's Workspace. The server can run one itself (`--provider <name>`), and a plugin can start runners on demand through `provide.runners`: `local` on the server's machine and `kubernetes` as pods. Older ADRs and some code say provider or Provider Agent for a runner.

### Workspace

The files a Session owns on its runner: a worktree of a folder, the folder itself when shared, a fresh clone, or several repositories side by side ([ADR 0007](adr/0007-session-workspaces.md)).

### Repository

A git repository, by its clone URL. A repository can carry a `pipoca.json` manifest at its root that lists Profiles and templates to import ([ADR 0063](adr/0063-settings-and-first-run-setup.md#repositories-carry-a-manifest)). That file has the same name as the server's config file but is a different thing.

## Sessions

### Session

One full Pi conversation with its own transcript, Workspace, Profile and Environment, fixed when it starts ([ADR 0014](adr/0014-concept-map-and-environments.md)). Its Pi JSONL transcript is copied to the server, which replays it to any browser.

Each run of a Session on a runner has a generation. A newer generation fences off writes from an older one, so two runners never run one Session.

### Profile

A Pi agent folder, like `~/.pi/agent`, in the config folder at `profiles/<id>/`: packages, instructions, skills, prompts, MCP servers and settings, with no credentials ([ADR 0041](adr/0041-profiles-as-folders.md)). It belongs to a person or the team, or is shared. Under every Profile load the admin's base Profile and then the person's My defaults; a Profile can also build on another ([ADR 0063](adr/0063-settings-and-first-run-setup.md#profiles-in-layers)).

### Login

A model provider or MCP sign-in, kept sealed on the server on a Profile layer ([ADR 0045](adr/0045-server-kept-logins.md)). Settings calls them Accounts.

### Project

A Project is one goal: a coordinator Session, thread Sessions for each piece of work, instructions, memory, a file library and repositories ([ADR 0016](adr/0016-projects.md), [ADR 0028](adr/0028-projects-around-the-coordinator.md)). Threads and the coordinator show only inside their Project.

### Assistant

Each person's own Project with no repositories, which the home screen talks to ([ADR 0052](adr/0052-the-assistant-as-a-project.md)). It is part of the `projects` plugin. Older docs call its conversations meta-sessions.

### Team work

Work the team owns: team Sessions, Profiles, Environments, Projects and routines, with the team hub as its own area ([ADR 0064](adr/0064-one-team-per-server.md), [ADR 0065](adr/0065-team-hub-and-team-conversations.md)). In a team Session a person writes To Pi, To the team or Off the record.

### Subagents, routines and wake-ups

A subagent is a child Pi session inside a Session, and a run is one call's work ([ADR 0057](adr/0057-pipocas-own-subagents.md)). A routine is a person's or the team's JSON file that runs a prompt on a schedule, an event or a webhook, and a wake-up is a one-time routine for the Session that set it ([ADR 0059](adr/0059-routines-and-wake-ups.md)). A routine's run is a different thing from a subagent run.
