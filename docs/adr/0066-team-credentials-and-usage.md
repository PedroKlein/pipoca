# 0066: Team credentials and usage

- Status: accepted, direction only (built with Team Sessions)
- Date: 2026-11-04

## Context

[ADR 0054](0054-team-sessions.md#what-must-exist-before-team-sessions-are-built) asks for two things before Team Sessions are built: the team's credentials kept outside the Session, and a usage and audit record with team budgets and a cap per person.

Today a runner holds the model logins of the person whose Session it runs, refresh tokens included ([ADR 0045](0045-server-kept-logins.md)). An admin's API key on the base Profile reaches every runner too ([ADR 0063](0063-settings-and-first-run-setup.md)). That is safe while a runner serves one person ([ADR 0049](0049-personal-environments-and-templates.md)). In a team Session every user can steer Pi ([ADR 0064](0064-one-team-per-server.md)), so anyone could ask it to print a key it can read.

Git already works this way: a Session acting as a GitHub App gets a token that lasts an hour, narrowed to its repositories, and the App's private key never leaves the server ([ADR 0060](0060-technical-users-and-github-apps.md)).

Team credentials are API keys. Subscription sign-ins stay personal and never go on the base or a team Profile ([ADR 0063](0063-settings-and-first-run-setup.md#logins-on-profile-layers)).

## Decision

### A proxy on the server holds the team's keys

- Team Sessions reach model providers through a proxy on the server (decided 2026-11-04). The runner gets a token for its Session, never the key. The server checks the token, puts the real key in the header the provider expects and streams the request and the response through unchanged.
- The proxy translates nothing. It keeps a small table of how each provider takes its key, so adding a provider is one row.
- The Session host points each team provider at the proxy, with the Session's token in place of the key. Whether Pi lets a built-in provider's base URL be changed this way is checked first, in a spike.
- HTTP MCP servers with team logins go through the same proxy.
- Some credentials can't go through it yet: providers that extensions add, whose sign-in code runs where the extension loads, and MCP servers that run as local processes with secrets in their environment. Their keys still reach team runners, and Team setup marks each one as reaching the runner.
- Only team work uses the proxy for now (decided 2026-11-04). Personal Sessions keep their logins as ADR 0045 describes, since those reach only the person's own runner.

### One record of usage

- The proxy writes one row per model call: the owner, the person who asked and who it was on behalf of, the Session, the model, the credential, tokens in and out, and the cost.
- Cost is money, worked out from a price per model that admins edit in `pipoca.json` (decided 2026-11-04). A model with no price shows its tokens and no cost.
- Every use of a team credential and every kernel action on team work, such as a stop, an access change or a move to the team, goes in an audit log with its actor.

### Budgets warn

- Admins set a team budget for a period and a cap per person in team work.
- A budget or cap that reaches 80% and then 100% warns: the person, and admins, get a notice, and the hub shows it (decided 2026-11-04). Nothing stops at the limit.

### Who sees it

- Admins see every row of usage and the audit log, and can export them (decided 2026-11-04).
- A user sees their own spend and actions, and the team's totals on the hub.

## Consequences

- No team member or text Pi reads can copy a team model key from a runner, except for the credentials marked as reaching it.
- The server sits in the path of every team model call. A restart stops the team turns that are streaming, and the server carries their traffic.
- Spend is exact for team work, because every call passes through the proxy. Personal work isn't metered this way.
- Each provider reports usage in its own format, so the proxy needs a reader per provider to count tokens, and that reader is where most of its upkeep is.
- Prices change, and a stale table shows the wrong cost until an admin updates it.
- Since budgets only warn, a team routine that runs in a loop keeps spending until someone acts on the warning.
