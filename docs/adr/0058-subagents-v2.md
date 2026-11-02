# 0058: Subagents v2: runs that outlast a restart, a watchdog, workflows and missions

- Status: proposed
- Date: 2026-11-02
- Builds on [ADR 0057](0057-pipocas-own-subagents.md)

## Context

[ADR 0057](0057-pipocas-own-subagents.md) built Pipoca's own subagents: children run as Pi sessions inside the Session process, on its models and logins. Workflow scripts, a watchdog and missions were left for v2 (decided 2026-11-02). The order agreed on 2026-11-02 is one ADR for all of v2, then the watchdog first, then workflows, then missions.

v1 has been live on Kyma since 2026-11-02, and it showed one gap that v2 as planned doesn't cover. A run lives only as long as the Session process. Every upgrade restarts the runner pod, and a run in progress then is lost with no trace except a tool call that never got its follow-up.

pi-subagents has all three v2 features, built for a terminal on one machine. Its watchdog has boundary, cadence and LSP reviews, child watchdogs, launch rules, a permission arbiter and a clarification channel. Its workflows run JavaScript in a sandbox, with keyed runs, lanes, budgets, gates, host commands, named resources and reuse after a reload. Its missions are JSON files with decisions, receipts, state, goal mode and a global index. Pipoca takes the core of each and leaves the rest out, as ADR 0057 did.

## Decision

### Runs outlast the Session process

- The server keeps the record of every run, the way it keeps the Session's transcript: its shape, its children, each child's state, task, model, last activity and output. The plugin already publishes this to the web. It now also sends it to its own server part, which stores it per Session. A run then survives the loss of its runner, and the fleet panel can show it from the server alone.
- When a Session starts and finds runs that never ended, each unfinished child is marked `interrupted`. The parent gets one follow-up message listing them, with the output each one had so far, so the agent can decide what to do. Nothing restarts on its own.
- A `resume` action restarts an interrupted child. If the child's Pi session file is still on the runner, the child continues from it. If not, it starts again on the same task, with its last output added to the task. For a chain, `resume` picks up at the step that was interrupted.
- Children keep running in the Session process. Moving them to their own process is still not needed for this.

### Watchdog

- The watchdog is a second model that reviews what the agent changed in each turn. It sends findings back to the agent when they matter, and says nothing when the turn is clean. It is off by default.
- It is turned on per Profile, in the Profile's Pi `settings.json`, under the same key pi-subagents uses: `subagents.watchdog` with `enabled`, `model` and `thinking`. An existing pi-subagents setting keeps working, and a person with several Profiles can turn it on for some of them. With no `model`, it uses the Session's model.
- It runs once at the end of each parent turn that changed the working tree, using `git status` and `git diff` against where the turn started. A turn that changed nothing costs nothing.
- The review is a child session on the Session's models, with read-only tools (`read`, `grep`, `find`, `ls`) and no `bash`. It is given the turn's user prompts, the diff, and `WATCHDOG.md` instructions from the project's `.pi/` folder or the Profile.
- It answers with findings, each with an importance (`low`, `medium` or `high`), a summary, its evidence and a suggested action.
  - A `high` finding is sent to the agent as a follow-up message, so the agent fixes it in a new turn.
  - `low` and `medium` findings are shown to the person only. They are written to the transcript as a notice, which the web draws, and the model never sees them.
- If the same `high` finding comes back 3 turns in a row, the watchdog shows it as stuck, stops sending it, and waits for the person's next message.
- Not taken from pi-subagents: cadence reviews during a turn, LSP pre-passes, watchdogs on children, launch rules, the permission arbiter, and clarification questions.

### Workflows

- A workflow is a short JavaScript script that starts and combines runs. It can await one run's output before starting the next, run several at once, retry, or steer. It is for flows that are more than one chain or one parallel batch, such as a review loop that stops when the reviewer is satisfied.
- Scripts run in the QuickJS sandbox that Pi's codemode already uses, and that the session host already ships in the compiled binary. pi-subagents runs them with Node's `vm` in a worker thread, which isn't a security boundary. A script sees only `runs.run`, `runs.all`, `runs.steer`, `args` and, inside a mission, `state`. It has no files, shell or network.
- A workflow is one more shape of a run. `subagent({ workflow: "<name>", args })` runs a saved one. The agent can also write one as it goes, as pi-subagents allows: either as a ` ```js workflow ` block in the same reply as a `subagent({ workflow: true })` call, which needs no JSON escaping, or as `subagent({ script })`. Saved workflows are `.js` files in the Profile's `workflows/` folder and in a trusted project's `.pi/workflows/`, found the same way as agents. `/workflow <name>` starts one from the composer.
- Each `runs.run` has a key. The web draws a workflow as one card with a row per key, the same rows as a run's children.
- When a workflow is resumed after a restart, it runs again from the start. A key whose child already finished returns that child's saved output instead of starting it again. This is the record from "Runs outlast the Session process", and it is all the saved state a workflow needs to pick up where it stopped.
- Not taken from pi-subagents: lanes, budgets and timeouts, gates, host commands, named workflow resources and validation without running.

### Missions

- A mission is an objective that runs work toward it: a title, an objective, the runs started for it, decisions waiting on the person, receipts such as a PR link, and a small JSON `state` its workflows can read and write.
- A mission belongs to one Session, and the server keeps it with that Session's runs. In a Project, a thread is a Session, so a thread can hold missions, and the Project page can show a thread's open decisions and receipts next to its work state. A mission is not a second kind of thread. The Project still decides which threads exist.
- The `subagent` tool gains `mission` actions to create, update and close a mission and to record a decision or a receipt. A run started with `missionId` is attached to that mission.
- An open decision shows in the fleet panel, and in a thread it shows as one of the thread's "needs you" items.
- Receipts are links only. Watching a PR stays with PR watching ([ADR 0051](0051-pull-request-watching.md)).
- Goal mode, a token budget that keeps nudging the agent until the mission is done, is left out of the first missions build. A Project coordinator already follows a thread's work state, and goal mode can be added later if that turns out not to be enough.

### Order of the build

1. Runs outlast the Session process. Workflows and missions depend on the stored run record.
2. Watchdog.
3. Workflows.
4. Missions.

Each step is its own PR, merged when CI is green, and tried on Kyma.

## Consequences

- An upgrade no longer loses runs without a trace. A run that was cut off shows as interrupted and can be resumed.
- The subagents plugin gains a server part and a small store per Session. The server keeps run records for archived Sessions like their transcripts, and they go when the Session is deleted.
- The watchdog costs one extra model call per turn that changes files, only for Profiles that turn it on.
- Workflows add a script runtime to the plugin. It reuses codemode's sandbox instead of a new one, but the API given to scripts is new code to keep small.
- Missions overlap with Projects, and the line between them is kept here: a Project decides the threads, and a mission tracks the delegated work inside one of them.
- Schedules stay with Automations, as ADR 0057 decided.
