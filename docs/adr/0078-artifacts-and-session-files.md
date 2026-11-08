# 0078: Artifacts and Session files

- Status: proposed
- Date: 2026-11-08
- Supersedes: the Project library of [ADR 0018](0018-project-library.md) and [ADR 0068](0068-clean-rebuild.md#what-goes)
- Amends: [ADR 0032](0032-environments-and-runners.md), [ADR 0039](0039-plugin-config-files.md), [ADR 0064](0064-one-team-per-server.md)

## Context

Pi makes things people want to open later: a report, a plan, a diagram, a table, a small page with scripts. It also gets files from people: a statement, an export, a screenshot. Today Pipoca keeps almost none of it:

- The only shared place is the Project library ([ADR 0018](0018-project-library.md)), now part of the Projects plugin. It holds flat files up to 10 MB in SQLite, with three tools and a download list. It renders nothing, keeps no versions, can't be shared outside the Project, and only Project Sessions have it.
- The composer takes images only, sent inside the message.
- A Kubernetes Environment's default workspace lives on the pod (`workspace: "pod"`, an `emptyDir`), and the pod exits after `idleSeconds` (300 by default). A Session moves to a new pod only if its workspace can be made again, from a fresh clone, so whatever Pi made and didn't push is lost. `workspace: "claim"` keeps a PVC per Session, but every claim costs a disk until the Session is archived, nodes attach only a few dozen disks, and claims are pinned to a zone.

Other products were read on 2026-11-08 ([research](../research.md#artifacts-and-files)). Claude and ChatGPT keep an artifact beside the chat with every version at one link, and Claude Code publishes single pages that are private until shared and that take comments sent back to the agent. Lovable pins comments to elements on the page. Claude Code projects keep a throwaway container plus a shared project folder that outlives every thread.

## Decision

### The runner works, the server keeps

A Session's workspace stays on whatever runs it: a laptop, a VM, a Docker bind mount or a pod. What people open later lives on the Pipoca server, because runners sleep and pods go away. That is artifacts, uploads, outputs and the Project folder. Pi's side of each plugin moves bytes over the link the runner already has to the server, through the session part's `request` seam ([ADR 0018](0018-project-library.md#decision)), never through the model. It works the same on every runner.

### One blob store in the kernel

- Two plugins need to keep bytes, so the kernel gets a small seam, `context.blobs`: put, get and delete by SHA-256, with streaming reads.
- Bytes live in a `blobs/` folder on the server's data volume, named by hash. Each plugin keeps names, versions and owners in its own SQLite tables and holds references; a blob nothing references is removed.
- An S3-compatible store can replace the folder later behind the same seam.

### The artifacts plugin

- **Publish.** Pi writes a file in its workspace and calls `publish_artifact(path, title?, id?)`. Without `id` it makes a new artifact; with one it adds a version. Every publish is a new version at the same link, `/a/<id>`. People opening it get the new version without a reload.
- **Versions.** Every version is kept until the artifact is deleted. A person can open an old version, restore it as the newest, compare two versions as a source diff (images and PDFs side by side), and copy a link to one version with `?v=<n>`.
- **What renders.** HTML, Markdown with Mermaid and code highlighting, SVG, PNG, JPEG, GIF, WebP, PDF, and CSV as a table. React pages load React's UMD build from an allowed host; there is no build step.
- **Sandbox.** An artifact's bytes are served from the same host as Pipoca with `Content-Security-Policy: sandbox allow-scripts` plus a CSP that allows scripts only from the hosts admins list, and nothing else from the network. A page runs on an opaque origin even when opened directly, so it can't reach Pipoca's API or the viewer's sign-in. No wildcard host is needed, unlike previews ([ADR 0037](0037-previews-and-opened-pages.md)).
- **Where it shows.** A card in the chat where Pi published it; a panel beside the Session with tabs for Artifacts, Files and Changes; a page of its own with versions; an Artifacts page listing yours, shared with you and the team's; and pins in the sidebar.
- **Who opens it.** An artifact follows its Session. Personal work: only its owner, until they share it with named people. Team work: everyone on the team ([ADR 0064](0064-one-team-per-server.md)). Project work: the Project's people. Shared people get View or Comment. A link opens the latest version or one fixed version. There are no public links; every viewer signs in. Pi can't change who opens an artifact.
- **Comments.** A person selects text or an element and comments; others reply and resolve. A comment or reply with "Send to Pi" on reaches the Session as that person's message and wakes it if it's idle.
- **Edits.** A Markdown artifact has Read, Comment and Edit modes; a person's edit saves as a new version that Pi sees with its author. HTML artifacts have Read and Comment.
- **Send to Pi from the page.** A page can call `window.parent.postMessage({ pipoca: "draft", text })`. Pipoca puts the text in the Session's composer for the person to send; it never sends by itself.
- **Pi's tools.** `publish_artifact`, `list_artifacts(query, session?)` which returns at most 20 matches, and `read_artifact(id, version?)`, which writes the file into the workspace and returns its path.

### The files plugin

It replaces the Project library. The library's tables and tools go.

- **Outputs.** A Session's `outputs/` folder holds what Pi makes for people. After each turn, its changes are saved on the server; they show under the Session's Files tab with downloads.
- **Uploads.** The composer takes any file type. An upload is saved on the server when it's added, before the message is sent, and copied into the workspace's `uploads/` folder, on any runner the Session later moves to. Images also go to the model as images, as today.
- **Project folder.** Every Session in a Project sees the Project's folder as `project/`. It's pulled before each turn and pushed after it. When two Sessions change one file in the same turn, both are kept: the later one as `name (from <thread>).ext`, marked as a conflict copy. Every write is logged with its writer, and earlier versions of a file are kept for 30 days. The Project's Folder tab lists files, takes uploads and shows recent writes.
- **Sync.** Each side sends a list of hashes first, then only the files the other lacks, in chunks that can resume. Sync runs in the background and never holds up the next turn; a slow pull is skipped for one turn with a notice that `project/` may be stale.
- **Outbox.** A file that hasn't reached the server waits in the runner's outbox and retries with backoff. The Session shows what isn't saved yet. A pod doesn't exit while its outbox has files.
- **Pi's tools.** `list_files(query, place?)`, which returns at most 20 matches across outputs, uploads and the Project folder. Saving needs no tool: Pi writes to `outputs/` or `project/`. Each Profile's prompt says so.

### Unfinished work on Kubernetes pods

- At the end of each turn and before a pod exits, the runner saves a snapshot of each repository checkout: changed and new files git doesn't have yet, leaving out what `.gitignore` excludes. The latest snapshot per Session is kept as a blob.
- The next pod clones the Session's branch and puts the snapshot back. Ignored folders like `node_modules` are rebuilt.
- A snapshot over the limit is skipped, and the Session says so. Laptop, VM and Docker workspaces already stay on the host and get no snapshots.
- `workspace: "pod"` stays the default. `workspace: "claim"` stays for templates that want a disk per Session.

### Limits and config

The plugins' config is JSON under their keys in `pipoca.json` ([ADR 0039](0039-plugin-config-files.md)), edited on Settings > Files and artifacts:

```json
{
  "files": {
    "maxFileBytes": 209715200,
    "perPersonBytes": 10737418240,
    "perProjectBytes": 5368709120,
    "folderHistoryDays": 30,
    "snapshots": { "enabled": true, "maxBytes": 524288000 }
  },
  "artifacts": {
    "scriptHosts": ["cdnjs.cloudflare.com", "cdn.jsdelivr.net/npm", "unpkg.com"]
  }
}
```

The largest file is refused with a message that names the limit. The per-person and per-Project numbers only warn the people involved and admins, like budgets ([ADR 0066](0066-team-credentials-and-usage.md)); nothing is deleted or refused.

### Not now

- Artifacts that keep data, know their viewer or ask Pi from the page.
- Typed artifacts such as slides, documents and dashboards.
- Public links, and editing HTML text in place.
- Forking a new Session from an artifact version.
- Large files kept on the runner and fetched while it's online.

## Consequences

- Everything people keep sits on one server volume. Backups grow, and the volume needs room; Settings shows usage. If the server is down, Pi keeps working but can't save or publish until it's back.
- Per-turn sync means the Project folder is not live. Two Sessions editing one file get a conflict copy instead of a merge.
- A pod that idles out keeps unfinished repository work without a disk per Session, at the cost of rebuilding ignored folders on the next pod.
- The session host gets an outbox, hash-based sync and resumable uploads that other plugins can reuse through `context.blobs` and the `request` seam.
- Comments sent to Pi are messages from people, so anyone with Comment access to an artifact can steer its Session. The share dialog says so.
- The web app gets a slot for panels beside a Session, which other plugins can fill too.
