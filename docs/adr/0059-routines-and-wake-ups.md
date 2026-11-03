# 0059: Routines and wake-ups

- Status: accepted
- Date: 2026-11-03

## Context

Nothing in Pipoca starts work on its own. A Session can't say "check this again in 20 minutes", and a person can't say "every weekday at 08:00, summarise new issues" or "when a pull request merges, update the changelog". Automations were left for later ([vision](../vision.md#later)), and subagents left schedules to them ([ADR 0057](0057-pipocas-own-subagents.md#not-planned)).

What a plugin can do already covers most of this. A server plugin can start a Session for a person with `sessions.start`, start a turn or queue a follow-up with `sessions.send`, hear kernel events (`TurnEnded`, `SessionWaiting`, `SessionStateChanged`, `SessionArchived`, `ToolCalled`) and any plugin's events with `events.subscribe`, register tools, and serve routes. Built-in plugins can also serve routes that need no sign-in. What is missing is something that owns time and triggers.

Hermes Agent and OpenClaw both run scheduled agent work as a job record plus a run record, with a fresh session per run and rules for missed and failed runs ([research](../research.md#automations-and-software-factories)). Claude Code's cloud sessions have a `send_later` tool that schedules a message to the session itself. Cursor and Factory automations are a trigger, a prompt and a repository, and pause after repeated failures.

pi-durable 1.5.0 has durable sleeps and tasks with checkpoints. Its sleeps live inside its own agent harness, and pi-coding-agent still doesn't run on it, so it is not the engine here ([research](../research.md#pi-durable)).

## Decision

### One `routines` plugin

- A built-in `routines` plugin owns every timer and trigger (decided 2026-11-02). Wake-ups are part of it, not a plugin of their own: a wake-up is a one-time routine whose target is the Session that asked for it. One engine fires both, with one way to deliver and one run history.
- The kernel gets no scheduler. If another plugin needs timers later, it schedules through routines, or the engine moves into the kernel then.

### Wake-ups

- Every Session gets a `schedule_wakeup` tool. It takes a delay or a time, the message to wake up with, and a short reason. The same tool lists and cancels the Session's pending wake-ups.
- At that time the plugin sends the message to the Session with `sessions.send`, drawn as a notice ("Woke up: checking CI on #552") so it doesn't read as something the person typed.
- A wake-up is 1 minute to 30 days ahead. A Session has at most 10 pending and at most 48 delivered a day, so an agent that keeps waking itself can't run up a bill. Archiving a Session cancels its wake-ups.
- The Session page lists pending wake-ups, and the person can cancel them.
- Wake-ups are rows in the plugin's SQLite store, not config files, because they are short-lived.

### Routines belong to a person

- A routine is "when this happens, run that", owned by one person (decided 2026-11-02). Routines that several people own, such as a team's, come with team features ([ADR 0054](0054-team-sessions.md)).
- A routine is a JSON file in the plugin's config folder, one folder per person ([ADR 0039](0039-plugin-config-files.md)). The person edits it in the UI or by hand, or an agent writes it. A routine names the Profile it runs on and doesn't live inside one, so copying a Profile doesn't copy schedules that spend tokens.
- A routine has:
  - **Triggers**, one or more: a schedule (a cron expression with a time zone, or a single time), a Pipoca event with a filter on its fields, or a webhook with an HMAC secret.
  - **A run**: start a new Session (Profile, Environment, repository, model, prompt, and optionally a subagent workflow), or message one named Session.
  - **A key** made from the event's fields, such as the repository and pull request. An event whose key already has a running Session is sent to that Session as a message instead of starting another. Without a key, each firing is its own run.
  - **Overlap**: skip a firing while the last run is still going, or queue one.
  - **Who it acts as**: the person, which is the default, or a technical user they may use ([ADR 0060](0060-technical-users-and-github-apps.md)).
- The run's Sessions are owned by the plugin under the routine's key, so they stay off the person's Session list and open from the routine's page.

### Runs

- Each firing is a row: when it fired, which trigger, the key, the Session it started or messaged, and an outcome of `ok`, `nothing`, `failed`, `skipped` or `blocked`, with a reason. A routine's page lists its runs.
- A run's Session gets a short addition to its system prompt: the final reply is the result, not a plan. The agent calls `report_nothing` when there is nothing to do, and the run is then `nothing` and quiet. Questions the agent asks go to Needs you as they do in any Session.
- Before a run spends tokens, the plugin checks that the Environment has or can get a runner, the Profile exists and the model login works. If not, the run is `blocked` and the person gets one notice.
- A failure notifies the person once per error. Three failed runs in a row pause the routine and say why.

### Firing exactly once

These come from Hermes, OpenClaw and pi-durable.

- Firing and delivering are separate steps with the state saved between them. After a restart a step runs again from its start, and a delivered run is never delivered twice.
- Each delivery carries a request id made from the routine and the firing time. The kernel already ignores a chat message whose request id it has seen; the plugin `sessions.send` gains an optional request id to pass it through. This is the one kernel change.
- The plugin arms one timer for the earliest due firing and re-arms it when that changes. It doesn't poll.
- Missed firings while the server was down become one catch-up run, not a burst. Overdue runs are not started while the server is starting.
- Events with the same key within 30 seconds are sent as one message or start one run. The quiet window ends at 5 minutes, so a busy pull request still gets through.
- A run whose Session dies five times without progress is parked and reported once.

### Agents can make routines

- Sessions get a `routines` tool with one action field: create, list, update, pause, run and remove. Creating one asks the person first ([ADR 0050](0050-assistant-permission-prompts.md)), since it spends tokens on a schedule.
- On create, the agent restates the schedule in plain words ("every weekday at 08:00 Berlin time") and runs the routine once at once as a test.
- The tool is not available inside a routine's own runs, so routines can't create routines.

### Other plugins extend routines

- **Events.** Any plugin event (`<plugin>.<name>`) can trigger a routine. A plugin declares the event types it publishes, each with a JSON Schema of its fields, so the routine editor can offer them in a picker with filters instead of names typed by hand. This is the first point where plugins contribute to another plugin.
- **Sinks**, where a run's result goes without the agent posting it ("send the final reply to #team"), and **run targets**, such as filing a run as a thread in a Project, come later, once a plugin needs them.

### Not now

- A graph editor in the style of n8n. A routine is the one-node case of a graph, and the editor can grow from it.
- Scripts that run before the model to decide whether to wake it. Where such code runs is a trust question to settle first.
- Feeding one routine's output into another.
- pi-durable as the engine. If a use appears, for example a graph editor that needs durable steps, it is looked at again (decided 2026-11-03).

## Consequences

- People can schedule and trigger work, and Sessions can come back to something later, without the kernel growing a scheduler.
- A wake-up can wait for a Session's runner to come online. On Kubernetes, waking an idle Session starts a pod.
- Every run spends the tokens of whoever it acts as. Caps, pausing after failures and `report_nothing` keep that visible and bounded.
- Webhook triggers need a URL reachable from the sender. A solo install on a laptop doesn't have one, and the chart's gateway must list the webhook path.
- Plugins gain a way to declare their events, which routines read and others can later.
