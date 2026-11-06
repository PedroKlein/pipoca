# 0071: Team Sessions watch pull requests as the team's bot

- Status: accepted
- Date: 2026-11-06

## Context

[ADR 0051](0051-pull-request-watching.md) polls each watched pull request with the token of the person who started the Session. [ADR 0066](0066-team-credentials-and-usage.md) says a person's git accounts never serve team work, so team Sessions couldn't watch at all, and the team hub's Pull requests panel stayed empty.

Team work already signs git in as a bot: the technical user it acts as, or on each host the GitHub App or machine user an admin marked for team work ([ADR 0060](0060-technical-users-and-github-apps.md), #633).

## Decision

- Team Sessions can watch and stop watching pull requests, with the tools and with `/pr` (decided 2026-11-06).
- The poller polls a team Session's watch with the same bot team work's git signs in as on that host. It never uses the starter's personal token, even when they connected the host.
- A team Session can't watch a pull request on a host with no bot marked for team work. The refusal tells the admin to mark one in Settings > Git hosts. A watch whose bot is unmarked later shows the same message on its card.
- Merge on a team watch goes through the bot. Auto-fix starts on for every team watch, since a person's defaults don't apply to team work.
- "Reply on review threads as me" is ignored in team work: the rules always tell the Session to report in the chat and never comment on GitHub as a person.

## Consequences

- This amends ADR 0051's polling with the person's token: it holds for a person's Sessions only.
- A team watch still records its starter, since the watch table names a person, and only a team Session a person started can watch.
