# 0076: Routine runs: questions, allowed actions and guards

- Status: proposed
- Date: 2026-11-08
- Amends: [ADR 0051](0051-pull-request-watching.md), [ADR 0059](0059-routines-and-wake-ups.md), [ADR 0060](0060-technical-users-and-github-apps.md), [ADR 0061](0061-software-factory.md), [ADR 0062](0062-slack-and-email.md), [ADR 0064](0064-one-team-per-server.md), [ADR 0065](0065-team-hub-and-team-conversations.md), [ADR 0066](0066-team-credentials-and-usage.md), [ADR 0067](0067-team-plugins-projects-and-assistant.md)

## Context

A routine run is a Session nobody is watching ([ADR 0059](0059-routines-and-wake-ups.md)). That leaves three gaps a team's factory can't work around:

- **A run can't wait for a person.** The `ask_user` tool holds the turn open until someone answers inside the run's Session, and that Session is off the Session list. If the turn ends instead, the run is marked `stopped`. `end_run` with `blocked` ends the run, so an answer has nowhere to go.
- **A run fired by text anyone can write has the same reach as one the owner started.** Issues, comments, Slack messages, mail and webhook bodies can carry instructions. ADR 0061 and ADR 0062 asked for "fewer tools" for such runs without saying which.
- **The guards ADR 0061 listed aren't built**: a cap on daily spend, "done when the required checks pass", and "no second run for a key with an open pull request". Nothing says how long a run may take, when a routine stops, or how to try one safely.

Other systems were read on 2026-11-08 ([research](../research.md#routines-for-a-software-factory)). Linear's agent sessions post an _elicitation_, wait in `awaitingInput`, and resume when the person replies. n8n's send-and-wait asks on Slack or mail, with a timeout and a default path. GitHub Agentic Workflows give the agent read-only access and apply the writes it declares ("safe outputs") in a separate step.

## Decision

The settings below sit in the routine file next to the parts in [ADR 0075](0075-routines-groups-coordinators-and-agents.md#a-routine-has-five-parts):

```json
{
  "when": [
    {
      "kind": "event",
      "event": "git-hosts.issue",
      "windows": [
        { "days": "mon-fri", "from": "09:00", "to": "18:00", "outside": "wait" }
      ]
    }
  ],
  "questions": { "ask": { "onCall": "triage" }, "timeout": "24h" },
  "actions": { "pullRequest": 1, "comment": 3, "labels": 5 },
  "limits": {
    "maxRunning": 3,
    "dailySpend": 20,
    "timeLimit": "2h",
    "retries": 2,
    "stopAfter": "2027-02-01"
  }
}
```

### Runs can wait for a person

- A run that asks a question becomes **waiting**, a new run state between running and ended (decided 2026-11-08). Its turn ends, and the run isn't marked `stopped`. Its Session stays, and so does its key, so new events for the same work still reach it.
- This is new work in two plugins. `ask_user` ends the turn instead of holding it open, and the routines plugin stops marking a run `stopped` when its turn ends while a question is open.
- A question uses any `ask_user` form: pick one, pick several, a scale, a ranking, text or a number. Approve or reject is a pick-one with those two answers.
- The question goes back where the work came from: a comment on the issue or pull request, a reply in the Slack thread, or a reply to the mail. It also shows in Pipoca's Needs you and on the routine's page and its group's board, with a push notification. A plugin that publishes events can declare how to post a question back to where one came from. git-hosts, Slack and email will.
- On git hosts the question is posted by the technical user the run acts as. A run acting as a person posts only if that person turned on "reply as me" ([ADR 0051](0051-pull-request-watching.md#the-person-chooses)). Otherwise the question stays in Pipoca.
- An answer from any of those places reaches the run as a message, and the run goes back to running.
- Who can answer:
  - the routine's owner and the people the question is for, anywhere;
  - members of the repository on a git host, and members of the Slack channel;
  - on mail, only the owner's and the assignees' addresses, since anyone can be copied on a mail.
- Each question has a timeout, which is new: ADR 0065's named-question timeout was never built. When it runs out, the run takes the question's default: an answer the question declared, or `end_run` with `blocked`.
- Who is asked, set in `questions.ask`:
  - A personal routine asks its owner.
  - A team routine may name a `person`, or an `onCall` list from its group. A group's `group.json` lists its on-call lists, each a rotation of people by week.
  - Without either, the group's first on-call list is asked, and without one, the person who made the routine. This amends [ADR 0065](0065-team-hub-and-team-conversations.md), whose named questions go to the person who started the work when they time out.
- `end_run` with `blocked` stays for "I can't do this at all". The owner can open the run's Session and steer it at any time, as with any Session.

### Allowed actions

- A run fired by **outside input** doesn't write to the outside world itself (decided 2026-11-08). Outside input is an issue, comment, pull request, review, Slack message, mail or webhook body. Its git token reads but can't push, and it gets no tools that post.
- It proposes what it wants written with the `propose` tool. The routines plugin applies each proposal after the run's turn ends.
- The actions are: open or update a pull request from the run's workspace branch, comment, add or remove labels, close an issue, request a review, post to Slack and send mail. Plugins contribute more ([ADR 0075](0075-routines-groups-coordinators-and-agents.md#plugins-extend-routines)).
- A routine's `actions` lists the actions its runs may propose, each with a maximum per run, such as "at most one pull request and three comments". The plugin refuses anything else.
- Applying a pull request is new work on the server. It takes the commits on the run's workspace branch from the runner and pushes them with the token of the identity the run acts as ([ADR 0060](0060-technical-users-and-github-apps.md)). Other actions are applied with that identity's token through the plugin that contributed them.
- Pull request watching ([ADR 0051](0051-pull-request-watching.md)) works the same way for these runs. Fixes for CI and replies to reviews are proposed and applied, and the routines plugin registers the watch for the pull request it opened.
- Any action can need approval, as `{ "comment": { "max": 3, "approve": true } }`. The run then waits, as above, and the approval shows exactly what will be written.
- Runs fired by outside input propose by default. The owner can let a routine's runs write directly instead, and its page then warns that strangers' text can make it write. The owner can also make runs fired by schedules or Run now propose.
- This replaces "event-started runs get fewer tools" in [ADR 0061](0061-software-factory.md#guards) and [ADR 0062](0062-slack-and-email.md#untrusted-input).

### Guards

These were agreed on 2026-11-08. A routine's `limits` holds `maxRunning`, `dailySpend`, `timeLimit`, `retries` and `stopAfter`. A group's `group.json` has the same `limits` block as defaults for its routines, and a `budget` with a `dailySpend` for the group as a whole. Time windows belong to a trigger.

- **Who can fire it.** ADR 0061's rule stays: an event trigger from a git host fires only for members of the repository. A condition on the event's `member` or `sender` field changes that, such as `{ "field": "member", "oneOf": [true, false] }` for anyone.
- **Daily spend.** `dailySpend` is a cap in the currency of the server's price table, counted from the usage rows of the routine's or group's runs ([ADR 0066](0066-team-credentials-and-usage.md)). Reaching it pauses the routine or the group until the next day, and tells the owner. There is no cap unless one is set.
  - This changes ADR 0066 and ADR 0067 for routines only. They said budgets only warn and team routines get no cap beyond what routines already have. A cap that pauses is what keeps an unattended factory from spending all night. Team budgets still only warn, and this cap stops nothing but its routine or group.
  - Usage rows exist today only for team runs that go through the key proxy, so the cap works for team routines first. Counting personal runs is new work.
- **Running at once.** `maxRunning` caps runs across all of a routine's pieces of work. Others wait in turn, as today.
- **Pull requests.** A run whose work is a pull request is done when the required checks pass at its head. Until then, pull request watching keeps fixing CI and answering reviews. A piece of work with an open pull request doesn't start a second run, even after the first run ended. New events for it go to the Session that opened the pull request. This overrides `sameWork` ([ADR 0075](0075-routines-groups-coordinators-and-agents.md#a-routine-has-five-parts)).
- **Time.** `timeLimit` counts the time a run spends running, not waiting. Past it, the run's Session stops and the run is `failed`. A coordinator has no time limit.
- **Retries.** `retries` sets how many times a failed run, but not a blocked one, starts again, with a growing wait between tries. It is off unless set. A run and its retries count as one failure toward the rule that three failed runs in a row pause the routine.
- **Windows.** A trigger's `windows` limit when it may fire, such as weekdays from 09:00 to 18:00. `outside` is `wait`, which holds a firing for the next window, or `skip`, which drops it.
- **Expiry.** `stopAfter` is a date after which the routine pauses itself.

### Teams

- Anyone on the team can create team routines and run or pause any of them, as [ADR 0064](0064-one-team-per-server.md) and [ADR 0067](0067-team-plugins-projects-and-assistant.md#team-routines) have it (decided 2026-11-08).
- A team routine or group may set `editors`, a list of people who may change or remove it. Without it, anyone on the team may, as today.
- The plugin records who made each routine and who changed it last, which is new. The routine's page shows both, and its history lists every change.
- The board shows runs, outcomes, success rate and cost per routine and per group, from the usage rows.

### Trying a routine

These were agreed on 2026-11-08.

- **Replay.** Any past run's events can be fired again at the current version of the routine.
- **Dry run.** A run whose proposals are shown and never applied, and whose branch is never pushed. It still spends tokens.
- **Test on save.** The `routines` tool already runs a new routine once to test it, with no event. Saving any new event routine, from the page too, now runs it once on the newest matching event. That needs the plugin to keep recent events that fired nothing, which is new. If the routine uses allowed actions, that run is a dry run.

### Starting values

These are defaults. `questions.timeout`, a question, and a routine's or group's `limits` change the values they name. The retry waits and how long recent events are kept are fixed.

| What                                             | Value              |
| ------------------------------------------------ | ------------------ |
| Question timeout                                 | 24 hours           |
| `timeLimit`                                      | 2 hours            |
| Wait before retries                              | 1, then 10 minutes |
| `stopAfter` the form suggests for event routines | 90 days            |
| `dailySpend`                                     | none               |
| Recent events kept for test on save              | 7 days             |

## Consequences

- An unattended run can stop and ask, on the issue or Slack thread where the work started, without being lost.
- Text written by strangers can't make a run push or post anything the routine didn't list. Listed actions can need a person's approval.
- The routines plugin applies writes itself. It gains code that pushes branches and posts through each plugin's actions, and a run's workspace branch must be readable from the server.
- Waiting runs keep their Sessions, so a busy factory holds many idle Sessions. On Kubernetes their pods idle out and start again when an answer arrives.
- Caps pause routines, so a team can find a routine paused in the morning. The board says why.
- This depends on new work in other plugins:
  - `ask_user` ends a turn while it waits, and questions get timeouts;
  - git-hosts, Slack and email post questions back and route answers;
  - usage counts personal runs;
  - pull request watching accepts proposals.
