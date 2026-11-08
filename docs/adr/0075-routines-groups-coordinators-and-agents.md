# 0075: Routines with groups, coordinators and agents

- Status: proposed
- Date: 2026-11-08
- Amends: [ADR 0057](0057-pipocas-own-subagents.md), [ADR 0058](0058-subagents-v2.md), [ADR 0059](0059-routines-and-wake-ups.md), [ADR 0061](0061-software-factory.md), [ADR 0067](0067-team-plugins-projects-and-assistant.md)

## Context

The routines plugin works ([ADR 0059](0059-routines-and-wake-ups.md), built in #555 to #567). It is hard to use for anything bigger than a daily summary:

- A routine is made by writing its JSON or by asking an agent. The file guesses a trigger's kind from which field is present. `overlap` applies only without a key, and `maxRunning` only with one. A filter tests equality, one of a list, or that a list contains a value, and nothing else.
- A routine can't name the agent that does the work. A run gets the Profile's main agent and the routine's prompt. The `workflow` field from ADR 0059 was never built.
- One routine can't start another. Routines publish no events, runs don't get the `routines` tool, and an agent never sees a webhook's secret.
- There is no place for work that needs judgment, such as splitting an epic or ordering a release. Putting routine runs into Projects would fill people's Projects with automated threads and tie two plugins together.
- Subagents can use only Pi's seven built-in tools. An agent that needs Jira or a skill can't be a step.
- Git events reach routines only through a GitHub App's webhooks. The `push` event has no changed paths, and releases, tags and deployments aren't published.

Other systems were read on 2026-11-08 ([research](../research.md#routines-for-a-software-factory)). In most of them a trigger starts one run, and the run's agent is a file with its own prompt, tools and model. Work that needs splitting goes through a coordinator that starts child runs, as Devin's managed sessions and Factory's missions do.

## Decision

### A routine has five parts

A routine file reads left to right: **when**, **only if**, **same work**, **do** and **limits** (shown 2026-11-07, not objected to). The limits are in [ADR 0076](0076-routine-runs-questions-actions-and-guards.md#guards).

```json
{
  "title": "Fix bugs labelled pipoca",
  "when": [
    {
      "kind": "event",
      "event": "git-hosts.issue",
      "where": [
        { "field": "repository", "is": "acme/shop" },
        { "field": "labels", "contains": "pipoca" }
      ]
    }
  ],
  "inputs": { "focus": { "type": "string", "default": "" } },
  "sameWork": { "key": ["repository", "number"], "whileRunning": "tell" },
  "do": {
    "kind": "session",
    "agent": "implementer",
    "prompt": "Fix the issue. {{inputs.focus}}",
    "workspace": { "kind": "event-repository" }
  },
  "limits": { "maxRunning": 3, "dailySpend": 20 }
}
```

**When.** One to ten triggers, each with a `kind`:

- `schedule`: a cron expression and a time zone.
- `once`: a time with a zone.
- `event`: a declared plugin event ([ADR 0059](0059-routines-and-wake-ups.md#other-plugins-extend-routines)). An event the server doesn't know is refused when the routine is saved, which is new.
- `webhook`: a signed POST to the routine's own URL, as today.
- `watch`: an https URL the plugin fetches on a schedule. It fires when the response changes, or when a value at a JSON path in it changes. Routines own every timer, so this lives here.
- Run now is always there, without a trigger.

**Only if.** An event or watch trigger has `where` conditions on the event's fields. Each condition is one of `is`, `isNot`, `oneOf`, `contains`, `startsWith`, `matches`, a path pattern such as `docs/**`, and `inGroup` (below). All conditions must hold. Fields are checked against the plugin's declared schema when the routine is saved, so a misspelled field can't be saved. Today only the event's name is checked, so this is new.

**A check before tokens.** A trigger may add (decided 2026-11-08) a `check`, a short script that returns true or false. It runs on the server in a QuickJS sandbox like the one workflows use in the Session ([ADR 0058](0058-subagents-v2.md#workflows)). Running it on the server is new. The script sees the event and the last few firings of the same key. It has no files or network and a short time limit. "Only if this check failed twice in a row" is written this way. This settles where such scripts run, which ADR 0059 left open.

**Inputs.** A routine may declare inputs (decided 2026-11-08). Each has a name, a type (string, number, boolean or one of a list), a default and whether it is required.

- Run now shows them as a form.
- `/routine <name> key=value` runs the routine from any chat.
- A webhook's body fills them from its `inputs` field.
- An event trigger fills them with its own `inputs` map, such as `{ "focus": "{{event.output.area}}" }` on a chained run. Nothing is filled by matching names.

**Fields in text.** The prompt, the workspace and a trigger's `inputs` map may use `{{event.<field>}}` and `{{inputs.<name>}}`. It is plain substitution with no expressions. Text that comes from an event is marked in the prompt as outside input, which is new.

**Same work.** `sameWork.key` names the event fields that make one piece of work, such as the repository and the issue number. Without a key, the whole routine is one piece of work. `whileRunning` says what a firing does when its piece of work has a run that is still running or waiting:

- `tell` sends it to that run as a message.
- `skip` drops it.
- `queue` starts a run once that run ends.

The default is `tell` with a key and `skip` without one. This replaces `overlap` and the key's separate rule. One thing changes: today a key's events go to its last Session until that Session is archived, even after its run ended. Now a firing starts a new run once the old run has ended. The 30-second quiet window and its 5-minute cap stay. A piece of work with an open pull request is the exception ([ADR 0076](0076-routine-runs-questions-actions-and-guards.md#guards)).

**Do.** Either start a Session or message one, as today.

- A started Session takes an `agent` or a `workflow` (below), the prompt, a workspace, and optionally a Profile, Environment, model and who it acts as on git ([ADR 0060](0060-technical-users-and-github-apps.md)).
- A trigger may set its own `agent` or `workflow`, so one routine runs `fix-bug` for the label `bug` and `write-docs` for `docs`, as ADR 0061 describes.
- The workspace can also be `event-repository`, the repository the event names, or `group`, the group's repositories (below).
- A message can go to a Session by id or to a Project's current coordinator by the Project's id. A personal routine messages only its owner's Projects, and a team routine only team Projects. This is the only link between routines and Projects.

The plugin reads files in the ADR 0059 shape and shows them in the form. Saving a routine writes the new shape.

### Agents come from Profiles

- `do.agent` names an agent file. A routine never defines an agent itself (decided 2026-11-08), so one agent serves people, workflows and routines, and is reviewed where it lives.
- A routine run looks in the Profile's `agents/` with its layers first, then in the repository's `.pi/agents/` on its default branch, then at the four built-in agents (`scout`, `worker`, `reviewer` and `delegate`). This differs from a person's Session, where the project's agents win ([ADR 0057](0057-pipocas-own-subagents.md)). An issue or pull request must not be able to swap the agent a routine runs.
- The run's Session starts as that agent. The agent's prompt is added to the system prompt, its tool list limits Pi's tools, and its model and thinking level are used. The tools a run needs always stay: `end_run`, `propose`, `ask_user`, `memory` and, for a coordinator, `start_run`, `message_run`, `list_runs` and `stop_run`.
- A model is chosen in this order: the agent's, then the routine's, then the Profile's default (decided 2026-11-08). The routine's model is a default for agents that set none.
- `do.workflow` names a saved workflow ([ADR 0058](0058-subagents-v2.md#workflows)). The run's Session starts it at once, as `/workflow <name>` would, with the inputs as its `args`. An agent is one worker. A workflow is a script that starts agents step by step.
- There is no routine-level system prompt. What a run does lives in its agent file.

### Agents may use every tool their Profile has

This amends ADR 0057, where a subagent gets only Pi's seven built-in tools (decided 2026-11-08).

- An agent's `tools` may name any tool its Profile gives: Pi's own, an extension's, and an MCP server's by Pi's name for it, such as `mcp__jira__search` or `mcp__jira__*` for all of one server's tools. New `mcp` and `skills` lists pick which of the Profile's MCP servers and skills it gets. Pi's MCP extension normally offers MCP tools only through code mode, where the agent writes a script that calls them. A child's named MCP tools are offered to it directly, under the names Pi gives them, shortened as Pi does when too long.
- An agent only narrows what its Profile has. It doesn't add an extension or an MCP server of its own. Logins then stay with the Profile and its person or team, in one place.
- A subagent loads only what it names. Pi already records which extension registered which tool (`Extension.tools`). A child that names an extension's tool starts with `noExtensions` and loads only that extension, through `additionalExtensionPaths` or `extensionFactories`. That is a fresh instance with its own state. Pi's `extensionsOverride` isn't enough, since it filters extensions after they have all loaded.
- Skills come through Pi's `skillsOverride`, which picks which skills a session sees.
- MCP is one extension the session host adds. A child that names MCP tools gets that extension with only the servers it named, connected on the child's first call to one of their tools, with the same logins.
- A child that names nothing extra starts as cheaply as today.
- Children don't share the parent's tool objects, even though Pi's `customTools` option would allow it. Extensions keep state per Session, and a child would mix its state with the parent's.
- Before this is built, a short experiment measures what loading one extension again costs a child.

### Profiles show agents and workflows

- A Profile's page, and every layer's page ([ADR 0074](0074-profile-layers-you-can-see-and-turn-off.md)), gets Agents and Workflows sections next to Skills (decided 2026-11-08). Each lists its items, including inherited ones with their source, and adds and edits them.
- An agent's editor shows its description, model, thinking level, tools, MCP servers, skills and prompt. A workflow's editor shows its script and the agents it starts.
- A team's factory is usually a team Profile with a set of agents and workflows, such as a triager, planner, implementer, reviewer and docs writer. Changing how the factory works is an edit to that Profile, not to each routine.

### Routine groups

- A routine group gathers routines that work on the same thing (decided 2026-11-08). It belongs to the routines plugin. Projects don't change, and routine runs never appear in a Project.
- A group has a title, an owner (a person or the team), a set of repositories, memory, defaults for its routines (Profile, Environment and who it acts as) and a budget ([ADR 0076](0076-routine-runs-questions-actions-and-guards.md#guards)).
- A group is a folder under its owner's folder in the routines config folder, `<owner>/<group>/`, holding `group.json` and its routines' files. A routine outside any group works as today. A personal routine can be only in its owner's groups, and a team routine only in the team's.
- The group's repositories can be the scope of a condition, `{ "field": "repository", "inGroup": true }`, and a run's workspace, `{ "kind": "group" }`.
- A group's memory is a folder in the plugin's data folder, not the config folder, since runs write it. Every run in the group reads it as files. A run adds to it with the `memory` tool, which appends a dated note to a file in that folder, such as `decisions.md`. The plugin writes the notes one at a time, so runs working at once don't overwrite each other.
- The group's page is its board: its routines, its runs by piece of work, what waits on someone, and what it cost.
- A group can be exported as one archive (decided 2026-11-08) that also carries the agent and workflow files its routines name. Another server imports it and asks which Profile receives the agents. This is the factory bundle ADR 0061 left for later. A catalogue of bundles can come after.

### A coordinator for work that needs judgment

- A group may have one coordinator: a routine with `"coordinator": true` (decided 2026-11-08). Its limits are in `group.json` under `coordinator`, as `{ "atOnce": 5, "askAbove": 3 }`. Its key is the group and `sameWork` is ignored, so it keeps one Session that hears every event its triggers catch.
- Its runs get tools for the group's runs: `start_run` (an agent or workflow, a prompt, a workspace, a key and inputs), `message_run`, `list_runs` and `stop_run`. A started run uses the group's defaults and shows on the board with the coordinator as its cause.
- When a run it started ends or starts waiting on someone, the coordinator gets a message.
- Its behaviour is its agent file, such as a `planner` agent, and the group's memory is its long-term memory.
- Limits:
  - `coordinator.atOnce` caps how many runs it started may go at once.
  - Runs it starts can't start runs.
  - It spends from the group's budget.
  - `coordinator.askAbove` sets how many runs it may start in one turn before it asks ([ADR 0076](0076-routine-runs-questions-actions-and-guards.md#runs-can-wait-for-a-person)).
- A coordinator lives for weeks, so it is swapped, not compacted, as Project coordinators are ([ADR 0052](0052-the-assistant-as-a-project.md#coordinators-are-swapped-not-compacted)). A fresh Session starts from the group's memory and the list of open runs. The run time limit doesn't apply to it.
- When to use which:
  - Fixed steps go in a workflow in one run.
  - One job after another is a chain (below).
  - Splitting, ordering and reacting to results is the coordinator's.
- A coordinator spends a model turn on each event and each run update. It is for epics and releases, not for every issue.

### One routine can follow another

- Each run that ends publishes `routines.run_ended` (decided 2026-11-07). It carries the routine, its group, the outcome, the one-line summary, the output, the key, the Session and the chain depth.
- Any routine of the same owner can trigger on it with conditions, like any event. A team routine hears only the team's routines, and a personal routine only its owner's.
- `end_run` takes an optional `output`, a small JSON object. A routine may declare its output's fields in `output`, such as `{ "area": "string", "ready": "boolean" }`: string, number, boolean or a list of them. When it does, `end_run` refuses output that doesn't fit, and routines that follow it can pick those fields in the condition picker. When it doesn't, the summary and any output go on unchecked.
- A run started by `routines.run_ended`, or by a coordinator, has the chain depth of the run before it plus one. A run started any other way has depth 0. A run at depth 5 still runs. A run that would be at depth 6 is skipped and its owner gets one notice, so A to B to A can't loop forever.
- A routine's page shows what feeds it and what it feeds, built from these triggers.
- ADR 0059 kept routines from making routines, and that stays. Runs, coordinators included, don't get the `routines` tool. Starting a run is not making a routine.

### Results can go somewhere by themselves

- A routine's `results` may name where a run's result goes when the run ends (decided 2026-11-08). The agent doesn't post it. A destination can be a Slack channel, an email address, a comment on the event's issue or pull request, or a file in a repository. ADR 0059 called these sinks and left them for later.
- Plugins contribute these destinations, each declared with a JSON Schema for its settings. The routines plugin delivers the summary and output.
- An event trigger may `collect` on a schedule instead of firing for each event, as `"collect": { "cron": "0 17 * * 5" }`. Matching events gather, and the routine runs once per schedule with all of them. Nothing gathered means no run. This is how a digest works.

### Plugins extend routines

- Plugins contribute event types (as today, decided 2026-11-08), result destinations, the actions runs may propose ([ADR 0076](0076-routine-runs-questions-actions-and-guards.md#allowed-actions)) and named checks a trigger can use. Each is declared with a JSON Schema, so the form offers it in a picker.
- An internal system becomes a trigger and a destination by writing one small plugin. Jira, Linear, Sentry and PagerDuty are examples.

### New events

- `git-hosts` adds the changed paths to `push` (decided 2026-11-08), and publishes `release`, `tag` and `deployment` from App webhooks, as its other events are.
- When an App has no public URL, `git-hosts` polls with the App's installation token and publishes the same events, as ADR 0060 already said. Today the poller publishes none, so this is new work.

### Making routines

- The Routines page starts from one sentence, such as "When a pull request merges in shop or api, update the docs in docs-site" (decided 2026-11-08). Pipoca drafts the routine and shows it back as a sentence with chips to change. The defaults show as plain lines, and everything else is under "More". A step picker (when, what, check) and the JSON stay for people who prefer them.
- The Team assistant gets the `routines` tool for team routines, as ADR 0067 meant. Today the tool is limited to personal owners. Creating, changing or removing a routine still asks first ([ADR 0050](0050-assistant-permission-prompts.md)).

### Not now

- A graph editor in the style of n8n. Groups, chains and coordinators cover it. A group's page can draw its routines as a graph later, read only.
- pi-durable. Version 1.5.0 has durable tasks that wait on child tasks, the shape of waiting runs and coordinators. It brings its own conversations and storage, and pi-coding-agent, which runs every Session, doesn't use it. One use is worth an experiment later: a run that needs no workspace, such as triage, run as a small durable conversation on the server instead of on a runner.
- Kubernetes Jobs or CronJobs. The server keeps the schedule, and a run is a Session on its Environment. On Kubernetes that is already a fresh pod per run.

### Starting values

These are the numbers the decisions above need. The trigger count and the chain depth are fixed limits. The rest are defaults a routine or group can change.

| What                                                  | Value     |
| ----------------------------------------------------- | --------- |
| Most triggers per routine                             | 10        |
| Shortest `watch` interval                             | 5 minutes |
| `check` time limit                                    | 50 ms     |
| Earlier firings a `check` sees                        | 10        |
| Deepest chain                                         | 5         |
| Coordinator's runs at once                            | 5         |
| Runs a coordinator starts without asking, in one turn | 3         |

## Consequences

- A team can build a factory from a team Profile of agents and workflows, a group with its repositories and memory, and a few small routines. A coordinator is added only where judgment is needed.
- Routine files change shape. Old files keep working until they are saved again.
- Projects stay as they are. Routines depend on the kernel and on git-hosts, usage, ask and the plugins that contribute destinations and actions. They depend on projects only to message a coordinator.
- Subagents become as capable as their Profile, at the cost of loading extensions per child. The experiment decides whether that is cheap enough.
- A coordinator spends tokens on every event and run update it hears, from the group's budget.
- The session host starts a Session as a named agent, and the subagents plugin's agent format gains `mcp` and `skills`.
- The routines plugin gains a QuickJS sandbox on the server.
