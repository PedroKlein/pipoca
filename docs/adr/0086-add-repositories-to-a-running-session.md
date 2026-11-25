# 0086: Add repositories to a running Session

- Status: accepted
- Date: 2026-11-25
- Amends: [ADR 0040](0040-fewer-forms.md)

## Context

A Session's repositories are fixed when it starts. When work turns out to need another one, such as docs that live in a second repository, the only ways out were a new Session or a fork, and both leave the chat behind. Cloning it by hand doesn't help either: the Session's git logins only reach the repositories it started with, so a GitHub App's token for another installation never arrives.

## Decision

- A Session whose workspace is a clone or several repositories (or no folder, which is repositories with none) takes in another repository. A folder or a worktree on someone's machine doesn't.
- The repository joins the workspace's list on the Session's branch, in a folder named after it. A clone becomes the first of the workspace's repositories: its runner moves the clone into a folder of its own, uncommitted files and all, and the new one goes next to it. The Session's working directory stays the same folder.
- The Session then restarts with its chat. If Pi is in the middle of a turn, the restart waits for the turn to end. The new start clones the repository and gets git logins for the whole list, so a GitHub App's token covers the new repository's installation too. A server restart forgets a restart that was waiting; the repository is cloned at the Session's next start.
- Pi hears of it after the restart: as context when a person added it, as a new turn when Pi asked for it, so Pi goes on with the work.
- People add one from the Session panel's Repositories section, with the same picker as New session. `POST /api/sessions/:id/repositories` does the same.
- Pi adds one with `git_hosts_add_repository`, which asks the person first and ends Pi's turn. Plugins call `ctx.sessions.addRepository`.
- Removing a repository from a running Session is not part of this.

## Consequences

- A clone Session that took in a repository is a repositories Session from then on.
- Pi's earlier messages name paths in the old layout. Pi is told where the repository it was in moved to.
- The restart is the same as the Session menu's Restart, so a Session that gets a repository also gets everything else fresh, such as Profile changes.
