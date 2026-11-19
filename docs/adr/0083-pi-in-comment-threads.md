# 0083: Pi in comment threads, and deleting comments

- Status: accepted
- Date: 2026-11-19
- Amends: [ADR 0081](0081-artifact-viewer-and-discussion.md)

## Context

Pi replies and resolves only in threads sent to it. When someone asks in the chat to fix what a comment says, Pi does the work and answers in the chat, while the thread on the artifact stays open with no answer. People then resolve it by hand. Pi also has no way to ask about a passage where it sits, so its questions about a doc land in the chat, away from the text.

Nobody can delete a comment either, even one posted by mistake.

## Decision

### Pi answers where the feedback is

- `reply_artifact_comment`, `suggest_artifact_edit` and `resolve_artifact_comment` work on any thread of an artifact the Session reaches, whether or not it was sent. On an artifact another Session published, the person who started this Session must be able to comment on it. A reply shows as "Pi, via" whoever sent the thread or, for a thread never sent, whoever started the Session.
- Pi's guidelines say to answer feedback in the threads it came from and resolve the ones it finished, even when the ask came in the chat.

### Pi starts threads

- `add_artifact_comment(id, text, quote?, kind?)` starts a thread on the latest version, on a passage or the whole page. It's a comment, a question or a suggestion. On a Markdown doc the quote must be in the latest text, so the pin sits where Pi meant.
- The thread shows as Pi's, via whoever started the Session. It isn't a draft for Pi. Replies from people who can act in the Session that published the artifact reach that Session's Pi, as they do on a sent thread.
- The owner hears of it, and people it names with `@` are told, as with anyone's comment.

### Deleting comments

- Authors delete their own comments and replies. People who steer the artifact delete any, Pi's included. Deleting a thread deletes its replies.
- The viewer asks first, as deleting can't be undone.

## Consequences

- Pi's work on feedback shows on the artifact, and threads close when Pi finishes them.
- Pi can comment on any artifact its Session reaches that its starter may comment on, so a Session's Pi can discuss artifacts of other Sessions too. A reply there reaches only the Session that published the artifact.
- A deleted comment is gone, with its reactions, suggested edit and the Activity items that pointed at it.
