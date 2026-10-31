# 0051: Pull request watching and auto-fix

- Status: accepted
- Date: 2026-10-31

## Context

A Session opens a pull request with `/pr` ([ADR 0021](0021-pull-requests.md)), and the Changes card shows a link to it. After that nobody watches it. CI goes red, a reviewer asks for a change, or `main` moves and the branch conflicts, and the Session that wrote the change doesn't hear about it. An idle Session can't watch anything itself.

Claude Code's auto-fix ([docs](https://code.claude.com/docs/en/claude-code-on-the-web#auto-fix-pull-requests)) does this for its cloud sessions:

- Auto-fix is a per-PR switch in the menu of the PR's row on the session's Changes card. Asking the session to watch a PR, or `/autofix-pr`, turns it on too.
- The Claude GitHub App's webhooks bring CI failures and review comments to the server, which hands each one to the session as a new turn once any running turn ends. The session holds nothing open between events, so it stays free to talk.
- On each event the session fixes and pushes when the fix is clear, asks the user when a request is ambiguous or architectural, and notes a duplicate or no-op event and moves on.
- It replies on review threads under the user's account, labeled as Claude Code. GitHub sends no webhook for merge conflicts, so it doesn't notice them.

Pipoca already knows each person's git hosts and tokens ([ADR 0043](0043-git-hosts.md)), and `sessions.send` starts a turn or queues a follow-up while the Session is busy.

## Decision

### Polling with the person's token

- The `git-hosts` server polls each watched pull request with the token of the person who started the Session (decided 2026-10-31). This works on GitHub Enterprise hosts with no app or webhook, and it notices merge conflicts, which webhooks don't announce.
- A watched pull request is polled about once a minute (the plugin's `pollSeconds` setting), with ETags so an unchanged answer costs little of the host's rate limit. Each poll reads the pull request (state, head commit, mergeable), the check runs and statuses of its head, and reviews and review comments newer than the last ones seen.
- Webhooks come later as an optional speed-up where an admin sets them up, and so does a Pipoca GitHub App that people install (decided 2026-10-31).

### The Session that opened it hears its news

- A watched pull request belongs to one Session: the one that opened it, or the one where the person asked to watch it (decided 2026-10-31).
- The plugin keeps watched pull requests in its SQLite store: the Session, the person, the host, the repository and number, whether auto-fix is on, and the state it last saw.
- A Session starts watching a pull request in two ways. The `git-hosts` Session part reads the `branch.<name>.pipocaPullRequest` key that `/pr` writes in each checkout after every turn and registers new ones. The `git_hosts_watch` tool takes a pull request URL, for a pull request opened some other way. `git_hosts_unwatch` stops it.
- Watching stops when the pull request merges or closes, or when the Session is archived.

### What a Session does with news

- With auto-fix on, each change becomes a message to the Session through `sessions.send`: checks that failed, with their names and links; new reviews and review comments from other people; a merge conflict appearing; the pull request merging or closing. Changes found in one poll go in one message.
- The first message carries the rules, as Claude Code's first event does. They follow Claude Code (decided 2026-10-31). Make a fix that is clear, push it to the pull request's branch and say what changed. Ask the person before acting on a request that is ambiguous or architectural. Note a duplicate or no-op event and move on. Never skip or disable a test to get green.
- When the Session's host is offline, the message waits and the next poll tries again, merged with anything new.
- With auto-fix off, the plugin still polls so the card stays current, but it sends no messages.

### The person chooses

Each person sets these in their Git hosts settings (decided 2026-10-31):

- **Auto-fix new pull requests**, on by default. A pull request a Session opens starts with auto-fix on. The pull request's own menu turns it off or on for that one.
- **Reply on review threads as me**, off by default. With it off, the rules tell the Session to push fixes and report in the chat, and never to comment on GitHub as the person. With it on, the Session may answer the threads it handled, and each reply ends with a "via Pipoca" line that names no model or AI vendor. A Pipoca GitHub App, later, can reply as itself instead.

### On the Session page

- The pull request's row on the Changes card shows its checks, its review state and whether it conflicts, from a new `WebPlugin.pullRequest` slot that the `git-hosts` web part fills (decided 2026-10-31). The row's menu has Auto-fix and Merge. Merge uses the first method the repository allows, in the order squash, merge and rebase.
- Each message the plugin sends shows in the chat as a notice drawn by the plugin, not as text the person wrote.

## Consequences

- `git-hosts` gains a Session part, a poller on the server, two Session tools and a table, and the web gets a slot that the Changes card renders.
- Polling costs requests. Each poll of a watched pull request makes five requests, so about 300 an hour at the default minute, inside GitHub's 5,000 an hour per token, though a person with a dozen open pull requests will feel it. Admins can poll less often with the plugin's `pollSeconds` setting, and webhooks are the fix when that matters.
- News reaches a Session up to a minute late.
- A Session can push to the pull request's branch on its own while auto-fix is on, as Claude Code's does. Commenting as the person is opt-in.
