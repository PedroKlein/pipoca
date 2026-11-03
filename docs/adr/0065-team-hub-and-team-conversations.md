# 0065: The team hub and team conversations

- Status: accepted, direction only (built after the rest of [ADR 0054](0054-team-sessions.md)'s prerequisites)
- Date: 2026-11-03

## Context

A server is one team, and team work gets a view of its own ([ADR 0064](0064-one-team-per-server.md)). Mockups of three directions were reviewed on 2026-11-03: a separate team area, a switcher between a person's space and the team's, and a team page inside a person's sidebar.

A team Session also has more than one person in it, and they need to talk to each other as well as to Pi. ADR 0054 already gives each Session one input queue, run by the kernel, where a message applies after the current step and any participant can stop the Session.

How other products handle this was researched before deciding ([research](../research.md#multiplayer-sessions)):

- Inside an agent's task thread, every reply reaches the agent (Claude Tag, Devin, Linear, Bolt). At a room's top level the agent answers only when mentioned. Letting the model decide when to speak is rare. ChatGPT group chats did, and OpenAI is retiring them. Models also do little better than chance at telling who a message is addressed to.
- When an agent is triggered, it reads the recent thread up to a cap, not a summary. When a thread outgrows that, products start a new one (Claude Tag `!fork`, Amp's handoff).
- A message the agent never sees is rare. Devin's `!aside` is the only per-message one found.
- No product has votes. The agent asks a question, the first answer wins, and the answer shows who gave it.
- Each message reaches the model with its speaker's name.

## Decision

### The team hub

- The team's view is a separate area with its own navigation, a team hub, apart from a person's own work (decided 2026-11-03). Its home shows what needs someone, what is running, recent activity, and panels that plugins add.
- A plugin says where it works: personal work, team work, or both (decided 2026-11-03). A plugin that says nothing is personal only, so a plugin written for one person never loads in team work unchecked. A team-only plugin, such as a board from an issue tracker, shows up only in the team hub and team Sessions. Admins choose which plugins that support team work are turned on there.
- The kernel guards its own records, such as Sessions, transcripts and credentials, by owner. A plugin's own tables are the plugin's to guard, so the SDK gives it the caller's owner and a check for whether a caller may see a person's or the team's records.

### People and Pi share one conversation

- The composer in a team Session has three targets (decided 2026-11-03):
  - **To Pi** sends the message to Pi's queue, as in any Session today.
  - **To the team** is for people. Pi doesn't answer it, but reads it the next time someone sends To Pi.
  - **Off the record** is seen by the team and never by Pi, now or in a summary. It's labelled "hidden from Pi, visible to the team".
- Typing `@pipoca` in a message switches it to To Pi. The composer always shows the current target, and a message to the team shows that Pi didn't answer it.
- If everyone keeps To Pi, a team Session works like a personal one with several people steering.
- When a message goes To Pi, Pi reads the team messages since its last turn, up to a cap. Past the cap, the Session offers to fork into a new one instead of compacting quietly. The cap is set when this is built.
- Every message reaches Pi with its author's name, and with the message it replies to.

### Replies

- A reply quotes the message it answers, in one flat timeline (decided 2026-11-03). Pi sees what each reply answers.
- Side threads that fold under a message, as in Slack, wait until teams show that the timeline gets hard to follow.

### Questions and votes

- Pi addresses each question to a named person, such as the starter or whoever asked for that part of the work (decided 2026-11-03). Anyone who can steer may answer instead, and the answer shows "answered for" that person. If nobody answers before a timeout, the question goes to the starter.
- Anyone can open a vote: Pi when the team should decide, or a person about something being discussed (decided 2026-11-03). A vote card shows who picked what. The person who opened it or the Session's starter closes it, or it closes on a timeout. The result is posted as a team message, so Pi reads it the next time it's asked. A vote that a person opens doesn't start Pi by itself.
- Questions and votes belong to the `ask` plugin, which works in team work.

## Consequences

- People can talk through a decision inside a team Session without starting Pi every time, and Pi still has the whole discussion when it's asked.
- Long human discussions cost tokens when Pi reads them. The cap and the fork keep that bounded, and off-the-record messages cost nothing.
- Someone can forget to switch to To Pi and wait for an answer that never comes. The visible target and the "Pi didn't answer" marker are there for that.
- A plugin author has to declare team support and guard their own records, and a plugin route that skips the check can still show team records to the wrong person.
- Votes can stall work while a team decides, which the timeout bounds.
