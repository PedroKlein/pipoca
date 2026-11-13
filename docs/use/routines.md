---
title: Routines
description: Run a prompt on a schedule, on an event or from a webhook, with guards on what each run may do.
sidebar:
  order: 7
---

A routine runs a prompt by itself: on a schedule, when something happens, such as a new pull request or a Slack message, or when something calls its webhook (the `routines` plugin, [ADR 0059](../adr/0059-routines-and-wake-ups.md), [ADR 0075](../adr/0075-routines-groups-coordinators-and-agents.md), [ADR 0076](../adr/0076-routine-runs-questions-actions-and-guards.md)). Each time it fires, a run starts a new Session of its own or sends a message to one of yours. Routines need the `subagents` plugin on.

For one-off reminders inside a Session, Pi uses a wake-up instead: see [Sessions](sessions.md#come-back-later).

## Make one

- **Ask any Session.** Its `routines` tool restates the routine in plain words and asks you before it creates, changes or deletes one, and a new routine runs once at once as a test. A routine's own runs can't make routines.
- **On the Routines page**, with a form that lists the events the enabled plugins publish and their fields.
- **By hand.** A routine is a JSON file of yours in the server's config folder, at `routines/<your user id>/<name>.json`. The server reads it again when it changes.

## What a routine holds

```json
{
  "title": "Fix failing CI",
  "when": [
    {
      "kind": "event",
      "event": "git-hosts.check",
      "where": [{ "field": "conclusion", "is": "failure" }]
    }
  ],
  "sameWork": { "key": ["repository", "branch"] },
  "do": {
    "kind": "session",
    "prompt": "{{event.name}} failed on {{event.branch}} of {{event.repository}}. Find out why and fix it.",
    "workspace": { "kind": "event-repository" },
    "agent": "worker"
  },
  "limits": { "maxRunning": 3, "timeLimit": "1h" },
  "actions": { "pullRequest": 1 }
}
```

Events from a git host, such as `git-hosts.check`, come from a GitHub App or machine user an admin registers ([Technical users](../admin/git-hosts.md#bots)). Slack and email events come from their plugins ([Slack and email](slack-and-email.md)).

### `when`: triggers

One to ten triggers, each with a `kind`:

| Kind       | Fires                                                                                              |
| ---------- | -------------------------------------------------------------------------------------------------- |
| `schedule` | On a `cron` expression in a `timeZone`.                                                            |
| `once`     | At an `at` time, with a zone.                                                                      |
| `event`    | When a plugin publishes the `event` it names, such as `git-hosts.pull_request` or `slack.mention`. |
| `webhook`  | When something posts to the routine's webhook URL.                                                 |
| `watch`    | When an https `url`, fetched `every` so often (at least `"5m"`), changes.                          |

An event trigger's `where` conditions must all hold, each naming a `field` with one of `is`, `isNot`, `oneOf`, `contains`, `startsWith` or `matches` (a path pattern such as `docs/**`). A field that is a list holds a condition when one of its items does. Saving refuses an event no enabled plugin declares and a field its event doesn't have.

More on triggers:

- **Windows.** A trigger's `windows`, such as `[{ "days": "mon-fri", "from": "09:00", "to": "18:00", "outside": "wait" }]`, limit when it fires, in the schedule's time zone or the window's `timeZone`. Outside them a firing waits for the next window (`wait`, the default) or is dropped (`skip`).
- **Watches.** With a `path` such as `items.0.version`, a watch fires when the value there in the JSON response changes. The first fetch only looks. Its firing's fields are `url`, `status`, `value` and `previous`, and it never fetches a private or loopback address.
- **Checks.** An event or watch trigger's `check` is a short script that returns true or false before a run spends tokens, such as `return event.conclusion === "failure" && earlier[0]?.conclusion === "failure"`. It runs on the server in a QuickJS sandbox with no files or network for at most 50 ms, and sees `event` and `earlier`, the last 10 firings of the same piece of work, newest first. A check that throws, returns something else or runs too long counts as false, and the routine's page shows how each check went last. `{ "use": "git-hosts.failedTwice" }` uses a check a plugin offers, with its settings in `with`.
- **Digests.** An event trigger with `"collect": { "cron": "0 17 * * 5" }` (and an optional `timeZone`) gathers its events and runs once per schedule with all of them, at most 50, and not at all when none came.
- **Who can fire it.** An event from a git host fires only when its author is a member of the repository, unless a `where` condition names `member` or `sender`, such as `{ "field": "member", "oneOf": [true, false] }` for anyone.

### `inputs`

Named inputs, each a `string`, `number`, `boolean` or `oneOf` a list of `values`, with a `default` and whether it is `required`. **Run now** asks for them in a form, a webhook's body fills them from its `inputs` field, and a trigger fills them from its own `inputs` map. The prompt and workspace can use `{{event.<field>}}` and `{{inputs.<name>}}`, and text from an event is marked in the prompt as outside input.

### `sameWork`: one piece of work

`sameWork` has a `key`, the event fields that name one piece of work, such as `["repository", "number"]`, and `whileRunning`:

- `tell` sends a firing to its piece of work's run that is still going.
- `skip` drops it.
- `queue` runs it once that run ends.

The default is `tell` with a key and `skip` without one, when the whole routine is one piece of work. Once a run has ended, the next firing starts a new one. Events with the same key that come within 30 seconds of each other go as one firing, or after 5 minutes at most when they keep coming. A piece of work whose run opened a pull request that is still open doesn't start another run: its new firings go to that run's Session.

### `do`: what a run does

- **Start a Session**: `"kind": "session"`, a `prompt` and a `workspace`, which can be `{ "kind": "event-repository" }` for the repository the event names, and optionally an `environment`, `profile` and `model`. A routine that clones from a [private host](../admin/private-hosts.md) needs an Environment that reaches it, and its page warns and offers one when it names one that can't.
- **Message one**: `"kind": "message"`, a `prompt` and a `session`.

A started Session can name an `agent` or a `workflow`:

- An `agent` is an agent file's name. The run looks in the Profile's `agents/` first, then in the repository's `.pi/agents/` on its default branch, then at the built-in agents, so an issue or pull request can't swap it. Its prompt is added to the run's, its `tools` limit the Session's tools (`end_run` and `ask_user` stay), and its `model` and `thinking` come before the routine's `model`. A run whose agent can't be found fails and says so.
- A `workflow` is a saved workflow's name. The run starts it at once, as `/workflow` would, with the inputs as its `args`, and then needs no `prompt`.

A trigger can set its own `agent` or `workflow` in place of `do`'s, such as `fix-bug` for the label `bug` and `write-docs` for `docs`.

`"as": "<name>"` in `do` makes the run act as a [technical user](../admin/git-hosts.md#bots), such as a GitHub App.

### `limits`: guards

| Limit        | What it does                                                                                                                                                                  | Default |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `maxRunning` | How many runs go at once. The others wait as queued.                                                                                                                          | `3`     |
| `timeLimit`  | Fails a run that has been running this long, such as `"30m"`, and stops its Session.                                                                                          | `"2h"`  |
| `retries`    | Starts a failed run again after 1 and then 10 minutes. A run with its retries counts as one failure.                                                                          |         |
| `stopAfter`  | A date such as `"2027-02-01"`. Pauses the routine after that day.                                                                                                             |         |
| `dailySpend` | Pauses the routine until the next day once its runs spent this much today, in the currency of the usage plugin's prices, and tells its owner. Only team work is priced today. |         |

### `results`: where a run's result goes

`results` lists where each run's result, its summary, goes when the run ends, without the agent posting it, such as `[{ "to": "slack.channel", "with": { "channel": "C0123" } }]`. The destinations are `slack.channel` (`channel`, `bot`), `email.mail` (`to`, `subject`, `mailbox`), `git-hosts.comment` (on the event's issue or pull request, or the `repository` and `number` it names) and `git-hosts.file` (`repository`, `path`, `branch`), each written as the identity the run acts as. A result goes out for runs that end done, unless `on` lists other outcomes from `done`, `nothing`, `blocked`, `failed` and `stopped`.

### `actions`: what outside input may make it write

A run fired by outside input, an event or a webhook, proposes instead of writing. Its git only reads (with a GitHub App, a read-only installation token; other tokens only make its workspace), it gets no tool that posts, such as `slack_post`, and it has a `propose` tool for the actions the routine lists in `actions`, each with a maximum per run, such as `{ "pullRequest": 1, "comment": 3, "labels": 5 }`, or `{ "comment": { "max": 3, "approve": true } }` for a person to approve each first. Anything else is refused.

The actions are `git-hosts.pullRequest` (pushes the commits on the run's branch and opens a pull request, or updates the one it opened, and watches it), `git-hosts.comment`, `git-hosts.labels`, `git-hosts.closeIssue`, `git-hosts.requestReview`, `slack.post` and `email.send`, named in full or by the part after the dot. Once the run's turn ends, the server applies each proposal as the identity the run acts as.

`"proposes": "never"` lets runs write directly, and the page then warns that strangers' text can make it write. `"always"` makes scheduled and Run now runs propose too.

## Runs

Each firing is a run with its outcome. The agent ends a run with `end_run` as done, nothing to do or blocked, with a one-line summary shown beside the run ([ADR 0061](../adr/0061-software-factory.md#guards)). A run whose turn ends without it shows as stopped, and one can also be failed, skipped or queued. Open a run to see its Session.

- A run's row lists its proposals, exactly as they would be written, as applied, failed, refused or waiting for approval with **Approve** and **Reject** buttons. A run with an action waiting for approval ends only after the answer applies or rejects it, and nobody answering in time rejects it.
- **Dry run**, beside **Run now**, shows the proposals and never applies them. **Replay** on a run fires its events again at the routine as it is now. Saving a new event routine runs it once on the newest event of the last 7 days that it matches, as a dry run when it has actions.
- Firings missed while the server was down become one run once it starts. Three runs in a row that failed or couldn't start pause the routine until you resume it. A paused routine's page says why and when it resumes.

### Runs that wait for a person

A run whose agent asks with `ask_user` waits instead of holding its turn open. The question goes back to the issue, Slack thread or mail the work came from and to Needs you, and the run's row shows the question and who it is for. Its Session and key stay, so new events for the same work still reach it, it counts towards `maxRunning`, and its `timeLimit` doesn't run while it waits. The answer, or the question's default once `questions.timeout` (24 hours unless set) runs out, comes to the run as a message and it runs again.

A personal routine asks its owner. A team routine asks the `person` in `questions.ask`, or an `onCall` list of its group, such as `{ "ask": { "onCall": "triage" }, "timeout": "4h" }`, and otherwise its group's first on-call list, and otherwise whoever made it.

## Webhooks

A routine with a webhook trigger shows its URL and secret on its page. POST JSON there, signed as `sha256=<HMAC-SHA256 of the body in hex>` in `X-Pipoca-Signature` or `X-Hub-Signature-256` (as GitHub signs its webhooks), and the body arrives as a `routines.webhook` event.

So that a captured delivery can't be sent again, each delivery needs either an `X-Pipoca-Delivery` id (GitHub sends its own as `X-GitHub-Delivery`) or an `X-Pipoca-Timestamp` with the Unix time in seconds, and then you sign `<timestamp>.<body>` instead. A delivery with neither is refused. A delivery whose id came already in the last day is refused, unless it failed the first time, and one signed more than 5 minutes from the server's time is refused. The URL must be reachable from the sender, which a laptop install usually isn't.

## Groups

Routines that work on the same thing can share a group: a folder `routines/<owner>/<group>/` with a `group.json` and the routines' files, made on the Routines page with **New group** or by picking a group in a routine's editor. `group.json` holds:

- a `title` and its `repositories` (`owner/name` on github.com, `host/owner/name` or an https address),
- `defaults` for its routines' `profile`, `environment` and `as`, and `limits` that its routines' own override,
- a `budget` with a `dailySpend` that pauses the whole group until the next day,
- its `onCall` lists, such as `"onCall": { "triage": ["ana", "bo"] }`, a person each ISO week in turn,
- its `editors`.

In a group, a condition `{ "field": "repository", "inGroup": true }` holds for the group's repositories, and a workspace `{ "kind": "group" }` checks all of them out side by side. Every run in a group reads the group's memory, Markdown files the server keeps, and adds a dated note with the `memory` tool.

The group's page is its board: its routines, what waits on someone, its runs by piece of work, what each routine spent today and how often its runs succeeded. **Export** gives the group as one `.tar.gz` with its files and the agent and workflow files its routines start from their Profile, never a secret. **Import** on another server asks which Profile receives them and keeps the agents that Profile has already.

## Chains and coordinators

Each run that ends publishes `routines.run_ended`, with the routine, its group, the outcome, the summary, the output, the key and the Session. Another routine of the same owner can trigger on it, with a condition `{ "field": "routine", "is": "<name>" }`, so one routine follows another. `end_run` takes an optional `output`, a small JSON object, whose fields a routine may declare in `output`, such as `{ "area": "string", "ready": "boolean" }`; then `end_run` refuses output that doesn't fit. A run at the end of a chain 5 deep still runs, and one that would be 6 deep is skipped, with one notice to its owner, so A to B to A can't loop forever.

A group may have one coordinator, a routine with `"coordinator": true`, for work that needs judgment, such as an epic or a release ([ADR 0075](../adr/0075-routines-groups-coordinators-and-agents.md#a-coordinator-for-work-that-needs-judgment)). It keeps one Session that hears every event its triggers catch, and its runs get `start_run`, `message_run`, `list_runs` and `stop_run` for the group's runs. When a run it started ends or starts waiting on someone, it gets a message. Its limits are in `group.json` under `coordinator`: `atOnce` caps how many runs it started go at once (5 by default), and `askAbove` how many it may start in one turn before it asks (3). Runs it starts can't start runs. Like a Project's coordinator, it is swapped for a fresh one instead of compacted, starting from the group's memory and its open runs.

Fixed steps go in a workflow in one run, one job after another in a chain, and splitting, ordering and reacting to results is a coordinator's.

## Team routines

Anyone on a team server can make a team routine. It runs on a team Profile and Environment, and acts as a technical user that admins let the team use ([ADR 0067](../adr/0067-team-plugins-projects-and-assistant.md#team-routines)). A team routine's `editors`, people by id or name, are the only ones who may change or remove it; anyone on the team may otherwise. Its page says who made it and who changed it last, with every change in its history. A team routine reaches a private host only through a team Environment, and watches a URL on one only when an admin allowed it.

## Older files

A file in the older shape, with `triggers`, `run`, `overlap` and `key`, still loads, and saving it writes the new shape.
