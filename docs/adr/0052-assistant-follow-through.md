# 0052: The assistant reads, delegates and follows through

- Status: accepted
- Date: 2026-11-01

## Context

A person asked the assistant ([ADR 0035](0035-meta-sessions.md)) for a Project over three of their repositories, with a Profile built from their dotfiles first. The plan was to ask a few questions, create the Profile, then create the Project on it. What happened:

- The assistant found the repositories, listed Environments and Profiles, and asked its questions with `ask_user`. It loaded `profiles_create` but never called it.
- It had no way to read the dotfiles. The meta Profile turns off `read` and `bash`, since its workspace is empty. So it started an ordinary Session with a long research brief, opened it, and stopped.
- The brief told the Session to read Pipoca's docs at `/pipoca/docs`. That path doesn't exist. The pod's `/pipoca` holds only the binary, and no Pipoca docs reach any agent. The Session's Profile proposal said it was "not schema-validated" for that reason.
- The Session loads no toolsets, since only meta-sessions do. It couldn't read a Profile's shape or create one.
- The assistant had no way to get the Session's answer back. `sessions_get` returns metadata, and nothing wakes a meta-session when a Session it started finishes. The plan stopped there unless the person copied the report back by hand.
- The meta prompt names Pipoca's parts and safety rules but says nothing about planning, delegating or finishing a multi-step request, so the model improvised.

Claude Code handles the same needs this way:

- It answers questions about itself from its own docs. A built-in guide subagent fetches pages from the docs map ([docs map](https://code.claude.com/docs/en/claude_code_docs_map.md)), so it never guesses a path.
- A subagent's final message comes back to the agent that started it as the tool result, and the parent carries on from there ([subagents](https://code.claude.com/docs/en/sub-agents)). Background work started from a session reports back with a note when it ends a turn.
- It reads a repository it doesn't have checked out through the GitHub API with the person's login, by `gh` or an MCP server, instead of starting another session to clone it.

## Decision

### Pipoca's docs are a toolset every Session gets

- A `docs` toolset ships in the binary, with `docs_search` (titles and headings matching a query) and `docs_read` (one page, or one section of it) (decided 2026-11-01). It serves the guide, the concepts, Environments, plugins and extensibility pages, and a reference for each toolset's data, such as a Profile's fields.
- A plugin can add pages next to its toolset, so a plugin's own docs travel with it.
- Both tools are read-only and only read what the server ships. That makes `docs` the one toolset that loads in every Session, not only meta-sessions. It is served over MCP like the others.
- No docs are copied into runner images or workspaces. A path an agent made up then fails as an unknown page with the list of real ones, instead of a missing file.

### The meta prompt says how to work

The meta prompt gains these rules (decided 2026-11-01):

- Read the docs with `docs_read` before saying how Pipoca works or what a field takes. Never invent a path, a field or a default.
- Do what your own tools can do yourself. Start a Session only for work that needs a workspace, such as reading or changing code your tools can't reach.
- When a request has steps, keep them as a short plan in the chat and say which step you are on. Finish them in order.
- Ask before handing work to a Session, and say what you will do with its answer.
- A Session you start has no Pipoca tools except `docs`. Ask it for a report in a fixed shape that you can act on, and do the Pipoca changes yourself when it reports.

### Sessions an assistant starts report back

- `sessions_start` gains `report`. When it is set, the Session's final message on each turn that ends idle goes to the meta-session that started it as a new turn, through `sessions.send`, the way a Project thread reports to its coordinator ([ADR 0016](0016-projects.md)). The turn names the Session and marks the report as data.
- `sessions_result` returns a Session's latest final message, for a Session started without `report` or by the person.
- A report that arrives while the meta-session is busy waits for its turn to end, like any follow-up.

### The assistant reads repositories through the git host

- The `git-hosts` toolset gains `git_hosts_tree` (the files under a path at a ref) and `git_hosts_read_file` (one file, capped in size) (decided 2026-11-01). They call the host's API with the token of the person who owns the Session ([ADR 0043](0043-git-hosts.md)), so they work on GitHub Enterprise hosts too.
- Both are read-only and never touch the runner's machine, so the meta Profile can keep `read` and `bash` off. A Session with a shell already has `gh` signed in and doesn't need them, but they load wherever `git-hosts` does.

### Helper Sessions stay without Pipoca tools

- A Session the assistant starts loads no Pipoca toolsets other than `docs` (decided 2026-11-01). It reads repositories and other outside content, so text injected there could otherwise reach admin tools with no meta-session watching. The assistant acts on its report, and destructive calls still ask the person ([ADR 0050](0050-assistant-permission-prompts.md)).

### Build order

The `docs` toolset and the prompt come first, since they are small and fix the guessed paths and most of the drift. The git-host read tools come next. They remove the helper Session from requests like this one. `report` and `sessions_result` come last.

## Consequences

- Asked for that Profile again, the assistant reads the dotfiles itself, checks the Profile reference, proposes the Profile with `ask_user`, creates it and creates the Project on it, all in one chat.
- Pipoca's docs become something agents read, so a wrong or stale page now misleads agents as well as people. Docs need the same care as the code they describe.
- Every Session gets two more tools. They are deferred, so they cost a line in the tool search until used.
- File contents from a git host reach a meta-session that holds admin tools. That is the same risk as transcripts and web pages today: the prompt treats them as data and destructive calls ask.
- A helper's report starts a new turn in the meta-session, which costs model tokens even when the person isn't watching.
