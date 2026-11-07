# 0074: Profile layers you can see and turn off

- Status: accepted
- Date: 2026-11-07

## Context

A Session's Pi agent folder is built from layers: the server's base ([ADR 0044](0044-base-profile.md)), the person's My defaults, the Profiles a Profile builds on, and the Profile itself ([ADR 0063](0063-settings-and-first-run-setup.md)). Team Sessions use the base and team Profiles only ([ADR 0064](0064-one-team-per-server.md)).

The base and My defaults are full Pi agent folders, but Settings treats them as less:

- A layer's page is a form for its packages. Its skills, prompts, instructions and MCP servers are reachable only as files, so an admin can't see how to give everyone a skill.
- A Profile's page shows the skills it inherits, but not the instructions, packages, MCP servers or settings. Nobody can tell what Pi will get without reading every layer.
- A Profile can't turn off anything it inherits.

The merge also differs from ADR 0044 in three places. A Profile's `APPEND_SYSTEM.md` replaces the base's instead of adding to it. A Profile's `models.json` replaces the whole file below it. Arrays in `settings.json`, such as the `skills` list Pi reads, replace the one below instead of adding to it.

## Decision

### Every layer gets the Profile editor

- The base and My defaults use the same page as a Profile, with every section and tab (decided 2026-11-07). The base's page says it sits under every Session on the server, and only admins change it. Everyone else sees it read-only.
- The base holds no subscription sign-ins, only shared API keys, as ADR 0063 already says.

### What wins

Items from every layer add up, and the nearer layer wins when two have the same name:

| Item | From every layer | Same name in two layers |
|---|---|---|
| Skills, prompts, extensions | All load | The nearer one replaces it |
| Packages | All install | The nearer entry replaces it, filters included |
| MCP servers | All connect | The nearer entry replaces it |
| `AGENTS.md` | Joined, the base first | — |
| `APPEND_SYSTEM.md` | Joined, the base first | — |
| `SYSTEM.md` | Only the nearest one | The nearer one wins |
| Other `settings.json` keys | Merged key by key | The nearer value wins |
| `models.json` | Merged by provider | The nearer provider replaces it |
| Logins | Inherited ([ADR 0063](0063-settings-and-first-run-setup.md)) | An own login replaces it |
| Other files, such as themes | All copied | The nearer file wins |

This changes `APPEND_SYSTEM.md` and `models.json`. Pi's resource lists in `settings.json` (`skills`, `extensions`, `prompts`, `themes`) add up across layers, as Pi adds up its global and project lists.

### Turning off what a Profile inherits

- A Profile, or My defaults, can turn off any item it inherits for itself only: a skill, prompt, extension, package, MCP server or custom model provider, or one layer's `AGENTS.md` or `APPEND_SYSTEM.md` text (decided 2026-11-07).
- The layer keeps the items it turned off in an `off` list in its `profile.json`. The server leaves them out when it layers the files for a runner, so a package that is off isn't installed. The layer's hash covers the list.
- To change an inherited item, a person copies it into the Profile, and the copy replaces it by the rules above. A copy doesn't follow later changes to the original. The Profile's page says when the original changed after the copy was made.
- Settings such as the default model have no off switch. A Profile sets its own value, and removing it goes back to the inherited one.
- Admins can't lock an item on the base (decided 2026-11-07). Team Sessions already run only on team Profiles that admins manage, so a lock would only bind people's own personal Sessions.

### A Profile's page shows what Pi gets

- Each section lists everything the Session will get from every layer. Each item is labelled with the layer it comes from and shows whether it's on, off in this Profile, or replacing one from below. A switch next to "Only this Profile's own" narrows the page.
- An inherited item has a switch to turn it off and a menu to copy it into the Profile or to view it in its own layer.
- "Preview what Pi gets" shows the folder a runner would receive, read-only, with each file's source. It can be downloaded.

### Sharing an existing Profile

- A Profile is shared or someone's own from the moment it's made ([ADR 0041](0041-profiles-as-folders.md)). An admin can now switch an existing Profile between the two from its page (decided 2026-11-07).
- Sharing makes a Profile of the admin's own a shared one, which only admins change. It must build on nothing or on a shared Profile, since a shared Profile can't build on someone's own.
- Making a shared Profile the admin's own again is refused while someone else's Profile builds on it or someone else has it as their default, and the refusal says how many. Sessions that already started keep the files they got.
- People who aren't admins can't share, because a shared Profile is one only admins change.

## Consequences

- An admin gives everyone a skill, prompt, MCP server or instructions from the base's page, without editing files.
- People see why Pi has a skill and can turn it off without asking an admin.
- The server already builds the layered folder for runners. The preview reuses that, and the page needs each item's source next to it.
- A Profile that turns off a base item can drift from what the admin intended for personal Sessions. That is accepted; team work stays on admin-managed Profiles.
- Changing how `APPEND_SYSTEM.md`, `models.json` and the resource lists merge can change what an existing Profile gets. Existing Profiles that relied on replacing these files need their own entries turned off instead.
