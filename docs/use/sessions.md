---
title: Sessions
description: Start a Session, talk to Pi while it works, and fork or archive it.
sidebar:
  order: 1
---

A Session is one full Pi conversation, with its own transcript, workspace, Profile and Environment, fixed when it starts ([ADR 0014](../adr/0014-concept-map-and-environments.md)). It runs Pi in its own process on a runner, and the server keeps a copy of its transcript, so any browser can open it and see the same thing.

## Start one

Open **New session**, type what Pi should do, pick a folder or paste a repository URL in the folder chip, and press Enter. The other chips pick the model and its reasoning level and, when you have more than one, the Environment and the Profile. On a team server, **Whose work** picks your own work or the team's ([Team work](team.md)). The composer remembers what you picked for next time. A repository on a [private host](../admin/private-hosts.md) starts only on an Environment that reaches it, and the Environment chip groups them by whether they reach it and picks one that does.

### Workspaces

The workspace follows from what you pick ([ADR 0040](../adr/0040-fewer-forms.md)):

- **A folder** gets its own Git worktree, on a branch named `pipoca/` plus the last 8 characters of the Session's id, stored under the runner's data folder. The folder chip lists the git checkouts the runner finds in the folders it shares, after the ones you used recently.
- **Share the folder**, ticked in the chip, runs in the folder itself. Sessions sharing a folder this way can step on each other's changes.
- **A repository URL** gets a fresh clone on the Session's branch.
- **Two or more URLs** check each repository out side by side in one workspace, all on the Session's branch: as a worktree of a checkout the runner has whose remote is that repository, or as a fresh clone when none is. The Changes panel then shows each repository on its own.

For a worktree or a clone, the **Start from** chip picks the branch, tag or commit the Session's branch starts at. Files listed in a `.worktreeinclude` at the checkout's root, such as `.env`, are copied into new worktrees if Git ignores them.

A runner only works in the folders it shares, and in folders inside them ([Environments and runners](../admin/environments.md)).

## Talk to Pi while it works

- **Enter** queues a message for when Pi finishes its turn. **Ctrl+Enter** (⌘Enter on a Mac) sends it now, so Pi reads it after its current step. A queued message can be taken back or sent now.
- On a phone, Enter starts a new line and the send button sends.
- Add files in the composer: Pi gets them in its `uploads/` folder, and Send waits until they're uploaded. See [Artifacts and files](artifacts-and-files.md).
- Pi's steps fold into one **Worked for** line that you can open.
- Pi can ask you questions in a form (the `ask` plugin), and the Session shows in **Needs you** until you answer.
- When Pi works through several steps, it keeps a checklist (the `checklist` plugin, [ADR 0056](../adr/0056-session-checklist.md)), pinned above the composer with the step in progress and how many are done. Click it to see every step. It goes away once every step is done.

Slash commands from Pi and from the Session's Profile work as in Pi, such as `/login`, `/mcp login` and a prompt template's `/name`.

## The header and the side panel

- The header shows the Session's token use and cost (the `usage` plugin).
- **Changes** opens the diff of what the Session changed (the `changes` plugin). See [Changes and pull requests](changes.md).
- The panel beside the Session has a tab for each plugin that fills one, such as **Artifacts**, **Files** and **Changes**, each also opened from its button in the header ([ADR 0078](../adr/0078-artifacts-and-session-files.md)).
- **Subagents** opens every subagent run of the Session. See [Subagents](subagents.md).

## Pi and Terminal

The **Pi** tab shows Pi's own terminal UI for the Session, so extensions that only work in a terminal work there too ([ADR 0027](../adr/0027-pi-tui-view.md)). **Terminal** opens a shell in the Session's folder, or in its container when the Environment runs Sessions in containers. Terminals survive reloads ([ADR 0026](../adr/0026-terminals-that-survive.md)).

## Come back later

To come back to something later, such as CI that is still running, Pi schedules a wake-up with `schedule_wakeup` (the `routines` plugin, [ADR 0059](../adr/0059-routines-and-wake-ups.md)) instead of sleeping. At that time the Session gets Pi's message as a new turn, shown as **Woke up** with its reason. A wake-up is 1 minute to 30 days ahead, a Session has at most 10 pending and 48 a day, and archiving the Session cancels them. Pending wake-ups are listed above the composer, where you can cancel one.

## Fork

**Fork**, in a Session's menu, works like Pi's `/fork`. Pick one of your messages, newest first, and a new Session starts that remembers the chat up to that message, with the message back in its composer to edit and send. Messages after it and other branches stay behind. **Fork the whole Session** copies the whole chat instead, like Pi's `/clone`. The fork works on its own branch from the forked Session's branch.

A fork can go to another Environment; the new machine gets only what the Session pushed. A clone Session's fork checks out its branch from the remote, so push that branch first; otherwise the fork fails with "Push the Session's branch first".

## Archive

**Archive** hides a Session from the list and stops it on its machine. Its transcript stays readable under **Show archived**, and **Unarchive** picks it up again.

Archiving a worktree or clone Session also deletes its workspace if Git says nothing would be lost: no uncommitted or untracked files, and every commit pushed. Otherwise the workspace is kept and the Session shows **unpushed work** until you delete it yourself; **Delete workspace** says why it was kept. A clean workspace comes back from its pushed branch when you unarchive.

## Docs inside every Session

Every Session gets the server's docs as files: Pipoca's, Pi's and each installed plugin's, in a folder named by `PIPOCA_DOCS` under the runner's data folder. Pi is told to read them before writing a Profile, plugin, skill or extension ([ADR 0052](../adr/0052-the-assistant-as-a-project.md)).
