---
title: Artifacts and files
description: Pages Pi publishes with versions and comments, and the files a Session keeps on the server.
sidebar:
  order: 8
---

What a Session keeps lives on the server, wherever the Session runs, so it outlasts the runner and a pod that goes away ([ADR 0078](../adr/0078-artifacts-and-session-files.md)).

## Files

Pi writes files meant for you in its `outputs/` folder, which is saved after every turn (the `files` plugin). Files you add in the composer reach Pi in `uploads/`, and Send waits until they're uploaded. Both sit in the Session's own folder, outside the workspace, and the panel's **Files** tab downloads them.

- `files.maxFileBytes` sets the largest file (200 MB by default).
- Past `files.perPersonBytes` (10 GB) of files across the Sessions a person owns, the Files panel warns them, and Settings > Files lists them for admins, with what Session files take and what's free on the data volume. Nothing is deleted or refused.
- On a Kubernetes pod without a disk of its own, the Files tab also lists each checkout's unfinished work kept on the server, with the files Pi changed but didn't commit ([Runner pods](../admin/environments.md#runner-pods)).

A [Project](projects.md#the-project-folder) also has a folder its Sessions share.

## Artifacts

Pi publishes a page, a Markdown document, a picture, a PDF or a CSV table with `publish_artifact`, and a change as a new version at the same link (the `artifacts` plugin). The chat shows a card that opens it on its own page: the artifact beside its versions, each with who made it, when and what changed (`publish_artifact` takes a short `note`), a link to copy for any version, a download, and a banner on an earlier version that offers to go back to the latest or restore it. The **Artifacts** tab beside a Session shows the newest one it published, and picks among the others.

The **Artifacts** page lists yours, the ones shared with you and the team's, with a search over titles and Session names, each row saying who opens it and how many comments are open. The pin button keeps an artifact in the sidebar.

### Who sees it

Whoever sees its Session opens it. Whoever steers the Session can share it with named people, who can view or comment, from the **Share** dialog, which also copies a link to the latest version or to one version. Pi can't share. Pi finds artifacts with `list_artifacts` and reads one back with `read_artifact`.

An artifact runs in a sandbox on an opaque origin, so it can't reach Pipoca or your sign-in, and it loads scripts and styles only from `artifacts.scriptHosts` (cdnjs, jsDelivr and unpkg by default).

### Comments and edits

- Leave comments beside an artifact, on a passage you select or on the whole thing, and reply to them or resolve them. The page marks the passages comments are on.
- A comment with **Send to Pi** checked reaches the Session as your message. Ask Pi about the rest, and it reads them with `read_artifact_comments`: the open ones with their replies, or the resolved ones too.
- `list_artifacts` says how many comments are open on each.
- **Compare** shows two versions as a line diff, or side by side for pictures and PDFs.
- Whoever steers the Session can edit a Markdown artifact's source and save it as a new version, and Pi is told to read it before changing it again.
- A page can ask for a message with `parent.postMessage({ pipoca: "draft", text }, "*")`: it lands in the Session's composer, and you decide whether to send it.

Settings has a section for each of the Files, Artifacts and Projects plugins' limits.
