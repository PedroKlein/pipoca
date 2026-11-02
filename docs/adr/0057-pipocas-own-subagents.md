# 0057: Pipoca's own subagents

- Status: accepted
- Date: 2026-11-02
- Replaces the pi-subagents parts of [ADR 0030](0030-subagents.md)

## Context

[ADR 0030](0030-subagents.md) made subagents a built-in plugin that loads pi-subagents in every Session and draws its runs as cards in the chat. Two things broke that on 2026-11-02:

- pi-subagents starts a background run by relaunching a compiled Bun host as Pi's CLI. The pipoca binary answered with its usage text, so every background run failed. The binary now hands those arguments to Pi's `main`.
- With that fixed, every child still fails with `Model "<model>" not found`, in the foreground too. pi-subagents builds each child's models with `ModelRuntime.create()`, which reads `auth.json` and `models.json` from the Pi agent folder. Pipoca keeps model logins on the server ([ADR 0045](0045-server-kept-logins.md)) and the runner's models next to them, so a child sees neither. pi-subagents has no way for a host to hand its children a model runtime or a credential store.

pi-subagents is about 98,000 lines in 322 files and releases every day or two. Most of it serves terminals and other hosts: Herdr panes, tmux and Ghostty inspectors, external CLI agents such as Claude Code, Codex and Cursor, profile generation and cost reports. What Pipoca uses is a small part of it.

## Decision

### A plugin of Pipoca's own

- The built-in `subagents` plugin implements subagents itself instead of loading pi-subagents (decided 2026-11-02). Pipoca doesn't fork pi-subagents and doesn't propose changes upstream. It takes only what Pipoca needs.
- A user who wants pi-subagents adds it to their Profile's packages. Their extension registers `subagent` and replaces the plugin's, by ADR 0030's rule.

### Children run in the Session process

- A child is a Pi session created with Pi's SDK inside the Session process, on the Session's own model runtime and logins. It reaches every model the Session can, with no credentials copied and no second process. Token refreshes still go through the server's leases.
- The session host gives session plugins a way to start such a child: the Session's model runtime, Profile, working directory and permission rules, with the child's tools, model, system prompt and session file chosen by the plugin. The subagents plugin is its first user.
- A child keeps its own Pi session file next to the Session's, linked to it as its parent. The web reads a child's transcript from there, so it needs no inspect command or polling.
- A child's tools are the agent's tools from Pi's built-in set. Children don't get `subagent`, so they can't start children of their own.
- At most 4 children run at once in a Session. More wait in a queue.
- Children stop when the Session process stops: a restart, a stop, or an idle runner pod going away. A stopped child shows as interrupted, as a tool call does. pi-subagents' detached runner outlives a parent restart, and these children don't. In exchange there's nothing to clean up and nothing to hand credentials to.

### What v1 has

- A `subagent` tool with three shapes: one run, parallel runs, and a chain where each step gets the previous step's output.
- Runs go to the background by default. The tool returns at once with a run id, and the plugin wakes the parent with a follow-up message carrying each run's output when it ends, as pi-subagents does. `wait: true` makes the call block until the run ends instead.
- `status`, `steer` and `stop` as actions of the same tool, and as buttons in the web.
- Agents are markdown files with pi-subagents' frontmatter (`name`, `description`, `tools`, `model`, `thinking`, and the body as the system prompt), so existing agent files keep working. They come from the Profile's `agents/` folder and the project's `.pi/agents/`, the project's winning. Four are built in: `scout` (read-only recon), `worker` (edits), `reviewer` (read-only review) and `delegate` (inherits the parent's model, no extra prompt). An agent with no model uses the Session's.
- Prompt shortcuts `/parallel-review`, `/review-loop`, `/parallel-research` and `/gather-context-and-clarify`, as prompt templates the plugin's extension adds through Pi's resource discovery. They only tell the agent how to fan out with `subagent`.
- The run state is published as plugin data. The web part draws ADR 0030's card from it, a lane per child for parallel and chain runs, the running chip, and a fleet panel the chip opens with every run in the Session, its transcript, and Steer and Stop.

### Later, in v2 (decided 2026-11-02)

- Workflow scripts: code the agent writes to start, retry, steer and combine runs, with saved state.
- A watchdog: a second model, opt-in per Profile, that reviews each turn's changes and steers findings back to the agent.
- Missions: durable records of delegated work, with an objective, its runs, decisions and receipts such as PRs. Projects and threads already hold some of this, so the design starts from them.

### Not planned

- Schedules. Starting work on a timer belongs to Automations on the server, which runs when no Session is open.
- External CLI agents, terminal inspectors, worktree isolation for parallel writers, and profile generation.

## Consequences

- Subagents use every model a Session can, OAuth logins and extension providers included, with no extra setup.
- Pipoca owns this code: an estimated 2,000 to 3,000 lines plus the web part, instead of tracking a fast-moving package.
- Sessions stop installing pi-subagents from npm on first start.
- Background runs don't survive a Session process restart. If that becomes a problem, children can move to their own process later; the logins problem then needs solving for that process.
- Children share the Session's CPU and memory, bounded by the limit of 4.
- The kernel gains a way for session plugins to start child sessions on the Session's runtime.
- ADR 0030's card and chip stay. Its pi-subagents parts, the pinned package, the inspect command and the widget snapshot, are replaced.
