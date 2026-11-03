# 0063: Settings and first-run setup

- Status: accepted
- Date: 2026-11-03

## Context

The Session and Project views work well, but configuring Pipoca doesn't. Settings is one flat list of thirteen sections, where personal options, server options and plugin pages sit side by side. Several sections still ask for raw values: a callback URL to copy, a token to paste, a JSON key to know about. A first run is a two-step checklist on the home screen ([ADR 0040](0040-fewer-forms.md)), and a person who joins a team server sees the same checklist as the admin who set the server up.

Mockups of every Settings page, a first-run setup, a team member's setup and the guided flows were reviewed on 2026-11-03. This ADR records what the review settled. Five questions were decided on their own, and the rest came from comments on the mockups.

## Decision

### Settings is one page, grouped by who it is for

- Settings opens as a full page with its own menu and a way back to the app. It has four groups:
  - **You**: General, Accounts, Notifications and Access tokens.
  - **Workspace**: Environments, Profiles and Models.
  - **Server**, shown only to admins: People, Sign-in, Git hosts, Integrations, Plugins and Configuration.
- Git hosts belongs to admins. An admin picks which hosts people can connect, and everyone else connects their own account in Accounts.
- Slack, Email and other plugins that start routines from outside share one Integrations page, with one tab per plugin. A plugin's settings page names the group it goes in.
- On a phone, the menu becomes a list that opens each page.

### Guided flows over raw values

- Each thing that needs several values from another system gets a short flow instead of a form. Connecting a machine waits live until the machine connects. Adding a model provider checks the key and lists the models it finds. MCP servers can be picked from a list. Slack is set up in three steps, sign-in starts from presets, and a git host's Connect button is set up with the callback filled in.
- A URL that has to be copied somewhere else only shows up inside the flow that needs it.

### Forms edit the files underneath

- Every form still writes the config files of [ADR 0039](0039-plugin-config-files.md). A form names the file it writes and offers **Edit as file**.
- An admin Configuration page lists the config folder's files, shows changes a form has made before they're saved, and shows fields written by Helm as read-only.

### A setup wizard, with a checklist for skipped steps

- A new server greets its first person with a full-screen setup: their account, where Pi works, a model provider, their code hosts and their Profile (decided 2026-11-03). Code hosts and Profile can be skipped.
- Any step that was skipped stays on the home screen as a small reminder until it's done. This replaces the first-run checklist of [ADR 0040](0040-fewer-forms.md).
- **Where Pi works** takes more than one answer: this computer, Docker on it, another machine or a Kubernetes cluster. Each becomes an Environment. A folder given for this computer means any folder inside it.
- **A model provider** includes custom providers, and every sign-in happens in the setup, with no Session needed.
- **Bringing an existing setup** lists what it found in `~/.pi/agent` or a repository, item by item, so the person can leave out any skill, package or MCP server before importing.
- In the desktop app, this computer connects with one click.

### Joining a team

- An invited person signs in, usually with the server's single sign-on, and gets a shorter version of the setup. It shows what the team already set up and only asks for what's theirs, such as their own git host account.
- Admins choose on People what new members get: an Environment template, the Profiles on offer, shared providers and which steps are required.
- A new member can pick several of the Profiles an admin made. Each one becomes a Profile of theirs.

### Profiles in layers

- Profiles layer in this order: the server's base Profile, then **My defaults**, then the Profile (decided 2026-11-03).
- The base Profile stays the admin's ([ADR 0044](0044-base-profile.md)). My defaults is one per person, edited by that person, and sits under every Profile of theirs.
- A Profile can build on another Profile and gets everything from it. The layers merge by the rules of [ADR 0044](0044-base-profile.md), with the nearer layer winning.
- Provider extensions are usually put in the base or in My defaults, so every model picker lists their providers.
- A Profile has a system prompt section, for `SYSTEM.md` or `APPEND_SYSTEM.md`.

### Logins on Profile layers

- Model provider logins and MCP logins belong to a Profile layer, not only to the person (decided 2026-11-03). This changes where [ADR 0045](0045-server-kept-logins.md) keeps them. The server keeps them, and they reach runners the same way.
- A Profile inherits each login from the layer below it, or signs in with its own account. A Work Profile and a Personal Profile can use different accounts with the same provider.
- Accounts lists each login with the layer it comes from and the Profiles that override it. A Profile's page has the same switch, Inherit or Own login, for each provider and MCP server.
- The model a new Session starts with comes from its Profile, since the Profile decides which providers exist.

### Environment kinds

- An Environment is a machine someone connects, a Docker image on such a machine, or pods on Kubernetes. The Environments page says which kind each one is.
- Setup scripts and images belong to the container kinds. On a connected machine, Sessions use what's installed there.
- A Kubernetes Environment has no machines to connect. It shows its image, size, idle timeout and running pods.
- Git and `gh` sign in to every host the Session's owner has connected, as they do today, so an Environment doesn't need a `GH_TOKEN` variable for that.

### One data folder per server on a machine

- A machine keeps separate data for each server it runs Sessions for (decided 2026-11-03). Its own standalone Pipoca keeps `~/.pipoca`. Running for another server uses `~/.pipoca/servers/<host>/`, with that server's folders, Profile cache and Sessions.

### Repositories carry a manifest

- A repository can hold a `pipoca.json` at its root that lists the Profiles, Environment templates and model aliases inside it, each pointing to a folder or file in the repository (decided 2026-11-03).
- Importing such a repository shows what the manifest lists, and the person picks what to bring. What they pick stays in sync when the repository changes.

## Consequences

- Settings gets simpler for people who aren't admins: four of their pages, plus the Workspace pages.
- Every guided flow is more UI to build and test than the form it replaces, and each still has to round-trip through its config file.
- Logins on Profile layers change the `logins` plugin's storage key from person to person and layer, and a Session resolves a login by walking its Profile's layers. Existing logins move to each person's My defaults.
- Profiles that build on Profiles need cycle checks, a depth limit and a hash that covers every layer.
- Runners for other servers move to a new folder, and a running agent needs to migrate or start fresh.
- The manifest is a new file format to document and validate.
