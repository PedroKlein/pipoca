# 0052: The assistant as a Project

- Status: accepted
- Date: 2026-11-01

## Context

A user asked the assistant for a Project over three repositories, and to build a Profile from the Pi setup in one of them first. The assistant understood the plan but couldn't carry it out:

- A meta-session can't read files. Its Profile turns off Pi's `read`, `bash`, `edit` and `write` ([ADR 0035](0035-meta-sessions.md#a-meta-session-is-a-session-on-the-meta-profile)), so to look at the repository it started an ordinary Session.
- That Session had no Pipoca tools, since toolsets load only in meta-sessions, and it ran on the user's default Profile.
- The assistant told it to read Pipoca's docs at a path it made up. No docs exist where an agent can reach them, in meta-sessions or in Sessions.
- Nothing came back. `sessions_get` returns metadata, not the Session's answer, and nothing wakes the assistant when a Session it started finishes.
- Even with the research done, `profiles_create` takes only packages, `AGENTS.md`, system prompts and settings. Profiles are folders ([ADR 0041](0041-profiles-as-folders.md)), and the skills, extensions and prompts the user wanted are files no tool could write.
- Opening the new Session was a live UI action, so the conversation kept no link to it.

The prompt also said nothing about how to work: plan, ask, do the work itself, follow through.

Each fix could have been one more tool: a git-host file reader, Profile file tools, a docs search. Pi is already good at files with its own tools, and every new tool is one more thing to describe, search and maintain.

## Decision

### One assistant Project per person

- The assistant is a Project each person has, made the first time they use it. It is one long conversation, not many meta-sessions (this replaces ADR 0035's "any number of meta-sessions").
- It reuses Projects ([ADR 0016](0016-projects.md), [ADR 0028](0028-projects-around-the-coordinator.md)): a coordinator, threads in a rail, memory, thread cards and links. It has no repositories of its own and isn't listed with the person's other Projects.
- The home screen is its coordinator's chat. Earlier meta-sessions stay listed as earlier conversations until they are archived.
- Its memory holds what the person wants it to remember, such as their usual Environment, model and repositories, so later requests don't ask again.

### The coordinator does small things itself

- The coordinator answers questions and does one-shot actions straight away with the Pipoca toolsets: start a Session for the person's own goal, create a Project, rename or archive something.
- It starts a thread for work the person will iterate on, such as building a Profile, a plugin or an Environment's setup.
- The coordinator can read the docs folder (below) with Pi's `read`, `grep`, `find` and `ls`. It has no `bash`, `edit` or `write` and no repositories, since it lives as long as the person and reads every thread's report.
- A Session the assistant starts for the person's own goal is a hand-off. It doesn't report back. Assistant threads report to the coordinator like Project threads.

### Coordinators are swapped, not compacted

This applies to every Project's coordinator, the assistant's included, as Claude Code does it.

- When Pi compacts a coordinator's context, Projects archives that coordinator at the end of its turn and starts a fresh one in its place. Compaction is the sign that the context is full, and it works for any model's window.
- The new coordinator's system prompt carries the handoff: Pi's latest compaction summary, the chat since, the threads with their states, and the Project's memory index. It is in the system prompt because Pi keeps no context message in a Session's file before its first reply. The person keeps the same Project page.
- Start fresh, in the Project's settings, does the same swap by hand, for when the coordinator has gone off track.
- The old coordinator stays readable: the settings list each earlier conversation, so nothing in its history is lost.
- Pi's compaction still runs inside threads and other Sessions. A coordinator lives as long as its Project, and compacting a summary again and again drifts, where a swap starts clean from memory and threads.
- A memory write carries the revision it read, and the server refuses it when the file changed since. So two threads writing at once can't lose each other's change; the refused one reads again and retries. Before, the last write won.

### Threads build in their workspace, then install

- A thread runs on the meta Profile with the Pipoca toolsets and all of Pi's tools, including `bash`, `edit` and `write`, in a workspace of its own (this replaces ADR 0035's rule that turns them off).
- A thread clones the repositories it needs with the person's git-host logins, as any Session does. A tool adds a repository to its workspace when one comes up mid-conversation.
- A thread builds what it makes as files in its workspace: a Profile is a folder like `~/.pi/agent`, and a plugin is a plugin folder. It can try them there, for example by running Pi with that folder or building the plugin with Bun.
- An install tool copies a folder from the workspace to the server, one per kind: Profiles and plugins first. Installing over a Profile that Sessions use, and installing any plugin, asks first ([ADR 0050](0050-assistant-permission-prompts.md)). A new Profile doesn't ask.
- After installing, the thread checks the result: it starts a short Session on the new Profile and reads whether its packages loaded, or, once the person turns a plugin on, reads the plugin's status.
- These replace `profiles_create` and `profiles_update` for content, and `plugins_write_file` and `plugins_build` ([ADR 0035](0035-meta-sessions.md#in-place-plugins)). An installed plugin still starts turned off, and only the person turns it on.
- Small tasks inside a thread can use subagents once they inherit the meta Profile's permission check. Until then the meta plugin keeps the subagents part out, as now.

### Docs as files in every Session

- The server ships its docs, Pi's docs and each running plugin's docs into every Session, at a folder named in the Session's environment. They reach runners the way Profiles do, by hash, so they always match the server that will install the result.
- Plugins can ship docs in their package, next to their code.
- The meta prompt points at that folder and says to read the relevant page before writing any Pipoca format.

### Cards stay in the history

- A tool that creates or opens something, such as a Session, Project, Profile, Environment or plugin, leaves a card in the chat with its name and an Open button.
- The card is drawn from the tool's result, so it is still there after a reload and when scrolling back. Any plugin's toolset gets it by declaring what its tool opens, as it does now.
- On a wide screen the live action still opens the thing at once ([ADR 0035](0035-meta-sessions.md#meta-sessions-drive-the-ui)).

### How it works, in the prompt

The meta prompt tells the assistant to:

- plan the steps of a request, show them, and say which one it is on;
- do Pipoca changes with its own tools, and never hand them to a Session that lacks them;
- start a thread for anything iterated on, and do one-shot actions itself;
- read the docs before writing a Pipoca format, and never invent a path or a URL;
- finish the request, or say exactly what is left and who has to do it.

## Consequences

- One request, such as "build a Profile from my dotfiles, then a Project on it", runs in one place: a thread reads the repository, builds the Profile, installs and checks it, and the coordinator then creates the Project on it.
- Threads hold admin tools and a shell, and they read repositories. Text in a repository could make a thread run commands on the person's runner or start Sessions without a prompt. Runners serve one person ([ADR 0049](0049-personal-environments-and-templates.md)), destructive calls and installs still ask, the person's own Profiles still never load in the assistant, and a thread acts only as its person.
- The coordinator keeps a shell and repositories out of the Session that stays with the person, and memory is how it knows them. Swapping coordinators replaces the "one coordinator plus compaction" choice made when Projects were designed, for every Project.
- Every Session gets a docs folder, so ordinary Sessions that write plugins or Profiles stop guessing formats too.
- The tool count goes down: file work goes through Pi's own tools, and two install tools replace four authoring tools.
- MCP keeps serving the toolsets ([ADR 0035](0035-meta-sessions.md#mcp)). The install tools read from a Session's workspace, so an MCP client can't install from its own folders yet.
