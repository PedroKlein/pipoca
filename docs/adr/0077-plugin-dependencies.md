# 0077: Plugin dependencies

- Status: accepted
- Date: 2026-11-08
- Amends: [ADR 0022](0022-plugin-model-v2.md), [ADR 0069](0069-plugin-sdk-v2.md)

## Context

Admins can turn built-in plugins on and off, and several plugins lean on others. The SDK already has a way to say so. `definePlugin` takes `requires`, a list of plugin ids, and the host:

- loads a plugin after the plugins it requires;
- fails a plugin at start while one it requires is off or failed;
- won't turn a plugin off while a plugin that is on requires it ("Routines needs it, so it stays on");
- won't turn a plugin on while one it requires is off.

It came with the clean rebuild ([ADR 0068](0068-clean-rebuild.md)) without an ADR, and no built-in plugin declares it. The links between built-in plugins today are almost all soft:

- `usage` listens for `logins.model_called` to price model calls, and `push` listens for `usage.budget_warned`. Listening to another plugin's event already counts as an optional link: while that plugin is off, nothing is heard.
- `routines` names `git-hosts` events in triggers and starters, and its runs can act as a `git-hosts` technical user ([ADR 0060](0060-technical-users-and-github-apps.md)). Schedules, webhooks and plain runs work without `git-hosts`.
- Shared team keys and usage in money go through the `logins` key proxy ([ADR 0066](0066-team-credentials-and-usage.md)).
- Runners, sign-in, model lists and git credentials are provided to the kernel (`provide.*`). They are slots the kernel fills, not links between plugins.

[ADR 0075](0075-routines-groups-coordinators-and-agents.md) adds the first hard link: a routine's step names an agent or a workflow, and both come from `subagents`.

Blocking a switch until the person finds and turns off every plugin that needs it gets tedious once links chain. A link nobody can see also leaves the person guessing why a routine stopped firing.

## Decision

### Two kinds of link

- **Requires**: the plugin can't run without the other. It stays `requires` in `definePlugin`, and is used sparingly. A plugin declares it only when most of what it does breaks without the other.
- **Works with**: the plugin uses the other when it is on and gets by without it. Nothing declares it. The host infers it while the plugin runs, the way it infers what a plugin uses from its context ([ADR 0069](0069-plugin-sdk-v2.md)): listening to another plugin's event, by its definition or by name, and starting a Session that acts as another plugin's technical user. A works-with link never locks or turns anything off.

Kernel slots stay outside both. A plugin that provides runners or sign-in is not linked to the plugins that use runners or sign-in.

### Turning plugins off and on

- Turning off a plugin that others require turns them off too, after a confirm that lists every plugin going off, including plugins that require those in turn. It says their data stays. This replaces today's lock.
- Turning on a plugin turns on what it requires, after a confirm that lists them. An installed plugin in that list gets its own consent, as turning it on alone would ([ADR 0022](0022-plugin-model-v2.md#installing-third-party-plugins)).
- The same holds for a plugin's team switch ([ADR 0067](0067-team-plugins-projects-and-assistant.md)): a plugin on in team work needs what it requires to be on in team work too.
- A plugin that requires one that isn't installed stays off, and its card says which plugin to install.
- A deploy file that sets every switch still locks them all ([ADR 0063](0063-settings-and-first-run-setup.md)). A plugin whose requirement that file leaves off fails at start, as today.
- Switches still take effect at the next restart.

### The Plugins page shows the links

Each plugin's card lists:

- **Needs**: the plugins it requires;
- **Needed by**: the plugins that require it and are on;
- **Works with**: the plugins it uses when they are on, with what it heard from them or used them for, such as "Listens to Git hosts events".

### First declared link

- `routines` requires `subagents` once the ADR 0075 build gives routine steps agents and workflows. Until then it declares nothing.
- Turning `subagents` off then turns `routines` off too, wake-ups included, and the confirm says so.

## Consequences

- An admin can turn off a plugin in one step and sees what goes with it before it happens.
- Works-with links come for free: a plugin author writes nothing, and a link appears once the code uses the other plugin. A plugin that has never listened to an event yet shows no link for it.
- `routines` listens to events by name as people write triggers, so its works-with links follow the routines that exist.
- `requires` stays rare, so most plugins can still be turned off alone.
- Losing wake-ups with `subagents` off is accepted, since `subagents` is on by default and rarely turned off.
- The plugin list in the API gains each plugin's links, and turning a plugin on or off answers with the plugins it would also change, so the page can ask first.
