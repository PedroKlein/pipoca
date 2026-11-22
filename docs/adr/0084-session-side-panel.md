# 0084: One side panel for plugins, and a calmer Session screen

- Status: accepted
- Date: 2026-11-22
- Amends: [ADR 0029](0029-extension-ui-on-the-web.md), [ADR 0078](0078-artifacts-and-session-files.md), [ADR 0081](0081-artifact-viewer-and-discussion.md)

## Context

Every plugin that fills `session.header` adds a control beside the Session's title: Files, Changes, a vote, usage, subagents. Under them sit the Environment, the workspace, the state and who can open the Session. On a narrow window the header wraps to two or three rows, and each new plugin makes it longer. In a Project, the coordinator's chat gets one row per thread update, so a busy thread fills the chat with "working", "finished a turn", "done".

Claude Code shows a Session with a one-line header, smaller type and more room for the chat. Files and changes open in a panel beside it.

Two ways were compared to make room: a side panel holding every plugin, and header icons with an overflow menu. The overflow menu still fills the header, and which plugins show depends on the window's width.

## Decision

### One side panel holds what plugins show about a Session

- `session.header` is replaced by `session.panel`. Its part draws a `SessionSection`: a name, an order, a label, an icon, an optional badge, a summary and an optional detail. That is the only way a plugin shows something beside a Session; nothing else goes in the header.
- A badge is short: a count, a dot, or a few characters such as `+48`. Its tone is plain, or "waiting" when the section needs the person, such as an open vote.
- Closed, the panel is a rail of icons on the right edge, each with its badge. A section with nothing to show draws nothing and has no icon.
- Open, the panel lists every section's summary in order. A section's title opens its detail in the panel, with a way back to the list. An icon on the rail opens the panel at that section: its detail when it has one, otherwise its summary.
- The panel stays open or closed per browser.
- On a small screen there is no rail. One header button opens the panel as a sheet over the chat, with a dot when a section needs the person.
- The kernel adds a Session section: where it runs, its workspace and branch, its state and who can open it. These leave the header.
- Today's plugins move in: Artifacts, Files and Changes become sections whose detail is their tab today ([ADR 0078](0078-artifacts-and-session-files.md)); the Files menu ([ADR 0081](0081-artifact-viewer-and-discussion.md)) becomes the Files section; open votes, running subagents and the Project folder get sections of their own.
- The artifact viewer still docks beside the chat; it is not a section.

### A slim header

The header is one row: the Session's title, its state, the view switch and the Session's menu. The state shows as a dot with its label, and as a badge only when it needs the person.

### Denser type

The chat's text is 14px instead of 15px and controls are 13px instead of 14px, across the app, so the reading column holds more and matches the rest of the page.

### Usage moves to the composer

How full the context is and the cost so far show as a small ring in the composer's control row, next to the model, like Claude Code's context meter. The usage plugin fills a `session.meter` slot there. It is the only plugin slot in that row; plugin controls stay behind the composer's attach menu.

### Notices about one thing fold into one row

A notice part may name what it is about, such as a thread. A run of notices of one kind about the same thing shows as one row with the latest on top and how many came before, which open on a click. A Project's coordinator shows each thread's updates this way.

## Consequences

- The header no longer grows with plugins, and any number of plugins fit in the panel, which scrolls.
- Reaching Files or Changes takes one click on the rail, as today, but on a small screen it takes two.
- Every plugin that filled `session.header` moves to `SessionSection`. There are no third-party plugins yet, so nothing else changes.
- A Project with a thread open beside its coordinator keeps one panel, for whichever pane was used last.
