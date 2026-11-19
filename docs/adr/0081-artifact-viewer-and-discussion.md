# 0081: Artifact viewer and discussion

- Status: accepted
- Date: 2026-11-18
- Amends: [ADR 0078](0078-artifacts-and-session-files.md)

## Context

[ADR 0078](0078-artifacts-and-session-files.md) built artifacts and Session files. Using them showed four problems:

- A comment sent to Pi becomes a user message in the chat, with the artifact's id and the quoted text in it. Every comment is a bubble, and Pi answers in the chat instead of on the artifact.
- Each comment sent to Pi starts its own turn, so five comments make five versions. People want to leave several comments and hand them over at once.
- An artifact shows in three places that each work differently: a panel beside the Session, a page of its own and a card in the chat. Files have a fourth. They share little code.
- Anyone with Comment access can steer the Session that owns the artifact.

Artifacts are most useful in a team, where people discuss a design document, a spec or a plan together. Comments today are notes, not a conversation.

Claude Code was read again on 2026-11-18 ([research](../research.md#artifacts-and-files)). In a Code session an artifact opens as a modal over the conversation. A comment thread reaches the agent only when a writer sends it ("Send to Claude" or a mention). The agent is woken in the session that published the artifact, with its full context, reads the thread with a tool, replies in the thread as "Claude, via" the person who sent it, and resolves the threads it handled. Plain comments never wake it. When no session listens, a separate replier answers without the session's context, and users ask for that to go.

## Decision

### Comments reach Pi as a notice

- Sending a thread to Pi sends the owning Session a plugin notice of kind `artifact_comments` with `turn: true` (the slim row of [ADR 0028](0028-projects-around-the-coordinator.md)). The chat draws it as one row, such as "You sent 3 comment threads on Checkout latency". The row expands to show the comments and opens them in the viewer.
- The notice names the artifact and the threads, not their text. Pi reads the text with `read_artifact_comments`, which fences it as untrusted.
- Notices sent while Pi works are folded into one, delivered after the turn. A thread is deduplicated, so one thread never wakes Pi twice for the same reply.
- The Session that published the artifact gets it, in its own context. There is no fork and no separate replier. An archived Session can't be asked; people can still discuss.

### Sending to Pi

- A thread is sent to Pi with "Send to Pi" or by writing `@pi` in it. Once sent, later replies by people in it reach Pi until it's resolved.
- Comments that aren't sent stay drafts for Pi. "Send N to Pi" in the comment list hands every checked draft over in one notice, so Pi makes one version for the batch.
- Only people who can act in the Session send to Pi: its owner for personal work, the team for team work, the Project's people for Project work. People an artifact is shared with can comment and reply but not send.
- Pi acts only when the latest reply in a thread is a person's.

### Pi answers in the thread

- New tools: `reply_artifact_comment(thread, text)`, `resolve_artifact_comment(thread)` and, for Markdown, `suggest_artifact_edit(thread, find, replace)`.
- Pi replies and resolves only in threads sent to it ([ADR 0083](0083-pi-in-comment-threads.md) lets it answer any thread it can comment on). A reply shows as "Pi, via" the person who sent the thread. A second reply with nothing new after the last request is refused.
- A suggested edit shows in the thread as a change with Accept and Reject. Accept saves a new version under the person who accepted.
- `publish_artifact(path, id?, label?, base?)` takes a short label for the version, and refuses when `base` is older than the latest version, returning the newer one for Pi to merge.
- A person's own new version (an edit or an accepted suggestion) reaches the Session as a notice without a turn.

### One viewer

- One viewer component shows artifacts and files. A chat card, the gallery, a pin, a Files row, the Project folder and a link all open it as a modal over the page. Esc and Back close it; the URL keeps it open on reload.
- The header holds the title, a version menu, Comment, Share, open in a new tab, More and close. Download, copy links, compare, restore, edit, pin and delete live under More. Compare and edit open inside the viewer.
- A Dock button pins the viewer beside the chat instead, remembered per person, offered on windows at least 1100 px wide.
- `/a/<id>` renders the same viewer full window without the Pipoca shell. The artifact page and the side panel's Artifacts and Files tabs go; the Changes panel stays.
- A file opens in the same viewer with a lighter header: Download and Publish as artifact, no versions, comments or sharing. Arrow keys step through the Session's files.
- On a phone the viewer fills the screen and comments open as a bottom sheet.

### Comments

- In comment mode a person selects text or clicks an element, and the comment box opens there. Threads are listed beside the page and pinned on it.
- A comment has a kind: Comment, Question, Decision or Suggestion.
- A thread is a small chat: replies, reactions, `@` mentions of people and Pi, typing and presence, all over the web app's events stream.

### Design documents

- Any artifact can be marked a design doc, spec or plan: front matter in Markdown, a meta tag in HTML, or More, Mark as design doc.
- A design doc's viewer adds an outline with open threads per section, comments in the margin beside their paragraph, open questions rolled up from Question threads, a status (Draft, In review, Decided) and reviewers who approve or ask for changes.

### People are told

- An Activity page lists mentions, review requests, replies in threads a person is in and comments on their artifacts. Mentions and review requests also go out by push, Slack or email through those plugins, as each person chooses.
- An artifact's owner, everyone who wrote in a thread and its reviewers follow it.

### Sharing

- The share dialog picks people from the Pipoca server only. There are still no public links and no outside addresses ([ADR 0078](0078-artifacts-and-session-files.md#the-artifacts-plugin)).

### Files

- Files Pi writes in a turn show as cards under its reply. The Session header's Files button lists artifacts, outputs, uploads and the Project folder in one popover.
- The composer's attach menu also takes a file from the Project folder or an artifact, which Pi reads where it already is.

## Consequences

- The chat stays about the work. Discussion lives on the artifact, and Pi's answers are where people asked.
- Batching cuts turns and versions, but a person must remember to send drafts. The comment list shows how many are waiting.
- Shared commenters can no longer steer a Session. Someone who can act in it has to send their thread.
- The modal hides the chat while it's open. Dock covers people who want both.
- Threads, presence and Activity add tables and events to the artifacts plugin. Notifications reuse the push, Slack and email plugins, which stay optional.
- One viewer replaces four surfaces, so the web code shrinks, and files get every improvement artifacts get.
- Suggested edits apply to Markdown only. HTML artifacts get replies and new versions.
