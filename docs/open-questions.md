# Pipoca open questions

> Status: decision backlog. Items here are intentionally unresolved. Move an item into an ADR only after its context, alternatives, decision, and consequences are understood.

## Direction already agreed

- The first product is a self-hosted personal server.
- It manages multiple independent Sessions and multiple Projects.
- Project coordinators and Threads are full Pi Sessions.
- Every Thread can use its own subagents.
- One server can use local, VM, and Kubernetes runners.
- Sessions bind to a Profile and an Environment, neither of which has revisions ([ADR 0031](adr/0031-profiles.md), [ADR 0032](adr/0032-environments-and-runners.md)).
- Pi personalization must remain available in hosted sessions.
- The platform should be extensible enough for later automations and collaboration.
- Setup, new Sessions, new Projects and Settings ask for as little as Claude Code does: one composer with remembered pickers, one Settings page grouped by who it is for, and a first-run setup wizard ([ADR 0040](adr/0040-fewer-forms.md), [ADR 0063](adr/0063-settings-and-first-run-setup.md)).

## Decisions needed before an implementation plan

### Blocking the first slice

- Resolved: no auth in v1 behind localhost or an SSH tunnel, and each provider keeps its own Pi model auth ([ADR 0005](adr/0005-v1-access-and-model-credentials.md)). A solo install is an explicit setting with one admin, signed in through one-time links that `pipoca up` and `pipoca connect` open ([ADR 0053](adr/0053-ways-to-run-pipoca.md#solo-installs)). Users log providers in from the web, and the credential stays in the machine's Pi auth ([ADR 0024](adr/0024-provider-login-from-the-web.md)).
- Resolved: a v1 Session only runs on its own provider, so the agent never starts a second attempt while the first is alive, and the server drops messages from old generations ([ADR 0006](adr/0006-provider-protocol.md)).

### Product and repository boundary

- Resolved: the product is called Pipoca, written `pipoca` wherever people type it, with a popped-kernel mark, Ink and Ivory in the app and Butter only in the mark ([ADR 0042](adr/0042-pipoca.md)).
- Resolved: Pipoca owns its control plane and UI ([ADR 0001](adr/0001-own-the-control-plane-and-ui.md)) and uses TypeScript for every component ([ADR 0002](adr/0002-typescript-for-all-components.md)). The web UI is React and Tailwind on the design system's tokens, with as few dependencies as possible ([ADR 0020](adr/0020-web-stack.md)).
- Resolved: before anyone runs Pipoca with data worth keeping, the code is rebuilt in slices with no backwards compatibility, a fresh database without migrations, one owner model, one route table and a declarative plugin SDK, held to an acceptance list of every feature ([ADR 0068](adr/0068-clean-rebuild.md)).
- Resolved: Bun runtime, Bun workspaces monorepo ([ADR 0003](adr/0003-bun-runtime-and-workspaces.md)).
- Resolved: the session host runs Pi, a third-party extension and a PTY terminal on Bun, also from a compiled binary ([ADR 0010](adr/0010-session-host-on-bun.md)).
- Resolved: apps for entry points, domain-named packages, and a separate folder for Pi extensions ([ADR 0008](adr/0008-monorepo-layout.md)).
- Resolved: the server runs natively on the VM as a compiled Bun binary under systemd, with no container image in v1 ([ADR 0009](adr/0009-vm-deployment-and-testing.md)).

### First end-to-end experience

- Resolved: one independent Session end to end on a local provider with a minimal web UI, then VM, then Kubernetes ([ADR 0004](adr/0004-first-slice-and-provider-order.md)).

### Session lifecycle

- Resolved for v1: an idle Session unloads only when it is archived, and unarchiving reloads it from its transcript ([ADR 0013](adr/0013-archive-and-workspace-lifecycle.md)).
- Does the first version keep active Session processes warm indefinitely?
- Which state must be persisted before a Runtime can release a Session?
- Resolved: Sessions keep running while their provider is offline; an attempt is interrupted only when its process dies, and the agent reloads it idle on restart ([ADR 0006](adr/0006-provider-protocol.md)).

### Workspace durability

- Resolved: VM Sessions get a fresh clone each; laptop Sessions use a worktree of an existing checkout, or the folder directly ([ADR 0007](adr/0007-session-workspaces.md)).
- Resolved for v1: a Session's workspace is a folder, a worktree of a folder, or a clone, each of the last two on its own branch, prepared by the provider ([ADR 0012](adr/0012-built-in-provider.md)). A Kubernetes pod's workspace is thrown away when it idles out, unfinished repository work is snapshotted to the server and restored on the next pod, and a PVC per Session is a template's choice ([ADR 0078](adr/0078-artifacts-and-session-files.md#unfinished-work-on-kubernetes-pods)).
- Resolved for v1: a worktree or clone is removed when its Session is archived, and only if git says nothing would be lost; no age sweep or disk budget yet ([ADR 0013](adr/0013-archive-and-workspace-lifecycle.md)).
- What is backed up, replicated and exported? OpenHands applies a disk budget and retention, with a trash folder before deletion ([research](research.md#openhands)).
- Resolved for v2: a Session resumes on another runner when its lease lapses, and can be forked onto another runner as a new Session ([ADR 0032](adr/0032-environments-and-runners.md), [ADR 0034](adr/0034-v2-deployment-and-credentials.md#v2-scope)).

### Profiles and personalization

- Resolved for v2: a Profile is a Pi agent folder in the server's config folder, owned by a user or shared by an admin, with a shared `default` Profile that starts as plain Pi; a repository's `.pi` loads on top once trusted, and there are no Environment overlays ([ADR 0031](adr/0031-profiles.md), [ADR 0041](adr/0041-profiles-as-folders.md)).
- Resolved for model aliases: alias config and backend health live on the server per Environment, through a `models` plugin with its own gateway ([ADR 0019](adr/0019-model-aliases.md)).
- Resolved: credentials are never in a Profile ([ADR 0031](adr/0031-profiles.md)); provider and MCP logins are kept per person on the server ([ADR 0045](adr/0045-server-kept-logins.md)).
- Resolved: an admin's base Profile loads under every Session's Profile, layered as Pi layers its global and project config, so provider extensions and shared skills reach every Session; the server remembers the models runners last reported ([ADR 0044](adr/0044-base-profile.md)).
- Resolved: the server keeps each person's model and MCP logins, runners read and write them through the server with a lock, and sign-ins open on the person's device from a Logins page ([ADR 0045](adr/0045-server-kept-logins.md)).
- How are required packages distinguished from optional packages?
- Resolved: Profiles have no revisions; a Session keeps its Profile and loads its current content whenever its process starts ([ADR 0031](adr/0031-profiles.md)).
- Resolved for v2: a package that fails to install or load stops the Session from starting, with an error that names it ([ADR 0031](adr/0031-profiles.md)). Checking ahead of time is open.
- Resolved for v2: Pi's own precedence, with the Profile as personal configuration and a trusted repository's `.pi` as project configuration ([ADR 0031](adr/0031-profiles.md)).

### Control plane and protocol

- Resolved: the first control plane runs on the VM, reached from the laptop through an SSH tunnel ([ADR 0005](adr/0005-v1-access-and-model-credentials.md), [ADR 0009](adr/0009-vm-deployment-and-testing.md)).
- Resolved: the agent long-polls for work and each Session streams on its own over HTTPS and SSE, as Claude Code does; the provider's JSONL stays authoritative and every new entry is copied to the server, which serves browser replay ([ADR 0006](adr/0006-provider-protocol.md)).
- Resolved: the agent hosts its Sessions in its own process, and the server uses `Bun.serve` and `node:sqlite` ([ADR 0011](adr/0011-server-and-agent-processes.md)).
- Which operations are synchronous commands versus desired state reconciled asynchronously?

### Projects and shared state

- Resolved for v1: a Project has one coordinator and thread Sessions, each with its own Workspace holding every Project repository; Project tools are built into the session host ([ADR 0015](adr/0016-projects.md)).
- Which messages should create a new Thread versus reuse an existing one? The coordinator decides; there is no rule yet.
- Resolved for v1: the coordinator gets a short notice when a thread finishes a turn or changes state, and threads message the coordinator explicitly ([ADR 0016](adr/0016-projects.md)). A turn notice starts a coordinator turn; a state change notice doesn't.
- Resolved for v1: any Project Session may write Project memory; the last write wins, and every write is logged ([ADR 0015](adr/0016-projects.md)).
- Resolved: the Project library is replaced by a Project folder every Project Session sees as `project/`, synced each turn, with conflict copies and a write log; artifacts are versioned pages at one link, private until shared, rendered in a sandbox, with comments sent to Pi; outputs and uploads are kept on the server ([ADR 0078](adr/0078-artifacts-and-session-files.md)). Artifacts that keep data or ask Pi, typed artifacts such as slides, and public links are open.
- Resolved: a Project's coordinator and threads are Sessions owned by the plugin, hidden from the Session list and shown only inside the Project, whose page is the coordinator's chat with a rail of threads; archiving a Project archives every Session it owns ([ADR 0028](adr/0028-projects-around-the-coordinator.md)).
- How are overlapping repository or file claims detected before work begins?
- Resolved: every Session keeps a checklist through one `update_checklist` tool that replaces the whole list, kept in the tool's results and pinned above the composer; a shared task list that threads claim is not built ([ADR 0056](adr/0056-session-checklist.md)). Should a Profile be able to turn off a built-in plugin's tools, should a Project coordinator go without it, and should Project thread cards show their thread's checklist?

### Future compatibility without premature implementation

- Resolved: every Session, Environment and plugin record has an `ownerId`, and every command records its `actor` (`user:<id>`, `session:<id>` or `plugin:<name>`) ([ADR 0015](adr/0015-plugins.md#actors-and-owners)).
- Resolved: schedules, events and webhooks start work through a `routines` plugin that uses the same start request as people and Projects, and Sessions can schedule their own wake-ups ([ADR 0059](adr/0059-routines-and-wake-ups.md)). Resolved: scripts that decide whether to wake the model run in the workflows' QuickJS sandbox on the server, routines gather into groups with an optional coordinator, chain through `routines.run_ended`, and runs can wait for a person and propose writes instead of making them ([ADR 0075](adr/0075-routines-groups-coordinators-and-agents.md), [ADR 0076](adr/0076-routine-runs-questions-actions-and-guards.md)). Does a graph editor in the style of n8n grow out of routine groups?
- Which domain events should exist from the beginning?
- How should personal servers later federate into a Team Hub without merging their local trust boundaries?

## Deferred to v2

These depend on the Kubernetes provider or the public extension SDK, which [vision.md](vision.md#scope) places in v2. v1 uses one trusted shared-process mode and one provider per Environment. Ideas collected for these from prior art are in [v2-ideas.md](v2-ideas.md).

### Runtime and isolation

- When Sessions can move between machines, do they follow Claude Code cloud sessions (resume on fresh compute from the server transcript and a fresh clone), and how does a provider that loses its lease stop its own Sessions? pi-durable resumes mid-turn from its own storage, and OpenHands fences writes with a generation lease ([research](research.md#pi-durable)).
- What is the default Environment isolation mode for a personal install?
- Resolved: Pipoca is for one person or a team of about 10 to 15; one machine hosts several Environments through a `local` machine source in solo installs, and a team server's runner pods share one namespace behind a NetworkPolicy, with a most-pods limit per person ([ADR 0053](adr/0053-ways-to-run-pipoca.md)).
- Can the `kubernetes` plugin drive a cluster from outside it, such as a local k3s, with a kubeconfig ([ADR 0053](adr/0053-ways-to-run-pipoca.md#a-local-machine-source))?
- Resolved for v2: a runner's capacity decides how many Sessions share it, and capacity one on Kubernetes is a pod per Session [ADR 0032](adr/0032-environments-and-runners.md). Can a shared Runtime safely host several full Pi Sessions? In v1 each Session is its own process on a shared machine ([ADR 0017](adr/0017-process-per-session.md)). OpenHands runs a container per conversation behind a proxy in the host server ([research](research.md#openhands)).
- Resolved: subagents run inside the parent Session's process, on its model runtime and logins, so they stay in its pod; Pipoca implements them itself instead of loading pi-subagents ([ADR 0057](adr/0057-pipocas-own-subagents.md)). Resolved: runs outlast a Session process restart through a run record the server keeps, and a mission belongs to one Session, so a thread can hold missions while its Project still decides the threads ([ADR 0058](adr/0058-subagents-v2.md)).
- What resource and concurrency limits prevent nested work from starving other Sessions?

### Environments

- Resolved for v2: an Environment is configuration plus a pool of runners, and a Session whose runner is lost resumes on another one from the server's transcript [ADR 0032](adr/0032-environments-and-runners.md).
- Resolved for v2: Environments have no revisions; an image and a setup script make the baseline, cached where the runner can [ADR 0032](adr/0032-environments-and-runners.md).
- Resolved for v2: an optional image plus a setup script, with the setup cache on a volume where available [ADR 0032](adr/0032-environments-and-runners.md).
- Which network-policy claims can be strongly enforced on each provider? Network rules are deferred past v2 ([ADR 0034](adr/0034-v2-deployment-and-credentials.md#v2-scope)).
- Resolved for the first v2 slice: Environment secrets are stored on the server and readable by the Session; brokered secrets come after v2. Stored values are encrypted with a master key, and a git token among them gives runners git access ([ADR 0034](adr/0034-v2-deployment-and-credentials.md)).
- Resolved: git credentials are per person, from a `git-hosts` plugin with admin-listed hosts (github.com and GitHub Enterprise), connected by OAuth or a personal access token. Runners use them for workspaces, pushes, `gh` and Profile packages, and an Environment's `GH_TOKEN` stays a github.com fallback ([ADR 0043](adr/0043-git-hosts.md)).
- Resolved: a Session's pull requests are watched by polling with the person's token; with auto-fix on, CI failures, reviews and conflicts come to the Session that opened them as messages, and whether it replies on GitHub as the person is the person's choice, off by default ([ADR 0051](adr/0051-pull-request-watching.md)).
- Resolved: every Environment is one person's, made from an admin's template or by joining a machine, and its runners serve only that person; admins see others' Environments and Sessions as metadata only ([ADR 0049](adr/0049-personal-environments-and-templates.md)).
- Resolved: admins list private hosts the server can't reach, machines name the private hosts they relay to, and the kernel sends the server's calls to one through an Environment of the person or team the call is for; Sessions whose Workspace is on a private host start only in an Environment that reaches it ([ADR 0080](adr/0080-private-hosts-reached-through-environments.md)).
- Should a Session's own traffic to a private host go through the server's relay, so pods could work on its repositories, and may a plugin's Session part ask for an Environment that reaches its host ([ADR 0080](adr/0080-private-hosts-reached-through-environments.md#later))?
- Do model aliases move from Environments to templates ([ADR 0049](adr/0049-personal-environments-and-templates.md))?
- May Project coordinators and worker Threads use different default Environments?

### Extension system

- What is the smallest stable Pipoca extension interface? v1 has an internal one with server, session and web parts ([ADR 0015](adr/0015-plugins.md)); what to freeze for the public SDK is open.
- Resolved for now: installed plugins' server and Session parts import `@pipoca/plugins` from the running server, versioned with it, and it isn't published to npm ([ADR 0046](adr/0046-plugin-sdk-from-the-server.md)).
- Resolved: a Session may propose a plugin but only the user enables it, and third-party plugins install turned off ([ADR 0022](adr/0022-plugin-model-v2.md#installing-third-party-plugins)).
- Resolved for v2: plugins are installed and turned on for the whole installation, and changing them restarts the server; each user's Pi personalization stays in their Profile ([ADR 0022](adr/0022-plugin-model-v2.md#plugins-are-per-installation)).
- Resolved: a plugin requires another only when it can't run without it, and turning the required one off turns it off too after a confirm; looser links are inferred as "works with" and never lock anything ([ADR 0077](adr/0077-plugin-dependencies.md)).
- Resolved for v2: third-party web parts run in the page like first-party ones, with no sandboxed iframe ([ADR 0022](adr/0022-plugin-model-v2.md#trust)).
- Resolved for v2: Pipoca is changed from chat with the assistant, one Project per person in the `projects` plugin ([ADR 0052](adr/0052-the-assistant-as-a-project.md)). Its tools are the server's routes, served over MCP too; they ask before destructive calls in words ([ADR 0050](adr/0050-assistant-permission-prompts.md)), can drive the UI and install in-place plugins ([ADR 0035](adr/0035-meta-sessions.md)). Its coordinator does one-shot actions, and threads build Profiles and plugins in their workspace with all of Pi's tools, install them and check them, with Pipoca's and Pi's docs as files in every Session. How the assistant's powers vary per user is left for v3; each person's Team assistant has tools that follow their role ([ADR 0067](adr/0067-team-plugins-projects-and-assistant.md#each-person-has-a-team-assistant)).
- Is an integrated browser still wanted, and if so as a preview iframe the agent drives through an injected script, or in a desktop app? The CDP screencast was rejected ([ADR 0022](adr/0022-plugin-model-v2.md#no-browser-plugin-yet)). A Tauri desktop app is decided ([ADR 0055](adr/0055-desktop-app.md)); in it the browser can be a native webview driven by injected scripts, and driving it through the DevTools Protocol would need Electron or a Chromium runtime for Tauri ([ADR 0055](adr/0055-desktop-app.md#the-integrated-browser)).
- Which native features does the desktop app offer plugins beyond notifications, a folder picker, revealing a path, tray items and deep links, and should the app join its machine as a runner to a team server ([ADR 0055](adr/0055-desktop-app.md#what-the-app-gives-plugins))?
- Which extension types run inside the server, a runner, the browser, or a Pi Session?
- Resolved: plugins declare settings with defaults in their manifest, values are stored per installation and edited on a Plugins page, and a plugin that fails to start is turned off and reported instead of stopping the server ([ADR 0036](adr/0036-plugin-settings.md)).
- Resolved for v2: every plugin declares `capabilities` in its manifest, built-in or installed, and the server holds both to them; only built-ins get `auth`. The exact capability names are open. `requires` isn't read yet and arrives with the first plugin that needs it ([ADR 0022](adr/0022-plugin-model-v2.md#a-small-manifest), amended 2026-10-29).
- Which first-party features must prove the public extension surface?
- How are blocking or faulty trusted extensions diagnosed and disabled safely?
- Resolved: Chromium resolves `*.localhost` for previews, which cover pages a Session opens through `BROWSER` ([ADR 0037](adr/0037-previews-and-opened-pages.md)). Other browsers are checked as they are used.
- Resolved: server tools repair JSON-encoded arguments before Pi validates them, built-in plugins may import only the SDK packages, lists update from change events instead of polling, and the usage plugin shows how full the context is ([ADR 0038](adr/0038-tool-repair-change-events-and-context.md)).
- Can an in-place plugin's web part be loaded in a sandboxed headless page before the user turns it on, to report runtime errors, without running its code anywhere it can reach something ([ADR 0038](adr/0038-tool-repair-change-events-and-context.md#later-checking-an-in-place-plugin-before-it-is-turned-on))?
- Resolved: a plugin can keep its config in a writable config folder, under its own key in a shared `pipoca.json` or in its own files, and chooses between a file and SQLite; the UI edits the file, and secrets are sealed in it or named by environment variable ([ADR 0039](adr/0039-plugin-config-files.md)).
- Can a compiled Bun binary import plugin files from outside itself? It is checked when ADR 0022's third-party install is built.

## Explicitly postponed

- Resolved: a server is one team, its users are whoever the sign-in provider or an admin lets in, and the roles are admins and users. Team work is open to every user unless its starter limits it, anyone can start it, and it runs on team Profiles and team Environments that admins manage ([ADR 0064](adr/0064-one-team-per-server.md)).
- Resolved: team model keys and HTTP MCP logins stay on the server behind a proxy that team Sessions reach with a token of their own ([ADR 0066](adr/0066-team-credentials-and-usage.md)). How do providers that extensions add, and MCP servers that run as local processes, keep their keys off team runners?
- Resolved: the team's view is a separate team hub, plugins declare personal, team or both, and a team Session's composer sends To Pi, To the team or Off the record, with quote replies, questions addressed to a person and votes anyone can open ([ADR 0065](adr/0065-team-hub-and-team-conversations.md)). How large is the cap on team messages Pi reads, and do side threads, a shared state card or a catch-up summary for late joiners earn their place?
- Resolved: the proxy records one row per model call with its cost from an admin's price table, team budgets and per-person caps warn without stopping, and admins see all of it while users see their own and the team's totals ([ADR 0066](adr/0066-team-credentials-and-usage.md)). Team routines get no extra run cap ([ADR 0067](adr/0067-team-plugins-projects-and-assistant.md#team-routines)).
- Multiplayer presence and simultaneous steering. The direction is Team Sessions owned by a team, on admin-set credentials, with kernel-run sharing and one input queue per Session; they wait on a GitHub App, credentials kept outside the Session, a usage and audit record and team membership ([ADR 0054](adr/0054-team-sessions.md)). Membership and roles are settled by [ADR 0064](adr/0064-one-team-per-server.md).
- Resolved: GitHub Apps are technical users an admin registers, several per host, created with GitHub's manifest flow, with installation tokens per Session and the bot as author ([ADR 0060](adr/0060-technical-users-and-github-apps.md)). A software factory is routines that start one Session per issue or pull request and pick a workflow by kind of work ([ADR 0061](adr/0061-software-factory.md)); Slack and email are plugins that add triggers and replies ([ADR 0062](adr/0062-slack-and-email.md)). Team routines are any user's, run on team Profiles and act as technical users the team may use ([ADR 0067](adr/0067-team-plugins-projects-and-assistant.md#team-routines)).
- Can a member use their own login for their own messages in a Team Session, as Claude Tag allows ([ADR 0054](adr/0054-team-sessions.md#team-sessions-and-team-features-belong-to-the-team))?
- Billing and chargeback.
- General-purpose durable workflow syntax.
- Marketplace and third-party extension distribution policy.
- Transparent live-process migration between providers.
