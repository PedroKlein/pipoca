# 0082: Living Markdown artifacts

- Status: accepted
- Date: 2026-11-19
- Amends: [ADR 0078](0078-artifacts-and-session-files.md), [ADR 0081](0081-artifact-viewer-and-discussion.md)

## Context

Every change to an artifact saves a new version. That covers Pi publishing again, a person's edit and an accepted suggestion. A comment thread belongs to the version it was written on, and on a newer version it shows "Version N". People discussing a design doc fix a paragraph, and the doc jumps to a new version. The threads beside the page then read as old even though the text they're about hasn't changed. After a few small edits a doc has a dozen versions that nobody chose.

Claude Code versions an artifact on every publish, and its threads belong to the artifact. Claude Docs edits a document in place, keeps comments on their passage and keeps a history of edits. Docs people discuss together work better the second way.

## Decision

### Markdown docs and HTML pages are edited in place

- A Markdown artifact, design docs included, is one living document. A person's edit, an accepted suggestion, Pi publishing it again and a restore all change it in place.
- Each change is kept as a save in the history, with who made it and when. Any save can be opened, compared with another or restored. The history groups saves by person and hour.
- HTML pages are living documents too (amended 2026-11-19, after pages that got many small tweaks piled up versions): Pi publishing a page again is an edit, and versions come only from approval, Decided or Save version.
- SVG, CSV, images and PDF files still make a version on every publish, as before.

### Versions are made on purpose

- A save becomes a version of a living document in two ways:
  - when a reviewer approves the doc or a person marks it Decided, it is labelled "Approved by Ana" or "Decided by Ana";
  - when someone who steers it picks Save version and names it, such as "Sent to legal".
- A second approval of the same text adds a name to that version's label. It doesn't make a new version.
- Versions are numbered among themselves, and people see only those numbers. Pi still names saves by number, as the revision it read and the one it publishes on.

### Comments stay on their passage

- A thread belongs to the artifact, on every kind of artifact. It carries over to each new save or version and shows beside the text it quotes in whatever one is open.
- A thread whose quoted text is no longer in the open save or version is marked Outdated and still lists its quote. A thread on an element is Outdated when no element there matches it.

### Edits after approval

- Editing a Decided doc moves it back to In review, and any edit clears reviewers' verdicts, as before. The review bar links to the changes since the last approved version, so nobody reads an edited doc as already approved.

## Consequences

- A discussion survives the edits it leads to, on Markdown docs and HTML pages alike. Threads go Outdated only when their passage is gone.
- Versions mean something: what was approved, or what was sent somewhere. The history still lets people go back to any edit.
- The versions table keeps every save. A label marks the ones that are versions, so no data moves and links to a save keep working.
- An HTML page is a living document even though Pi rewrites it whole, so its history is the place to see each publish.
