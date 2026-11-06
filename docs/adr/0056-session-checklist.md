# 0056: A checklist in every Session

- Status: accepted; the `composer` slot is `session.composer` since [ADR 0069](0069-plugin-sdk-v2.md)
- Date: 2026-11-02

## Context

When an agent works through several steps, the person watching from a browser or a phone sees a stream of tool calls and can't tell how far along it is. Claude Code shows a checklist the agent keeps: each step pending, in progress or done, with the step in progress as the status text.

Claude Code has had two designs for it:

- `TodoWrite`, one tool that rewrites the whole list on every call, kept in memory for the session. Claude's project threads still show their progress this way, as a list with each line marked done, in progress or not started.
- Since January 2026, four tools, `TaskCreate`, `TaskGet`, `TaskList` and `TaskUpdate`, with ids, owners, dependencies and files on disk under `~/.claude/tasks/`, so several sessions can share one list. Agent teams use the shared list: a lead writes tasks and teammate sessions claim them by owner.

A task never starts work in either design. Subagents and parallel runs come from the Agent tool. Claude Code now leaves the task tools out by default on its newest models, because their definitions and reminders cost context and the model tracks its steps without them. It keeps them in cloud and background sessions, where the person watches from somewhere else. That is how Pipoca is used.

Pi has no checklist. Its `todo.ts` example keeps the list in each tool result's details and rebuilds it from the current branch when a Session starts or moves in its tree, so forks and replays show the right list with no storage of their own.

## Decision

### A built-in `checklist` plugin

- A built-in `checklist` plugin, on by default, gives every Session an `update_checklist` tool (decided 2026-11-02). Projects threads get it like any other Session. So does the Projects coordinator for now: leaving it out needs a way to load a plugin in some of a plugin's Sessions and not others, and a coordinator that hands steps to threads rarely calls it (amended 2026-11-02).
- The tool replaces the whole list, as `TodoWrite` and Claude's project threads do (decided 2026-11-02). Its input is a list of items, each with its text and a status of `pending`, `in_progress` or `completed`. A whole list each time leaves no ids to go stale and nothing to merge. The cost is resending the list, which stays short.
- The tool's description says when to use it: work with three or more steps, one item in progress at a time, an item done only when it is. There are no reminder messages nudging the agent to use it.
- The list lives in the tool's result details, as in Pi's `todo.ts`. The latest call on the Session's branch is the list. Reloads, replays and forks show the right one, and the plugin stores nothing.
- A user's own extension that registers `update_checklist` replaces the built-in one, as with subagents ([ADR 0030](0030-subagents.md)). A Session part can now mark its extension `replaceable`, as Pi's own built-ins are. The plugin is turned off for the whole installation like any other plugin.

### On the Session page

- The list is pinned above the composer while it has an item that isn't done. Collapsed, it shows the item in progress and a count such as "3 of 5". Expanded, it shows every item with its mark.
- A new `composer` slot on `WebPlugin` draws a plugin's part above the composer, with the Session's events. The checklist is its first user.
- `update_checklist` calls don't show as steps in the work block. The plugin claims the tool through the `tool.<name>` slot and draws nothing there, so the pinned list is the one place the checklist shows.

### Not now

- A shared task list per Project, with owners and dependencies that threads claim, as in Claude Code's agent teams. Project threads already are owned units of work with a state, and a list on the server wouldn't follow a Session's branches and forks. It comes back if a real need shows up.
- Tasks that start subagents or threads. That is orchestration, which Projects and pi-subagents already do.

## Consequences

- Every Session carries one more tool definition, a few hundred tokens.
- A weaker model may keep a checklist for asks too small to need one. Nothing stops it beyond the tool's description.
- The kernel gains the `composer` web slot.
- Turning the checklist off for one Profile, instead of the whole installation, needs a way for a Profile to turn off a built-in plugin's tools, which doesn't exist yet.
- Project thread cards don't show their thread's checklist yet. They can later, from the same transcript.
